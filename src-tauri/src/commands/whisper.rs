#![allow(dead_code)]

mod audio;
mod ffmpeg;
mod lang;
mod manifest;
mod mecab;
mod paths;
mod run;
mod transcribe;
mod transcript;
mod types;

pub use audio::load_wav_as_f32;
pub use manifest::SentenceManifest;
pub use run::{run_whisper, run_whisper_model, run_whisper_uploaded};
pub(crate) use run::{transcribe_in_subprocess_with_overrides, whisper_gpu_helper_available};
pub use transcribe::{transcribe, transcribe_preview, transcribe_segments_with_callbacks, transcribe_with_callbacks};
pub(crate) use transcribe::whisper_gpu_backend_available;
pub use types::{
    FinalResult, PartialSegment, PreviewResult, Segment, TokenTimestamp, Transcript, WordTimestamp,
};

// The following functions and structs are part of the public API
#[derive(serde::Serialize, Clone)]
pub struct PreviewResult {
    pub status: String, // "preview"
    pub text: String,
    pub score: f32,
}

#[derive(serde::Serialize, Clone)]
pub struct FinalResult {
    pub status: String,
    pub wav_path: String,
    pub segments: Vec<Segment>,
    pub score: f32,
}

// Additional structs and functions can be added here as needed.
#![allow(dead_code)]

use crate::model::{ensure_model, hash_sentence};

use anyhow::{bail, Result};
use hound;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{
    DtwMode, DtwModelPreset, FullParams, SamplingStrategy, WhisperContext,
    WhisperContextParameters,
};

#[derive(serde::Serialize, Clone)]
pub struct PreviewResult {
    pub status: String, // "preview"
    pub text: String,
    pub score: f32,
}

#[derive(serde::Serialize, Clone)]
pub struct FinalResult {
    pub status: String,
    pub wav_path: String,
    pub segments: Vec<Segment>,
    pub score: f32,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct Segment {
    pub start: f32,
    pub end: f32,
    pub text: String,
    // pub avg_logprob: Option<f32>,
    // pub compression_ratio: Option<f32>,
    // pub no_speech_prob: Option<f32>,
}

#[derive(serde::Serialize)]
pub struct Transcript {
    pub segments: Vec<Segment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Vec<TokenTimestamp>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<WordTimestamp>>,
}

#[derive(serde::Serialize, Clone)]
pub struct TokenTimestamp {
    pub start: f32,
    pub end: f32,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dtw: Option<f32>,
}

#[derive(serde::Serialize, Clone)]
pub struct WordTimestamp {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SentenceManifest {
    pub audio_id: String,
    pub sentence_id: Option<String>,
    pub lang: String,
    pub text: Option<String>,
    pub last_wav_path: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct PartialSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

fn whisper_language(lang: &str) -> Option<&'static str> {
    match lang {
        // Accept both ISO 639-3 codes (Tatoeba) and ISO 639-1-ish codes (Whisper).
        "eng" | "en" => Some("en"),
        "jpn" | "ja" => Some("ja"),
        "spa" | "es" => Some("es"),
        "fra" | "fr" => Some("fr"),
        "deu" | "de" => Some("de"),
        "ita" | "it" => Some("it"),
        "por" | "pt" => Some("pt"),
        "rus" | "ru" => Some("ru"),
        "kor" | "ko" => Some("ko"),
        // Chinese: UI may use ISO 639-3-ish variants (Tatoeba) like cmn/yue.
        "zho" | "zh" | "cmn" | "yue" => Some("zh"),
        "ara" | "ar" => Some("ar"),
        "hin" | "hi" => Some("hi"),
        "tur" | "tr" => Some("tr"),
        "vie" | "vi" => Some("vi"),
        "tha" | "th" => Some("th"),
        "ind" | "id" => Some("id"),
        "ukr" | "uk" => Some("uk"),
        "pol" | "pl" => Some("pl"),
        "nld" | "nl" => Some("nl"),
        "swe" | "sv" => Some("sv"),
        _ => None,
    }
}

fn resolve_bundled_tool(app: &AppHandle, base_name: &str) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let exe_name = if cfg!(target_os = "windows") {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    };

    let candidates = [
        // bundle layout
        resource_dir.join("bin").join(&exe_name),
        resource_dir.join(&exe_name),
        // dev layout (resources synced under target/*/resources)
        resource_dir.join("resources").join("bin").join(&exe_name),
        resource_dir.join("resources").join(&exe_name),
    ];

    candidates.into_iter().find(|p| p.is_file())
}

fn ffmpeg_convert_to_wav(app: &AppHandle, input: &Path, output_wav: &Path) -> Result<()> {
    let cmd = resolve_bundled_tool(app, "ffmpeg").unwrap_or_else(|| PathBuf::from("ffmpeg"));

    let status = Command::new(&cmd)
        .args([
            "-y",
            "-i",
            input
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("invalid input path"))?,
            "-ar",
            "16000",
            "-ac",
            "1",
            output_wav
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("invalid output path"))?,
        ])
        .status()?;

    if !status.success() {
        bail!("ffmpeg conversion failed (cmd={:?})", cmd);
    }

    Ok(())
}

