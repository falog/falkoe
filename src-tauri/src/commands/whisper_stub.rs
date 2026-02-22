#![allow(dead_code)]
#![allow(unused_imports)]

use anyhow::{bail, Context, Result};
use std::fs;
use std::path::Path;
use std::panic::{catch_unwind, AssertUnwindSafe};
use tauri::{AppHandle, Emitter, Manager};

#[path = "whisper/lang.rs"]
mod lang;
#[path = "whisper/manifest.rs"]
mod manifest;
#[path = "whisper/mecab.rs"]
mod mecab;
#[path = "whisper/mecab_native.rs"]
mod mecab_native;
#[path = "whisper/paths.rs"]
mod paths;
#[path = "whisper/types.rs"]
mod types;

pub use manifest::{SentenceAttribution, SentenceManifest};
pub use types::{
    FinalResult, PartialSegment, PreviewResult, Segment, TokenTimestamp, Transcript, WordTimestamp,
};

pub(crate) use lang::whisper_language;

use manifest::save_sentence_manifest_json;
use paths::sentence_audio_dir;

// ---------------------------------------------------------------------------
// Remote Whisper API (used on Android / builds without local whisper)
// ---------------------------------------------------------------------------

const REMOTE_WHISPER_API_URL: &str = "https://recog.falkoe.net/";

/// Response shape from the remote Whisper API.
#[derive(serde::Deserialize, Debug)]
struct RemoteApiResponse {
    raw: RemoteApiRaw,
}

#[derive(serde::Deserialize, Debug)]
struct RemoteApiRaw {
    text: String,
    #[serde(default)]
    word_count: usize,
    #[serde(default)]
    words: Vec<RemoteApiWord>,
}

#[derive(serde::Deserialize, Debug)]
struct RemoteApiWord {
    word: String,
    start: f32,
    end: f32,
}

/// Convert the remote API response into our internal `Transcript` type.
fn api_response_to_transcript(resp: &RemoteApiResponse) -> Transcript {
    let raw = &resp.raw;
    let text = raw.text.trim().to_string();

    // Build a single segment spanning the entire utterance.
    let seg_start = raw.words.first().map(|w| w.start).unwrap_or(0.0);
    let seg_end = raw.words.last().map(|w| w.end).unwrap_or(0.0);

    let segments = vec![Segment {
        start: seg_start,
        end: seg_end,
        text: text.clone(),
    }];

    let words = if raw.words.is_empty() {
        None
    } else {
        Some(
            raw.words
                .iter()
                .map(|w| WordTimestamp {
                    start: w.start,
                    end: w.end,
                    text: w.word.clone(),
                })
                .collect::<Vec<_>>(),
        )
    };

    Transcript {
        segments,
        tokens: None,
        words,
    }
}

/// Send audio bytes to the remote Whisper API and return a `Transcript`.
fn call_remote_whisper_api(audio_bytes: &[u8], lang: Option<&str>) -> Result<Transcript> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()?;

    let mut url = reqwest::Url::parse(REMOTE_WHISPER_API_URL)
        .context("invalid remote whisper API URL")?;
    if let Some(l) = lang {
        url.query_pairs_mut().append_pair("lang", l);
    }

    let response = client
        .post(url)
        .header("content-type", "audio/wav")
        .body(audio_bytes.to_vec())
        .send()
        .context("failed to call remote whisper API")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        bail!(
            "remote whisper API returned HTTP {}: {}",
            status,
            body.chars().take(500).collect::<String>()
        );
    }

    let api_resp: RemoteApiResponse = response
        .json()
        .context("failed to parse remote whisper API response")?;

    Ok(api_response_to_transcript(&api_resp))
}

/// Save a `Transcript` as JSON next to the WAV file.
fn save_transcript_json(wav_path: &str, transcript: &Transcript) -> Result<()> {
    let json_path = Path::new(wav_path).with_extension("json");
    let json = serde_json::to_string_pretty(transcript)?;
    fs::write(&json_path, json)?;
    Ok(())
}

