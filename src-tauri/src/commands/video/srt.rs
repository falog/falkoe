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
        let text = strip_whisper_special_tokens(seg.text.trim().to_string());
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
}