fn sentence_audio_dir(app: &AppHandle, sentence_hash: &str, subdir: &str) -> Result<PathBuf> {
    let base_dir = sentence_base_dir(app, sentence_hash)?;
    Ok(base_dir.join(subdir))
}

fn run_whisper_for_wav(
    app: &AppHandle,
    wav_path: &str,
    sentence_hash: &str,
    lang: &str,
) -> Result<()> {
    println!("=== run_whisper START ===");
    println!("wav_path = {}", wav_path);

    let model_path = ensure_model(app)?;

    let transcript = transcribe(wav_path, &model_path, whisper_language(lang))?;
    save_transcript_json(wav_path, &transcript)?;

    let full_text = transcript
        .segments
        .iter()
        .map(|s| s.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    // Persist manifest early so the UI/History doesn't depend on pitch.
    save_sentence_manifest_json(app, sentence_hash, lang, &full_text, wav_path)?;

    // Emit final transcript early; pitch analysis can take longer or fail.
    let final_result = FinalResult {
        status: "final".into(),
        wav_path: wav_path.to_string(),
        segments: transcript.segments.clone(),
        score: 0.0,
    };

    app.emit("transcript-final", final_result)?;

    // Run pitch analysis and persist it next to the transcript.
    // Japanese-only: also write accent.json (Heiban/Odaka/Nakadaka/Atamadaka labels).
    let is_ja = whisper_language(lang) == Some("ja");
    if let Ok(mut pitch) = crate::commands::pitch::analyze_pitch(
        app.clone(),
        wav_path.to_string(),
        None,
        None,
        None,
        Some(true),
    ) {
        // For non-Japanese, avoid emitting Japanese pitch-accent category labels.
        if !is_ja {
            if let Some(words) = pitch.words.as_mut() {
                for w in words {
                    w.label = None;
                }
            }
            if let Some(segs) = pitch.segments.as_mut() {
                for s in segs {
                    s.label = None;
                }
            }
        }

            let pitch_path = Path::new(wav_path).with_extension("pitch.json");
            if let Ok(json) = serde_json::to_string_pretty(&pitch) {
                let _ = fs::write(&pitch_path, json);
                println!("saved pitch: {:?}", pitch_path);
            }

        if is_ja {
            // Also write a compact, human-friendly accent JSON.
            // The accent overlay keeps all tokens, but only assigns lexical pitch-accent labels to
            // content words (merged and labeled). Particles / sentence-final endings / polite
            // auxiliaries / punctuation are emitted with label = null and act as boundaries.
            #[derive(serde::Serialize)]
            struct AccentWordOut {
                word: String,
                start: f32,
                end: f32,
                text: String,
                label: Option<String>,
                peak_pos: Option<f32>,
                pitch_range: Option<f32>,
                slope: Option<f32>,
            }

            #[derive(serde::Serialize)]
            struct AccentOut {
                words: Vec<AccentWordOut>,
            }

            // Match the Python reference heuristics.
            fn estimate_accent_label_py(peak_pos: f32, pitch_range: f32) -> String {
                if pitch_range < 0.8 {
                    return "Heiban".to_string();
                }
                if peak_pos < 0.25 {
                    return "Atamadaka".to_string();
                }
                if (0.25..=0.6).contains(&peak_pos) {
                    return "Nakadaka".to_string();
                }
                "Odaka".to_string()
            }

            fn segment_features_py(seg: &[f32]) -> (f32, f32, f32) {
                let mut max_v = f32::NEG_INFINITY;
                let mut min_v = f32::INFINITY;
                let mut peak_i = 0usize;
                for (i, &v) in seg.iter().enumerate() {
                    if v > max_v {
                        // First index of the absolute maximum.
                        max_v = v;
                        peak_i = i;
                    }
                    if v < min_v {
                        min_v = v;
                    }
                }
                let pitch_range = max_v - min_v;
                let peak_pos = if seg.is_empty() {
                    0.0
                } else {
                    peak_i as f32 / seg.len().max(1) as f32
                };

                let mut slope_sum = 0.0f32;
                let mut slope_n = 0usize;
                for w in seg.windows(2) {
                    slope_sum += w[1] - w[0];
                    slope_n += 1;
                }
                let slope = if slope_n > 0 {
                    slope_sum / slope_n as f32
                } else {
                    0.0
                };

                (peak_pos, pitch_range, slope)
            }

            fn time_to_index_floor(t: f32, time_step: f32) -> usize {
                ((t / time_step.max(0.0001)).floor() as i64).max(0) as usize
            }

            fn time_to_index_ceil(t: f32, time_step: f32) -> usize {
                ((t / time_step.max(0.0001)).ceil() as i64).max(0) as usize
            }

            fn collect_voiced(f0_rel: &[Option<f32>], si: usize, ei: usize) -> Vec<f32> {
                f0_rel
                    .iter()
                    .skip(si)
                    .take(ei.saturating_sub(si))
                    .filter_map(|v| *v)
                    .collect()
            }

            fn is_punct_word(s: &str) -> bool {
                let t = s.trim();
                if t.is_empty() {
                    return false;
                }

                t.chars().all(is_punct_char)
            }

            fn is_punct_char(c: char) -> bool {
                c.is_ascii_punctuation()
                    || matches!(
                        c,
                        '。' | '、' | '！' | '？' | '…' | '・' | '「' | '」' | '『' | '』' | '（'
                            | '）' | '【' | '】' | '［' | '］' | '〔' | '〕' | '〈' | '〉' | '《'
                            | '》' | '“' | '”' | '‘' | '’' | '：' | '；'
                    )
            }

            fn apply_polite_odaka_rule(text: &str, label: Option<String>) -> Option<String> {
                let Some(l) = label else { return None };
                if l != "Odaka" {
                    return Some(l);
                }

                let trimmed = text.trim();
                let core = trimmed.trim_end_matches(|c: char| c.is_whitespace() || is_punct_char(c));
                if core.ends_with("ます") || core.ends_with("です") {
                    return Some("Nakadaka".to_string());
                }

                Some(l)
            }

            fn is_ja_label_excluded_token(s: &str) -> bool {
                matches!(
                    s.trim(),
                    "は"
                        | "が"
                        | "を"
                        | "に"
                        | "で"
                        | "と"
                        | "も"
                        | "へ"
                        | "から"
                        | "まで"
                        | "より"
                        | "の"
                        | "や"
                        | "よ"
                        | "ね"
                        | "な"
                        | "さ"
                        | "ぞ"
                        | "わ"
                        | "か"
                        | "だ"
                        | "です"
                        | "ます"
                        | "でした"
                        | "でしたら"
                )
            }

            fn split_trailing_tokens(s: &str) -> Vec<String> {
                // Split a token into [content?, excluded-suffixes..., punct...] while keeping order.
                // This helps cases like "暑いね。" -> ["暑い", "ね", "。"], "雨です" -> ["雨", "です"].
                let mut rest = s.trim().to_string();
                if rest.is_empty() {
                    return Vec::new();
                }

                // 1) peel trailing punctuation chars
                let mut trailing_punct: Vec<String> = Vec::new();
                loop {
                    let last = rest.chars().last();
                    let Some(ch) = last else { break };
                    let ch_s = ch.to_string();
                    if is_punct_word(&ch_s) {
                        rest.pop();
                        trailing_punct.push(ch_s);
                        continue;
                    }
                    break;
                }

                // 2) peel trailing excluded suffix tokens (longest-first)
                // NOTE: we intentionally do NOT split "ます" from verbs (e.g. "行きます")
                // because practical UX wants it as one word.
                let suffixes = [
                    "でしたら", "でした", "です", "から", "まで", "より", "よ", "ね", "な", "さ", "ぞ", "わ",
                    "か", "は", "が", "を", "に", "で", "と", "も", "へ", "の", "や", "だ",
                ];
                let mut trailing_suffix: Vec<String> = Vec::new();
                'outer: loop {
                    for suf in suffixes {
                        if rest == suf {
                            // whole token is excluded
                            rest.clear();
                            trailing_suffix.push(suf.to_string());
                            continue 'outer;
                        }
                        if rest.ends_with(suf) && rest.len() > suf.len() {
                            let new_len = rest.len() - suf.len();
                            rest.truncate(new_len);
                            trailing_suffix.push(suf.to_string());
                            continue 'outer;
                        }
                    }
                    break;
                }

                let mut out: Vec<String> = Vec::new();
                if !rest.trim().is_empty() {
                    out.push(rest.trim().to_string());
                }
                // suffixes were collected from the end; restore original order
                trailing_suffix.reverse();
                out.extend(trailing_suffix);
                trailing_punct.reverse();
                out.extend(trailing_punct);
                out
            }

            fn char_len(s: &str) -> usize {
                s.chars().count().max(1)
            }

            fn emit_token_with_time(
                pitch: &crate::commands::pitch::PitchAnalysis,
                text: &str,
                start: f32,
                end: f32,
            ) -> AccentWordOut {
                let t = text.trim();
                if t.is_empty() {
                    return AccentWordOut {
                        word: "".into(),
                        start,
                        end,
                        text: "".into(),
                        label: None,
                        peak_pos: None,
                        pitch_range: None,
                        slope: None,
                    };
                }

                // Excluded tokens and punctuation: keep, but label is null.
                if is_punct_word(t) || is_ja_label_excluded_token(t) {
                    return AccentWordOut {
                        word: t.to_string(),
                        start,
                        end,
                        text: t.to_string(),
                        label: None,
                        peak_pos: None,
                        pitch_range: None,
                        slope: None,
                    };
                }

                // Content word: compute label/features from pitch segment.
                let n = pitch.f0_rel.len();
                let time_step = pitch.time_step.max(0.001);
                let si0 = time_to_index_floor(start, time_step);
                let ei0 = time_to_index_ceil(end, time_step);
                let si = si0.min(n);
                let ei = ei0.min(n);
                let voiced = collect_voiced(&pitch.f0_rel, si, ei);
                let (label, peak_pos, pitch_range, slope) = if voiced.len() >= 3 {
                    let (pp, pr, sl) = segment_features_py(&voiced);
                    (
                        apply_polite_odaka_rule(t, Some(estimate_accent_label_py(pp, pr))),
                        Some(pp),
                        Some(pr),
                        Some(sl),
                    )
                } else {
                    (None, None, None, None)
                };

                AccentWordOut {
                    word: t.to_string(),
                    start,
                    end,
                    text: t.to_string(),
                    label,
                    peak_pos,
                    pitch_range,
                    slope,
                }
            }

            #[derive(Clone)]
            struct PendingContent {
                text: String,
                start: f32,
                end: f32,
            }

            fn flush_content_word(
                pitch: &crate::commands::pitch::PitchAnalysis,
                pending: &mut Option<PendingContent>,
                out_words: &mut Vec<AccentWordOut>,
            ) {
                let Some(w) = pending.take() else {
                    return;
                };

                let n = pitch.f0_rel.len();
                let time_step = pitch.time_step.max(0.001);
                let si0 = time_to_index_floor(w.start, time_step);
                let ei0 = time_to_index_ceil(w.end, time_step);
                let si = si0.min(n);
                let ei = ei0.min(n);
                let voiced = collect_voiced(&pitch.f0_rel, si, ei);

                let (label, peak_pos, pitch_range, slope) = if voiced.len() >= 3 {
                    let (pp, pr, sl) = segment_features_py(&voiced);
                    (
                        apply_polite_odaka_rule(&w.text, Some(estimate_accent_label_py(pp, pr))),
                        Some(pp),
                        Some(pr),
                        Some(sl),
                    )
                } else {
                    (None, None, None, None)
                };

                out_words.push(AccentWordOut {
                    word: w.text.clone(),
                    start: w.start,
                    end: w.end,
                    text: w.text,
                    label,
                    peak_pos,
                    pitch_range,
                    slope,
                });
            }

            let mut out_words: Vec<AccentWordOut> = Vec::new();

            // Prefer transcript word boundaries when available (prevents "明日行きます" from
            // merging into one). Fall back to pitch.words if needed.
            if let Some(t_words) = transcript.words.as_ref() {
                // Japanese tokenization helper input (avoid inserting spaces between segments).
                let mecab_text_ja = transcript
                    .segments
                    .iter()
                    .map(|s| s.text.trim())
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<_>>()
                    .join("");

                // If MeCab is available, use it to re-tokenize Japanese text and align tokens
                // back onto the Whisper word timestamps.
                let mecab_wordlikes = t_words
                    .iter()
                    .map(|w| crate::commands::whisper::mecab::WordLike {
                        start: w.start,
                        end: w.end,
                        text: w.text.clone(),
                    })
                    .collect::<Vec<_>>();

                if let Some(mecab_tokens) = crate::commands::whisper::mecab::mecab_timed_tokens(
                    &mecab_text_ja,
                    &mecab_wordlikes,
                ) {
                    for t in mecab_tokens {
                        let s = t.text.trim();
                        if s.is_empty() {
                            continue;
                        }
                        if t.is_excluded {
                            out_words.push(AccentWordOut {
                                word: s.to_string(),
                                start: t.start,
                                end: t.end,
                                text: s.to_string(),
                                label: None,
                                peak_pos: None,
                                pitch_range: None,
                                slope: None,
                            });
                        } else {
                            let out = emit_token_with_time(&pitch, s, t.start, t.end);
                            if !out.word.is_empty() {
                                out_words.push(out);
                            }
                        }
                    }
                } else {
                for w in t_words {
                    let raw = w.text.trim();
                    if raw.is_empty() {
                        continue;
                    }
                    let parts = split_trailing_tokens(raw);
                    if parts.is_empty() {
                        continue;
                    }
                    let total = parts.iter().map(|p| char_len(p)).sum::<usize>() as f32;
                    let mut cur = w.start;
                    let dur = (w.end - w.start).max(0.0);
                    for (i, p) in parts.iter().enumerate() {
                        let frac = char_len(p) as f32 / total.max(1.0);
                        let next = if i + 1 == parts.len() {
                            w.end
                        } else {
                            cur + dur * frac
                        };
                        let out = emit_token_with_time(&pitch, p, cur, next);
                        if !out.word.is_empty() {
                            out_words.push(out);
                        }
                        cur = next;
                    }
                }
                }
            } else if let Some(words) = &pitch.words {
                // Fallback: pitch.words can be per-character; merge contiguous content until a
                // boundary (excluded token or punctuation).
                let mut pending: Option<PendingContent> = None;
                for w in words {
                    let t = w.text.trim();
                    if t.is_empty() {
                        continue;
                    }

                    if is_punct_word(t) || is_ja_label_excluded_token(t) {
                        flush_content_word(&pitch, &mut pending, &mut out_words);
                        out_words.push(AccentWordOut {
                            word: t.to_string(),
                            start: w.start,
                            end: w.end,
                            text: t.to_string(),
                            label: None,
                            peak_pos: None,
                            pitch_range: None,
                            slope: None,
                        });
                        continue;
                    }

                    match pending.as_mut() {
                        Some(p) => {
                            p.text.push_str(t);
                            p.end = w.end;
                        }
                        None => {
                            pending = Some(PendingContent {
                                text: t.to_string(),
                                start: w.start,
                                end: w.end,
                            });
                        }
                    }
                }
                flush_content_word(&pitch, &mut pending, &mut out_words);
            }

            let accent_path = Path::new(wav_path).with_extension("accent.json");
            if let Ok(json) = serde_json::to_string_pretty(&AccentOut { words: out_words }) {
                let _ = fs::write(&accent_path, json);
                println!("saved accent: {:?}", accent_path);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn run_whisper_model(
    app: AppHandle,
    url: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    let wav_path = download_and_convert_to_wav(&app, &url, &sentence_hash)?;

    std::thread::spawn(move || {
        if let Err(e) = run_whisper_for_wav(&app, &wav_path, &sentence_hash, &lang) {
            eprintln!("whisper model error: {e}");
        }
    });

    Ok(())
}

#[tauri::command]
pub fn run_whisper_uploaded(
    app: AppHandle,
    uploaded_path: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    let wav_path = convert_uploaded_to_wav(&app, &uploaded_path, &sentence_hash)?;

    std::thread::spawn(move || {
        if let Err(e) = run_whisper_for_wav(&app, &wav_path, &sentence_hash, &lang) {
            eprintln!("whisper uploaded error: {e}");
        }
    });

    Ok(())
}

fn convert_uploaded_to_wav(
    app: &AppHandle,
    uploaded_path: &str,
    sentence_hash: &str,
) -> Result<String, String> {
    (|| -> Result<String> {
        let base_dir = sentence_audio_dir(app, sentence_hash, "uploaded")?;
        fs::create_dir_all(&base_dir)?;

        let wav_path = base_dir.join("uploaded.wav");
        ffmpeg_convert_to_wav(app, Path::new(uploaded_path), &wav_path)?;
        Ok(wav_path.to_string_lossy().to_string())
    })()
    .map_err(|e| e.to_string())
}

fn download_and_convert_to_wav(
    app: &AppHandle,
    url: &str,
    sentence_hash: &str,
) -> Result<String, String> {
    (|| -> Result<String> {
        let base_dir = sentence_audio_dir(app, sentence_hash, "model")?;
        fs::create_dir_all(&base_dir)?;

        let mp3_path = base_dir.join("model.mp3");
        let wav_path = base_dir.join("model.wav");

        // For tatoeba/model URLs we download to model.mp3 first.
        // But when opening from history (recorded source), the "url" can be a local file path.
        // In that case, convert the local file directly.
        if url.starts_with("http://") || url.starts_with("https://") {
            let resp = reqwest::blocking::get(url)?;
            let bytes = resp.bytes()?;
            fs::write(&mp3_path, &bytes)?;
            ffmpeg_convert_to_wav(app, &mp3_path, &wav_path)?;
        } else {
            ffmpeg_convert_to_wav(app, Path::new(url), &wav_path)?;
        }

        Ok(wav_path.to_string_lossy().to_string())
    })()
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn run_whisper(
    app: AppHandle,
    path: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    let app_handle = app.clone();

    std::thread::spawn(move || {
        if let Err(e) = run_whisper_for_wav(&app_handle, &path, &sentence_hash, &lang) {
            eprintln!("whisper error: {e}");
        }
    });

    Ok(())
}

fn append_segment_json(wav_path: &str, seg: &Segment) -> Result<()> {
    let json_path = Path::new(wav_path).with_extension("jsonl");

    let line = serde_json::to_string(seg)?;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(json_path)?
        .write_all(format!("{}\n", line).as_bytes())?;

    Ok(())
}

fn get_tiny_ctx(model_path: &str) -> Result<&'static Mutex<WhisperContext>> {
    Ok(TINY_CTX.get_or_init(|| {
        let mut params = WhisperContextParameters::default();
        // If built with a GPU backend, prefer using it.
        // (If the system doesn't provide a usable GPU/loader, whisper.cpp falls back to CPU.)
        #[cfg(any(feature = "whisper-vulkan", feature = "whisper-metal"))]
        {
            params.use_gpu = true;
        }
        let ctx = WhisperContext::new_with_params(model_path, params)
            .expect("failed to load whisper model");
        Mutex::new(ctx)
    }))
}

/*
fn quick_score(recognized: &str, expected: u64) -> f32 {
    let r = recognized.to_lowercase();
    let e = expected.to_lowercase();

    let r_words: Vec<_> = r.split_whitespace().collect();
    let e_words: Vec<_> = e.split_whitespace().collect();

    let matched = r_words
        .iter()
        .filter(|w| e_words.contains(w))
        .count();

    matched as f32 / e_words.len().max(1) as f32 * 100.0
}
*/

pub fn transcribe_preview(
    app: &AppHandle,
    wav_path: &str,
    _sentence_id: u64,
) -> Result<PreviewResult> {
    let audio = load_wav_as_f32(wav_path)?;

    // tiny / fast model想定
    let text = fast_transcribe(app, &audio)?; // rwhisper 等

    // let expected_text = load_expected_sentence(sentence_id)?;
    // let score = quick_score(&full_text, &expected_text);
    let score = 0.0;

    Ok(PreviewResult {
        status: "preview".into(),
        text,
        score,
    })
}

fn split_audio(audio: &[f32], chunk_sec: f32) -> Vec<Vec<f32>> {
    let chunk_samples = (16_000.0 * chunk_sec) as usize;
    audio.chunks(chunk_samples).map(|c| c.to_vec()).collect()
}

static TINY_CTX: OnceLock<Mutex<WhisperContext>> = OnceLock::new();

fn fast_transcribe(app: &AppHandle, audio: &[f32]) -> Result<String> {
    let model_path = ensure_model(app)?; // tiny を返すようにしてもOK

    let ctx_mutex = get_tiny_ctx(model_path.to_str().unwrap())?;
    let ctx = ctx_mutex.lock().unwrap();

    let mut state = ctx.create_state()?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_progress(false);
    params.set_translate(false);

    state.full(params, audio)?;

    let text = state
        .as_iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join(" ");

    Ok(text.trim().to_string())
}

fn transcribe_streaming(app: &AppHandle, wav_path: &str) -> Result<Vec<Segment>> {
    let audio = load_wav_as_f32(wav_path)?;
    let chunks = split_audio(&audio, 1.0); // 1秒刻み

    let model_path = ensure_model(app)?;
    let ctx_mutex = get_tiny_ctx(model_path.to_str().unwrap())?;
    let ctx = ctx_mutex.lock().unwrap();

    let mut all_segments = Vec::new();
    let mut time_offset = 0.0;

    for chunk in chunks {
        let mut state = ctx.create_state()?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_print_progress(false);

        state.full(params, &chunk)?;

        for s in state.as_iter() {
            let text = s.to_string().trim().to_string();

            if text.is_empty() {
                continue;
            }
            if (text.starts_with('(') && text.ends_with(')'))
                || (text.starts_with('[') && text.ends_with(']'))
                || text == "[BLANK_AUDIO]"
            {
                continue;
            }
            let seg = Segment {
                start: time_offset + s.start_timestamp() as f32 / 100.0,
                end: time_offset + s.end_timestamp() as f32 / 100.0,
                text: text.clone(),
            };

            let _ = app.emit("transcript-partial", &seg);

            append_segment_json(wav_path, &seg)?;

            all_segments.push(seg);
        }

        time_offset += chunk.len() as f32 / 16_000.0;
    }

    Ok(all_segments)
}

/*
fn transcribe(wav_path: &str, model_path: &Path) -> Result<Transcript> {
    println!("loading wav...");
    let mut audio = load_wav_as_f32(wav_path)?;

const MIN_SAMPLES: usize = 16_000 / 5; // 200ms

if audio.len() < MIN_SAMPLES {
    audio.resize(MIN_SAMPLES, 0.0);
}

    println!("loading whisper model...");
    let ctx = WhisperContext::new_with_params(
        model_path.to_str().unwrap(),
        WhisperContextParameters::default(),
    )?;

    let mut state = ctx.create_state()?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_progress(false);

    println!("running whisper...");
    state.full(params, &audio)?;

    let segments: Vec<Segment> = state
    .as_iter()
    .filter_map(|s| {
        let mut text = s.to_string();

        // 非言語トークン除去
        if text.starts_with('(') && text.ends_with(')') {
            return None;
        }
        if text.starts_with('[') && text.ends_with(']') {
            return None;
        }

        text = text.trim().to_string();
        if text.is_empty() || text == "[BLANK_AUDIO]" {
            return None;
        }

        Some(Segment {
        start: s.start_timestamp() as f32 / 100.0,
        end: s.end_timestamp() as f32 / 100.0,
        text,

       // avg_logprob: None,
       // compression_ratio: None,
       // no_speech_prob: Some(s.no_speech_probability()),
    })

    })
    .collect();



    println!("segments = {}", segments.len());

    Ok(Transcript { segments })
}
*/
pub fn transcribe(
    wav_path: &str,
    model_path: &Path,
    whisper_lang: Option<&str>,
) -> Result<Transcript> {
    let audio = load_wav_as_f32(wav_path)?;

    println!("before WhisperContext::new_with_params");
    let mut ctx_params = WhisperContextParameters::default();

    // If built with a GPU backend, prefer using it.
    // (If the system doesn't provide a usable GPU/loader, whisper.cpp falls back to CPU.)
    #[cfg(any(feature = "whisper-vulkan", feature = "whisper-metal"))]
    {
        ctx_params.use_gpu = true;
    }

    // Falkoe downloads ggml-small.bin, so use the Small preset.
    ctx_params.dtw_parameters.mode = DtwMode::ModelPreset {
        model_preset: DtwModelPreset::Small,
    };

    let ctx = WhisperContext::new_with_params(model_path.to_str().unwrap(), ctx_params)?;
    println!("after WhisperContext::new_with_params");
    let mut state = ctx.create_state()?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

    // Avoid starving the UI thread: leave a couple of cores free.
    // (This is especially important in Tauri because the WebView shares the same process.)
    let n_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let n_threads = n_threads.saturating_sub(2).max(1).min(8);
    params.set_n_threads(n_threads as i32);

    println!("set_language {:?}", whisper_lang);
    println!("model_path = {:?}", model_path);
    params.set_language(whisper_lang);
    params.set_translate(false);

    // Token-level timestamps.
    params.set_token_timestamps(true);
    // Prefer word-ish splitting only for whitespace-separated languages.
    params.set_split_on_word(matches!(whisper_lang, Some("en")));

    // ❌ streaming / chunk 系は一切使わない
    // params.set_single_segment(false);
    // params.set_split_on_word(false);

    // ★ full は state に対して呼ぶ
    state.full(params, &audio)?;

    let mut segments: Vec<Segment> = Vec::new();
    let mut tokens: Vec<TokenTimestamp> = Vec::new();
    let mut token_bytes: Vec<(f32, f32, Vec<u8>)> = Vec::new();
    let mut prev_end_for_ja: Option<f32> = None;

    for s in state.as_iter() {
        let text = strip_whisper_special_tokens(&s.to_string())
            .trim()
            .to_string();

        if text.is_empty()
            || text == "[BLANK_AUDIO]"
            || (text.starts_with('(') && text.ends_with(')'))
            || (text.starts_with('[') && text.ends_with(']'))
        {
            continue;
        }

        segments.push(Segment {
            start: s.start_timestamp() as f32 / 100.0,
            end: s.end_timestamp() as f32 / 100.0,
            text,
        });

        let token_count = s.n_tokens();
        for token_idx in 0..token_count {
            let Some(tok) = s.get_token(token_idx) else {
                continue;
            };

            // Use raw bytes because Whisper may split tokens away from UTF-8 boundaries (common in JA).
            // `to_str_lossy` would show "�" for such fragments.
            let bytes = match tok.to_bytes() {
                Ok(b) => b,
                Err(_) => continue,
            };
            let token_text = std::str::from_utf8(bytes)
                .map(|s| s.to_string())
                .unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned());

            // Skip whisper timestamp pseudo tokens if they show up.
            if token_text.starts_with("<|") && token_text.ends_with("|>") {
                continue;
            }

            // Skip Whisper special tokens like "[_TT_100]"/"[_BEG_]" anywhere.
            if is_nonling_text(&token_text) {
                continue;
            }

            if token_text.trim().is_empty() {
                continue;
            }

            let td = tok.token_data();
            // Some tokens (often trailing punctuation/last words in JA) can have zero-length
            // timestamps. Dropping them makes the UI miss text like "何？". Keep them and
            // synthesize a small duration when needed.
            let raw_start = td.t0 as f32 / 100.0;
            let raw_end = if td.t1 > td.t0 {
                td.t1 as f32 / 100.0
            } else {
                raw_start
            };
            let raw_dur = (raw_end - raw_start).max(0.0);

            // DTW-assisted alignment:
            // For JA, token timestamps often include leading silence.
            // If DTW time is available, treat it as a better-aligned token boundary.
            // We build continuous boundaries using prev token's DTW end when possible.
            let dtw = if td.t_dtw > 0 {
                Some(td.t_dtw as f32 / 100.0)
            } else {
                None
            };

            let (start, end) = if matches!(whisper_lang, Some("ja")) {
                if let Some(dtw_end) = dtw {
                    // Cap duration to avoid leading-silence skew; tuned to match the Python reference.
                    let capped_dur = raw_dur.clamp(0.04, 0.30);
                    let start = match prev_end_for_ja {
                        Some(prev) if prev <= dtw_end => prev,
                        // For the first token, raw duration can be unrealistically short.
                        // Apply a small minimum so starts don't jump too late.
                        _ => (dtw_end - capped_dur.max(0.25)).max(0.0),
                    };
                    let end = dtw_end.max(start);
                    prev_end_for_ja = Some(end);
                    (start, end)
                } else {
                    // fallback to raw timestamps
                    prev_end_for_ja = Some(raw_end);
                    (raw_start, raw_end)
                }
            } else {
                (raw_start, raw_end)
            };

            // Ensure a minimal non-zero duration so later word/segment slicing works.
            let (start, end) = if end <= start {
                (start, start + 0.04)
            } else {
                (start, end)
            };

            if matches!(whisper_lang, Some("ja")) {
                prev_end_for_ja = Some(end);
            }

            tokens.push(TokenTimestamp {
                start,
                end,
                text: token_text,
                dtw,
            });

            token_bytes.push((start, end, bytes.to_vec()));
        }
    }

    let words = if matches!(whisper_lang, Some("ja")) {
        build_words_from_token_bytes(&token_bytes)
    } else {
        build_words_from_tokens(&tokens)
    };

    Ok(Transcript {
        segments,
        tokens: Some(tokens),
        words: Some(words),
    })
}

fn strip_whisper_special_tokens(s: &str) -> String {
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

fn is_nonling_text(s: &str) -> bool {
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

fn build_words_from_token_bytes(tokens: &[(f32, f32, Vec<u8>)]) -> Vec<WordTimestamp> {
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

fn build_words_from_tokens(tokens: &[TokenTimestamp]) -> Vec<WordTimestamp> {
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

fn save_transcript_json(wav_path: &str, transcript: &Transcript) -> Result<()> {
    let json_path = Path::new(wav_path).with_extension("json");
    let json = serde_json::to_string_pretty(transcript)?;
    fs::write(&json_path, json)?;
    println!("saved transcript: {:?}", json_path);
    Ok(())
}

fn sentence_base_dir(app: &AppHandle, sentence_hash: &str) -> Result<PathBuf> {
    Ok(app
        .path()
        .document_dir()?
        .join("falkoe")
        .join("sentences")
        .join(sentence_hash))
}

fn save_sentence_manifest_json(
    app: &AppHandle,
    sentence_hash: &str,
    lang: &str,
    full_text: &str,
    wav_path: &str,
) -> Result<()> {
    let base_dir = sentence_base_dir(app, sentence_hash)?;
    fs::create_dir_all(&base_dir)?;
    let manifest_path = base_dir.join("manifest.json");

    // Important: do not overwrite manifest.text with recognition results.
    // The UI sets/locks the sentence text via upsert_sentence_manifest_text.
    // Here we only update last_wav_path, and we fill text/sentence_id only if missing.
    let mut manifest: SentenceManifest = if manifest_path.exists() {
        match fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|s| serde_json::from_str::<SentenceManifest>(&s).ok())
        {
            Some(v) => v,
            None => SentenceManifest {
                audio_id: sentence_hash.to_string(),
                sentence_id: None,
                lang: lang.to_string(),
                text: None,
                last_wav_path: None,
            },
        }
    } else {
        SentenceManifest {
            audio_id: sentence_hash.to_string(),
            sentence_id: None,
            lang: lang.to_string(),
            text: None,
            last_wav_path: None,
        }
    };

    manifest.audio_id = sentence_hash.to_string();
    manifest.lang = lang.to_string();
    manifest.last_wav_path = Some(wav_path.to_string());

    let existing_text_nonempty = manifest
        .text
        .as_deref()
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);

    if !existing_text_nonempty {
        let recognized_text = full_text.trim();
        if !recognized_text.is_empty() {
            manifest.text = Some(recognized_text.to_string());
            manifest.sentence_id = Some(hash_sentence(recognized_text, lang));
        }
    }

    if manifest.sentence_id.is_none() {
        if let Some(t) = manifest.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            manifest.sentence_id = Some(hash_sentence(t, lang));
        }
    }

    let json = serde_json::to_string_pretty(&manifest)?;
    fs::write(&manifest_path, json)?;
    println!("saved manifest: {:?}", manifest_path);
    Ok(())
}

pub fn load_wav_as_f32(path: &str) -> Result<Vec<f32>> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();

    // ---------- read & mono ----------
    let mono: Vec<f32> = match (spec.channels, spec.sample_format) {
        (1, hound::SampleFormat::Int) => reader
            .samples::<i16>()
            .map(|s| Ok(s? as f32 / i16::MAX as f32))
            .collect::<Result<Vec<f32>>>()?,

        (1, hound::SampleFormat::Float) => reader
            .samples::<f32>()
            .map(|s| s.map_err(anyhow::Error::from))
            .collect::<Result<Vec<f32>>>()?,

        (2, hound::SampleFormat::Int) => {
            let mut out = Vec::new();
            let mut it = reader.samples::<i16>();
            while let (Some(l), Some(r)) = (it.next(), it.next()) {
                out.push((l? as f32 + r? as f32) * 0.5 / i16::MAX as f32);
            }
            out
        }

        (2, hound::SampleFormat::Float) => {
            let mut out = Vec::new();
            let mut it = reader.samples::<f32>();
            while let (Some(l), Some(r)) = (it.next(), it.next()) {
                out.push((l? + r?) * 0.5);
            }
            out
        }

        _ => bail!("unsupported wav format"),
    };

    // ---------- sanity check ----------
    println!(
        "wav: {} ch, {} Hz, samples={}, sec={:.2}",
        spec.channels,
        spec.sample_rate,
        mono.len(),
        mono.len() as f32 / spec.sample_rate as f32
    );

    // ---------- already 16k ----------
    if spec.sample_rate == 16_000 {
        return Ok(mono);
    }

    // ---------- resample (SAFE VERSION) ----------
    let ratio = 16_000.0 / spec.sample_rate as f64;

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let mut resampler = SincFixedIn::<f32>::new(ratio, 1.0, params, mono.len(), 1)?;

    let input = vec![mono];
    let output = resampler.process(&input, None)?;

    Ok(output[0].clone())
}