/// Core: read audio, call remote API, save transcript, emit events.
fn run_whisper_for_wav(
    app: &AppHandle,
    wav_path: &str,
    sentence_hash: &str,
    lang: &str,
) -> Result<()> {
    crate::logging::log_line(
        app,
        format!(
            "[whisper-remote] start wav_path={} sentence_hash={} lang={}",
            wav_path, sentence_hash, lang
        ),
    );

    let audio_bytes = fs::read(wav_path)
        .with_context(|| format!("failed to read audio file: {}", wav_path))?;

    crate::logging::log_line(
        app,
        format!(
            "[whisper-remote] sending {} bytes to remote API",
            audio_bytes.len()
        ),
    );

    let whisper_lang = whisper_language(lang);
    let transcript = match call_remote_whisper_api(&audio_bytes, whisper_lang) {
        Ok(t) => {
            crate::logging::log_line(
                app,
                format!(
                    "[whisper-remote] ok segments={} words={}",
                    t.segments.len(),
                    t.words.as_ref().map(|w| w.len()).unwrap_or(0)
                ),
            );
            t
        }
        Err(e) => {
            crate::logging::log_line(
                app,
                format!("[whisper-remote] error: {e}"),
            );
            // Return an empty transcript so the UI at least completes.
            Transcript {
                segments: Vec::new(),
                tokens: None,
                words: None,
            }
        }
    };

    save_transcript_json(wav_path, &transcript)?;
    crate::logging::log_line(app, "[whisper-remote] save_transcript_json: ok");

    let full_text = transcript
        .segments
        .iter()
        .map(|s| s.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    save_sentence_manifest_json(app, sentence_hash, lang, &full_text, wav_path)?;

    let final_result = FinalResult {
        status: "final".into(),
        wav_path: wav_path.to_string(),
        segments: transcript.segments.clone(),
        score: 0.0,
    };

    app.emit("transcript-final", final_result)?;
    crate::logging::log_line(app, "[whisper-remote] emitted transcript-final");

    // --- Post-transcription: pitch analysis + accent JSON (mirrors whisper/run.rs) ---
    run_pitch_and_accent(app, wav_path, lang, &transcript);

    Ok(())
}

// ---------------------------------------------------------------------------
// Post-transcription: pitch analysis + Japanese accent labeling
// ---------------------------------------------------------------------------

fn run_pitch_and_accent(
    app: &AppHandle,
    wav_path: &str,
    lang: &str,
    transcript: &Transcript,
) {
    let is_ja = whisper_language(lang) == Some("ja");
    crate::logging::log_line(app, "[pitch] analyze_pitch: begin");

    let pitch_res = catch_unwind(AssertUnwindSafe(|| {
        crate::commands::pitch::analyze_pitch(
            app.clone(),
            wav_path.to_string(),
            None,
            None,
            None,
            Some(true),
        )
    }));

    let pitch_ok = match pitch_res {
        Ok(Ok(p)) => Ok(p),
        Ok(Err(e)) => Err(e),
        Err(payload) => {
            let msg = crate::logging::panic_payload_to_string(&*payload);
            crate::logging::log_line(
                app,
                format!("[pitch] panic in analyze_pitch (caught): {msg}"),
            );
            return;
        }
    };

    match pitch_ok {
        Ok(mut pitch) => {
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
                crate::logging::log_line(
                    app,
                    format!("[pitch] saved pitch: {:?}", pitch_path),
                );
            }

            if is_ja {
                generate_accent_json(app, wav_path, &pitch, transcript);
            }
        }
        Err(e) => {
            crate::logging::log_line(
                app,
                format!("[pitch] analyze_pitch: error: {e}"),
            );
        }
    }
}

// --- Accent JSON generation (Japanese) ---

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

fn is_punct_char(c: char) -> bool {
    c.is_ascii_punctuation()
        || matches!(
            c,
            '。' | '、' | '！' | '？' | '…' | '・' | '「' | '」' | '『' | '』' | '（'
                | '）' | '【' | '】' | '［' | '］' | '〔' | '〕' | '〈' | '〉' | '《'
                | '》' | '\u{201c}' | '\u{201d}' | '\u{2018}' | '\u{2019}' | '：' | '；'
        )
}

fn is_punct_word(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.chars().all(is_punct_char)
}

fn is_ja_label_excluded_token(s: &str) -> bool {
    matches!(
        s.trim(),
        "は" | "が" | "を" | "に" | "で" | "と" | "も" | "へ"
            | "から" | "まで" | "より"
            | "よ" | "ね" | "な" | "さ" | "ぞ" | "わ" | "か"
            | "だ" | "です" | "ます" | "でした" | "でしたら"
    )
}

fn apply_polite_odaka_rule(text: &str, label: Option<String>) -> Option<String> {
    let Some(l) = label else { return None };
    if l != "Odaka" {
        return Some(l);
    }
    let core = text.trim().trim_end_matches(|c: char| c.is_whitespace() || is_punct_char(c));
    if core.ends_with("ます") || core.ends_with("です") {
        return Some("Nakadaka".to_string());
    }
    Some(l)
}

