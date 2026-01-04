use anyhow::Result;
use std::fs;
use std::io::Write;
use std::path::Path;

use super::types::{Segment, TokenTimestamp, Transcript, WordTimestamp};

pub(crate) fn append_segment_json(wav_path: &str, seg: &Segment) -> Result<()> {
    let json_path = Path::new(wav_path).with_extension("jsonl");

    let line = serde_json::to_string(seg)?;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(json_path)?
        .write_all(format!("{}\n", line).as_bytes())?;

    Ok(())
}

pub(crate) fn save_transcript_json(wav_path: &str, transcript: &Transcript) -> Result<()> {
    let json_path = Path::new(wav_path).with_extension("json");
    let json = serde_json::to_string_pretty(transcript)?;
    fs::write(&json_path, json)?;
    println!("saved transcript: {:?}", json_path);
    Ok(())
}

pub(crate) fn strip_whisper_special_tokens(s: &str) -> String {
    // Remove inline Whisper special tokens like "[_TT_100]" or "[_BEG_]".
    // These sometimes appear concatenated with real text (e.g. "[_TT_100]こんにちは").
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        // Detect "[_".
        if bytes[i] == b'[' && i + 1 < bytes.len() && bytes[i + 1] == b'_' {
            // Skip until the next ']'. If none, stop stripping and keep the rest.
            if let Some(rel_end) = bytes[i + 2..].iter().position(|&c| c == b']') {
                i = i + 2 + rel_end + 1;
                continue;
            }
        }

        // Copy one UTF-8 char.
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

pub(crate) fn is_nonling_text(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return true;
    }
    // Whisper special tokens like "[_BEG_]", "[_TT_100]", "[_EOT_]".
    if t.starts_with("[_") && t.ends_with("]") {
        return true;
    }
    // Non-verbal markers.
    if (t.starts_with('(') && t.ends_with(')')) || (t.starts_with('[') && t.ends_with(']')) {
        return true;
    }
    false
}

pub(crate) fn build_words_from_token_bytes(tokens: &[(f32, f32, Vec<u8>)]) -> Vec<WordTimestamp> {
    let mut words: Vec<WordTimestamp> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut cur_start: Option<f32> = None;
    let mut cur_end: Option<f32> = None;

    let flush = |words: &mut Vec<WordTimestamp>,
                 buf: &mut Vec<u8>,
                 cur_start: &mut Option<f32>,
                 cur_end: &mut Option<f32>| {
        if buf.is_empty() {
            *cur_start = None;
            *cur_end = None;
            return;
        }

        let text = match std::str::from_utf8(buf) {
            Ok(s) => s.trim().to_string(),
            Err(_) => String::from_utf8_lossy(buf).trim().to_string(),
        };

        if text.is_empty() {
            buf.clear();
            *cur_start = None;
            *cur_end = None;
            return;
        }

        if is_nonling_text(&text) {
            buf.clear();
            *cur_start = None;
            *cur_end = None;
            return;
        }

        let (Some(start), Some(end)) = (*cur_start, *cur_end) else {
            buf.clear();
            *cur_start = None;
            *cur_end = None;
            return;
        };

        words.push(WordTimestamp { start, end, text });

        buf.clear();
        *cur_start = None;
        *cur_end = None;
    };

    for (start, end, b) in tokens {
        let starts_with_space = b
            .first()
            .copied()
            .map(|c| (c as char).is_whitespace())
            .unwrap_or(false);
        let has_newline = b.contains(&b'\n');

        if starts_with_space || has_newline {
            flush(&mut words, &mut buf, &mut cur_start, &mut cur_end);
        }

        if cur_start.is_none() {
            cur_start = Some(*start);
        }
        cur_end = Some(*end);

        buf.extend_from_slice(b);

        // For JA, flush at every UTF-8 boundary so we don't emit invalid fragments.
        if std::str::from_utf8(&buf).is_ok() {
            flush(&mut words, &mut buf, &mut cur_start, &mut cur_end);
        }
    }

    flush(&mut words, &mut buf, &mut cur_start, &mut cur_end);
    words
}

pub(crate) fn build_words_from_tokens(tokens: &[TokenTimestamp]) -> Vec<WordTimestamp> {
    let mut words: Vec<WordTimestamp> = Vec::new();

    let mut cur_text = String::new();
    let mut cur_start: Option<f32> = None;
    let mut cur_end: Option<f32> = None;

    let flush = |words: &mut Vec<WordTimestamp>,
                 cur_text: &mut String,
                 cur_start: &mut Option<f32>,
                 cur_end: &mut Option<f32>| {
        if cur_text.trim().is_empty() {
            cur_text.clear();
            *cur_start = None;
            *cur_end = None;
            return;
        }

        let (Some(start), Some(end)) = (*cur_start, *cur_end) else {
            cur_text.clear();
            *cur_start = None;
            *cur_end = None;
            return;
        };

        let text = cur_text.trim().to_string();
        if !is_nonling_text(&text) {
            words.push(WordTimestamp { start, end, text });
        }

        cur_text.clear();
        *cur_start = None;
        *cur_end = None;
    };

    for tok in tokens {
        let t = tok.text.as_str();
        let starts_with_space = t
            .chars()
            .next()
            .map(|c| c.is_whitespace())
            .unwrap_or(false);
        let has_newline = t.contains('\n');

        if starts_with_space || has_newline {
            flush(&mut words, &mut cur_text, &mut cur_start, &mut cur_end);
        }

        if cur_start.is_none() {
            cur_start = Some(tok.start);
        }
        cur_end = Some(tok.end);
        cur_text.push_str(t);
    }

    flush(&mut words, &mut cur_text, &mut cur_start, &mut cur_end);

    // If everything got grouped into one big chunk (common for languages without spaces),
    // fall back to per-token words so we still get useful alignment points.
    if words.len() <= 1 && tokens.len() > 1 {
        return tokens
            .iter()
            .filter_map(|t| {
                let text = t.text.trim();
                if text.is_empty() {
                    return None;
                }
                if is_nonling_text(text) {
                    return None;
                }
                Some(WordTimestamp {
                    start: t.start,
                    end: t.end,
                    text: text.to_string(),
                })
            })
            .collect();
    }

    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_whisper_special_tokens_strips_inline_tokens() {
        assert_eq!(
            strip_whisper_special_tokens("[_TT_100]こんにちは"),
            "こんにちは"
        );
        assert_eq!(
            strip_whisper_special_tokens("a[_BEG_]b"),
            "ab"
        );
    }

    #[test]
    fn is_nonling_text_detects_markers() {
        assert!(is_nonling_text(""));
        assert!(is_nonling_text("[_BEG_]"));
        assert!(is_nonling_text("(noise)"));
        assert!(is_nonling_text("[BLANK_AUDIO]"));
        assert!(!is_nonling_text("hello"));
    }
}
