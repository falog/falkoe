use anyhow::{Context, Result};
use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Deserialize)]
struct TranscriptJson {
    segments: Vec<TranscriptSegment>,
}

#[derive(Deserialize)]
struct TranscriptSegment {
    start: f32,
    end: f32,
    text: String,
}

fn is_break_char(ch: char) -> bool {
    // Prefer breaking at whitespace and common punctuation (JP/EN).
    ch.is_whitespace()
        || matches!(
            ch,
            '、' | '。' | '，' | ',' | '．' | '.' | '！' | '!' | '？' | '?' | '：' | ':' | '；'
                | ';' | '）' | ')' | '】' | ']' | '」' | '』' | '”' | '"'
        )
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

fn split_at_char_boundary(s: &str, char_pos: usize) -> (&str, &str) {
    if char_pos == 0 {
        return ("", s);
    }
    let mut idx = s.len();
    for (i, (b, _)) in s.char_indices().enumerate() {
        if i == char_pos {
            idx = b;
            break;
        }
    }
    (&s[..idx], &s[idx..])
}

fn wrap_srt_text(text: &str, max_chars_per_line: usize, max_lines: usize) -> String {
    let mut rest = text.trim();
    if rest.is_empty() {
        return String::new();
    }

    let mut lines: Vec<String> = Vec::new();
    while !rest.is_empty() {
        let n = char_len(rest);
        if n <= max_chars_per_line {
            lines.push(rest.to_string());
            break;
        }

        // Take the first max_chars_per_line chars, then backtrack to a break char.
        let (head, _) = split_at_char_boundary(rest, max_chars_per_line);
        let mut break_at: Option<usize> = None;
        for (i, ch) in head.chars().enumerate() {
            if is_break_char(ch) && i > 0 {
                // Keep the last possible break within the head.
                break_at = Some(i + 1);
            }
        }
        let split_pos = break_at.unwrap_or(max_chars_per_line);
        let (a, b) = split_at_char_boundary(rest, split_pos);
        let a = a.trim();
        if !a.is_empty() {
            lines.push(a.to_string());
        }
        rest = b.trim_start();
        if lines.len() >= max_lines {
            if !rest.is_empty() {
                // Put the remainder on the last line (still better than truncation).
                if let Some(last) = lines.last_mut() {
                    if !last.ends_with(' ') {
                        last.push(' ');
                    }
                    last.push_str(rest);
                }
            }
            break;
        }
    }

    lines.join("\n")
}

fn strip_whisper_special_tokens(mut s: String) -> String {
    // Remove occurrences like "[_TT_100]" or "[_BEG_]".
    loop {
        let Some(i) = s.find("[_") else { break };
        let Some(j) = s[i..].find(']') else { break };
        let end = i + j + 1;
        s.replace_range(i..end, "");
    }
    s
}

fn srt_ts(t: f32) -> String {
    let t = t.max(0.0);
    let total_ms = (t * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

pub(crate) fn generate_srt(transcript_path: &Path, srt_path: &Path) -> Result<()> {
    let txt = fs::read_to_string(transcript_path)
        .with_context(|| format!("failed to read transcript: {transcript_path:?}"))?;
    let t: TranscriptJson = serde_json::from_str(&txt)
        .with_context(|| format!("failed to parse transcript: {transcript_path:?}"))?;

    let mut out = String::new();
    for (idx, seg) in t.segments.iter().enumerate() {
        let text0 = strip_whisper_special_tokens(seg.text.trim().to_string());
        // Wrap long lines to avoid horizontal clipping in video subtitles.
        // 750px width with ~26-28px font fits ~24 JP chars comfortably.
        let text = wrap_srt_text(&text0, 24, 3);
        if text.trim().is_empty() {
            continue;
        }
        out.push_str(&(idx + 1).to_string());
        out.push('\n');
        out.push_str(&format!("{} --> {}\n", srt_ts(seg.start), srt_ts(seg.end)));
        out.push_str(text.trim());
        out.push_str("\n\n");
    }

    fs::write(srt_path, out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_whisper_special_tokens_removes_all_occurrences() {
        assert_eq!(
            strip_whisper_special_tokens("[_TT_100]hello[_BEG_] world".to_string()),
            "hello world"
        );
    }

    #[test]
    fn srt_ts_formats() {
        assert_eq!(srt_ts(0.0), "00:00:00,000");
        assert_eq!(srt_ts(1.234), "00:00:01,234");
        assert_eq!(srt_ts(61.0), "00:01:01,000");
    }

    #[test]
    fn wrap_srt_text_wraps_long_lines() {
        let s = "この意見に、宇宙人たちは、パチパチと、それぞれすべての手で拍手して賛成した。";
        let wrapped = wrap_srt_text(s, 12, 3);
        assert!(wrapped.contains('\n'));
        for line in wrapped.split('\n') {
            assert!(char_len(line) <= 30);
        }
    }
}