fn split_trailing_tokens(s: &str) -> Vec<String> {
    let mut rest = s.trim().to_string();
    if rest.is_empty() {
        return Vec::new();
    }
    let mut trailing_punct: Vec<String> = Vec::new();
    loop {
        let Some(ch) = rest.chars().last() else { break };
        let ch_s = ch.to_string();
        if is_punct_word(&ch_s) {
            rest.pop();
            trailing_punct.push(ch_s);
            continue;
        }
        break;
    }
    let suffixes = [
        "でしたら", "でした", "です", "から", "まで", "より", "よ", "ね", "な", "さ", "ぞ",
        "わ", "か", "は", "が", "を", "に", "で", "と", "も", "へ", "の", "や", "だ",
    ];
    let mut trailing_suffix: Vec<String> = Vec::new();
    'outer: loop {
        for suf in suffixes {
            if rest == suf {
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
            word: "".into(), start, end, text: "".into(),
            label: None, peak_pos: None, pitch_range: None, slope: None,
        };
    }
    if is_punct_word(t) || is_ja_label_excluded_token(t) {
        return AccentWordOut {
            word: t.to_string(), start, end, text: t.to_string(),
            label: None, peak_pos: None, pitch_range: None, slope: None,
        };
    }
    let n = pitch.f0_rel.len();
    let ts = pitch.time_step.max(0.001);
    let si = time_to_index_floor(start, ts).min(n);
    let ei = time_to_index_ceil(end, ts).min(n);
    let voiced = collect_voiced(&pitch.f0_rel, si, ei);
    let (label, peak_pos, pitch_range, slope) = if voiced.len() >= 3 {
        let (pp, pr, sl) = segment_features_py(&voiced);
        (
            apply_polite_odaka_rule(t, Some(estimate_accent_label_py(pp, pr))),
            Some(pp), Some(pr), Some(sl),
        )
    } else {
        (None, None, None, None)
    };
    AccentWordOut {
        word: t.to_string(), start, end, text: t.to_string(),
        label, peak_pos, pitch_range, slope,
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
    let Some(w) = pending.take() else { return };
    let n = pitch.f0_rel.len();
    let ts = pitch.time_step.max(0.001);
    let si = time_to_index_floor(w.start, ts).min(n);
    let ei = time_to_index_ceil(w.end, ts).min(n);
    let voiced = collect_voiced(&pitch.f0_rel, si, ei);
    let (label, peak_pos, pitch_range, slope) = if voiced.len() >= 3 {
        let (pp, pr, sl) = segment_features_py(&voiced);
        (
            apply_polite_odaka_rule(&w.text, Some(estimate_accent_label_py(pp, pr))),
            Some(pp), Some(pr), Some(sl),
        )
    } else {
        (None, None, None, None)
    };
    out_words.push(AccentWordOut {
        word: w.text.clone(), start: w.start, end: w.end, text: w.text,
        label, peak_pos, pitch_range, slope,
    });
}

fn generate_accent_json(
    app: &AppHandle,
    wav_path: &str,
    pitch: &crate::commands::pitch::PitchAnalysis,
    transcript: &Transcript,
) {
    // Build MeCab input text from word timestamps (or segments as fallback).
    let mecab_text_ja = if let Some(t_words) = transcript.words.as_ref() {
        t_words
            .iter()
            .map(|w| w.text.chars().filter(|c| !c.is_whitespace()).collect::<String>())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("")
    } else {
        transcript
            .segments
            .iter()
            .map(|s| s.text.chars().filter(|c| !c.is_whitespace()).collect::<String>())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("")
    };

    let mut out_words: Vec<AccentWordOut> = Vec::new();
    let mut used_mecab = false;

    let mecab_wordlikes: Option<(Vec<mecab::WordLike>, &'static str)> =
        if let Some(t_words) = transcript.words.as_ref() {
            Some((
                t_words
                    .iter()
                    .map(|w| mecab::WordLike {
                        start: w.start,
                        end: w.end,
                        text: w.text.clone(),
                    })
                    .collect(),
                "words",
            ))
        } else if !transcript.segments.is_empty() {
            Some((
                transcript
                    .segments
                    .iter()
                    .map(|s| mecab::WordLike {
                        start: s.start,
                        end: s.end,
                        text: s.text.clone(),
                    })
                    .collect(),
                "segments",
            ))
        } else {
            None
        };

    if let Some((ref wordlikes, src)) = mecab_wordlikes {
        if let Some(mecab_tokens) =
            mecab::mecab_timed_tokens_with_app(app, &mecab_text_ja, wordlikes)
        {
            used_mecab = true;
            crate::logging::log_line(
                app,
                format!("[mecab] used tokens={} src={}", mecab_tokens.len(), src),
            );
            for t in mecab_tokens {
                let s = t.text.trim();
                if s.is_empty() {
                    continue;
                }
                if t.is_excluded {
                    out_words.push(AccentWordOut {
                        word: s.to_string(), start: t.start, end: t.end, text: s.to_string(),
                        label: None, peak_pos: None, pitch_range: None, slope: None,
                    });
                } else {
                    let out = emit_token_with_time(pitch, s, t.start, t.end);
                    if !out.word.is_empty() {
                        out_words.push(out);
                    }
                }
            }
        } else {
            crate::logging::log_line(app, "[mecab] not used");
        }
    }

    if !used_mecab {
        if let Some(t_words) = transcript.words.as_ref() {
            crate::logging::log_line(app, "[mecab] fallback to word boundaries");
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
                    let next = if i + 1 == parts.len() { w.end } else { cur + dur * frac };
                    let out = emit_token_with_time(pitch, p, cur, next);
                    if !out.word.is_empty() {
                        out_words.push(out);
                    }
                    cur = next;
                }
            }
        } else if let Some(words) = &pitch.words {
            let mut pending: Option<PendingContent> = None;
            for w in words {
                let t = w.text.trim();
                if t.is_empty() {
                    continue;
                }
                if is_punct_word(t) || is_ja_label_excluded_token(t) {
                    flush_content_word(pitch, &mut pending, &mut out_words);
                    out_words.push(AccentWordOut {
                        word: t.to_string(), start: w.start, end: w.end, text: t.to_string(),
                        label: None, peak_pos: None, pitch_range: None, slope: None,
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
            flush_content_word(pitch, &mut pending, &mut out_words);
        }
    }

    let accent_path = Path::new(wav_path).with_extension("accent.json");
    if let Ok(json) = serde_json::to_string_pretty(&AccentOut { words: out_words }) {
        let _ = fs::write(&accent_path, json);
        crate::logging::log_line(app, format!("[accent] saved accent: {:?}", accent_path));
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn run_whisper_model(
    app: tauri::AppHandle,
    url: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    // Download the audio from the URL, then transcribe via remote API.
    let wav_path = download_to_local(&app, &url, &sentence_hash)
        .map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let res = catch_unwind(AssertUnwindSafe(|| {
            run_whisper_for_wav(&app, &wav_path, &sentence_hash, &lang)
        }));
        match res {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                crate::logging::log_line(&app, format!("[whisper-remote] model error: {e}"));
            }
            Err(payload) => {
                let msg = crate::logging::panic_payload_to_string(&*payload);
                crate::logging::log_line(
                    &app,
                    format!("[whisper-remote] model panic (caught): {msg}"),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn run_whisper_uploaded(
    app: tauri::AppHandle,
    uploaded_path: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    // Copy/prepare the uploaded file, then transcribe via remote API.
    let wav_path = prepare_uploaded(&app, &uploaded_path, &sentence_hash)
        .map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let res = catch_unwind(AssertUnwindSafe(|| {
            run_whisper_for_wav(&app, &wav_path, &sentence_hash, &lang)
        }));
        match res {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                crate::logging::log_line(&app, format!("[whisper-remote] uploaded error: {e}"));
            }
            Err(payload) => {
                let msg = crate::logging::panic_payload_to_string(&*payload);
                crate::logging::log_line(
                    &app,
                    format!("[whisper-remote] uploaded panic (caught): {msg}"),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn run_whisper(
    app: tauri::AppHandle,
    path: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let res = catch_unwind(AssertUnwindSafe(|| {
            run_whisper_for_wav(&app_handle, &path, &sentence_hash, &lang)
        }));
        match res {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                crate::logging::log_line(&app_handle, format!("[whisper-remote] error: {e}"));
            }
            Err(payload) => {
                let msg = crate::logging::panic_payload_to_string(&*payload);
                crate::logging::log_line(
                    &app_handle,
                    format!("[whisper-remote] panic (caught): {msg}"),
                );
            }
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers for preparing audio files
// ---------------------------------------------------------------------------

/// Convert any audio file to 16 kHz mono WAV using the bundled ffmpeg.
/// Returns Ok(true) if conversion succeeded, Ok(false) if ffmpeg unavailable.
fn ffmpeg_convert_to_wav(app: &AppHandle, input: &Path, output_wav: &Path) -> Result<bool> {
    let args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input.to_string_lossy().to_string(),
        "-ar".into(),
        "16000".into(),
        "-ac".into(),
        "1".into(),
        output_wav.to_string_lossy().to_string(),
    ];
    match crate::commands::video::run_ffmpeg_raw(app, &args) {
        Ok(()) => Ok(true),
        Err(e) => {
            let msg = format!("{e}");
            if msg.contains("not found") {
                crate::logging::log_line(app, "[ffmpeg] ffmpeg not found, skipping conversion");
                Ok(false)
            } else {
                Err(e)
            }
        }
    }
}

/// Download audio from a URL (model audio) and save locally.
fn download_to_local(app: &AppHandle, url: &str, sentence_hash: &str) -> Result<String> {
    let base_dir = sentence_audio_dir(app, sentence_hash, "model")?;
    fs::create_dir_all(&base_dir)?;

    let wav_path = base_dir.join("model.wav");

    // Download to a temp file first (may be MP3, OGG, etc.).
    let raw_path = base_dir.join("model_raw");

    if url.starts_with("http://") || url.starts_with("https://") {
        let resp = reqwest::blocking::get(url)?;
        let bytes = resp.bytes()?;
        fs::write(&raw_path, &bytes)?;
    } else {
        // Local file path (e.g. from history).
        let src = Path::new(url);
        if src.exists() {
            fs::copy(src, &raw_path)?;
        } else {
            bail!("source audio not found: {}", url);
        }
    }

    // Convert to proper 16 kHz mono WAV via ffmpeg.
    match ffmpeg_convert_to_wav(app, &raw_path, &wav_path) {
        Ok(true) => {
            // Conversion succeeded; remove temp file.
            let _ = fs::remove_file(&raw_path);
        }
        Ok(false) => {
            // ffmpeg not available; use raw file as-is (may fail pitch analysis).
            crate::logging::log_line(app, "[download] ffmpeg unavailable, using raw audio");
            fs::rename(&raw_path, &wav_path)?;
        }
        Err(e) => {
            // Conversion failed; fall back to raw file.
            crate::logging::log_line(
                app,
                format!("[download] ffmpeg conversion failed: {e}, using raw audio"),
            );
            fs::rename(&raw_path, &wav_path)?;
        }
    }

    Ok(wav_path.to_string_lossy().to_string())
}

/// Prepare an uploaded audio file for transcription.
fn prepare_uploaded(app: &AppHandle, uploaded_path: &str, sentence_hash: &str) -> Result<String> {
    let base_dir = sentence_audio_dir(app, sentence_hash, "uploaded")?;
    fs::create_dir_all(&base_dir)?;

    let wav_path = base_dir.join("uploaded.wav");
    let input_path = Path::new(uploaded_path);

    // If already the same file, just return.
    let same_path = if wav_path.exists() {
        match (input_path.canonicalize(), wav_path.canonicalize()) {
            (Ok(a), Ok(b)) => a == b,
            _ => input_path == wav_path.as_path(),
        }
    } else {
        input_path == wav_path.as_path()
    };

    if same_path {
        if wav_path.exists() {
            return Ok(wav_path.to_string_lossy().to_string());
        }
        bail!(
            "uploaded_path points to output wav but it does not exist: {}",
            uploaded_path
        );
    }

    // Convert to 16 kHz mono WAV via ffmpeg (handles MP3, OGG, M4A, etc.).
    match ffmpeg_convert_to_wav(app, input_path, &wav_path) {
        Ok(true) => {
            // Conversion succeeded.
        }
        Ok(false) | Err(_) => {
            // ffmpeg unavailable or failed; just copy as-is.
            fs::copy(input_path, &wav_path)?;
        }
    }

    Ok(wav_path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Stubs for functions that desktop code may reference but are not needed here.
// ---------------------------------------------------------------------------

pub fn transcribe(
    _wav_path: &str,
    _model_path: &Path,
    _whisper_lang: Option<&str>,
) -> Result<Transcript> {
    anyhow::bail!("local whisper is not available; use remote API commands instead")
}

pub fn transcribe_preview(
    _app: &tauri::AppHandle,
    _wav_path: &str,
    _sentence_id: u64,
) -> Result<PreviewResult> {
    anyhow::bail!("local whisper is not available; use remote API commands instead")
}
