use crate::model::ensure_model;

use anyhow::Result;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use whisper_rs::{
    DtwMode, DtwModelPreset, FullParams, SamplingStrategy, WhisperContext,
    WhisperContextParameters,
};

use super::audio::load_wav_as_f32;
use super::transcript::{
    append_segment_json, build_words_from_token_bytes, build_words_from_tokens, is_nonling_text,
    strip_whisper_special_tokens,
};
use super::types::{PreviewResult, Segment, TokenTimestamp, Transcript, WordTimestamp};

static TINY_CTX: OnceLock<Mutex<WhisperContext>> = OnceLock::new();

fn get_tiny_ctx(model_path: &str) -> Result<&'static Mutex<WhisperContext>> {
    Ok(TINY_CTX.get_or_init(|| {
        let params = WhisperContextParameters::default();
        let ctx = WhisperContext::new_with_params(model_path, params)
            .expect("failed to load whisper model");
        Mutex::new(ctx)
    }))
}

pub fn transcribe_preview(app: &AppHandle, wav_path: &str, _sentence_id: u64) -> Result<PreviewResult> {
    let audio = load_wav_as_f32(wav_path)?;

    // tiny / fast model想定
    let text = fast_transcribe(app, &audio)?;

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

fn fast_transcribe(app: &AppHandle, audio: &[f32]) -> Result<String> {
    let model_path = ensure_model(app)?;

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

#[allow(dead_code)]
fn transcribe_streaming(app: &AppHandle, wav_path: &str) -> Result<Vec<Segment>> {
    let audio = load_wav_as_f32(wav_path)?;
    let chunks = split_audio(&audio, 1.0);

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

pub fn transcribe(wav_path: &str, model_path: &Path, whisper_lang: Option<&str>) -> Result<Transcript> {
    let audio = load_wav_as_f32(wav_path)?;

    println!("before WhisperContext::new_with_params");
    let mut ctx_params = WhisperContextParameters::default();
    // Falkoe downloads ggml-small.bin, so use the Small preset.
    ctx_params.dtw_parameters.mode = DtwMode::ModelPreset {
        model_preset: DtwModelPreset::Small,
    };

    let ctx = WhisperContext::new_with_params(model_path.to_str().unwrap(), ctx_params)?;
    println!("after WhisperContext::new_with_params");
    let mut state = ctx.create_state()?;

    // Match OpenAI whisper-python default behavior more closely:
    // temperature=0 => beam search (beam_size=5).
    // This tends to improve timestamps/segmentation on short utterances vs greedy.
    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: -1.0,
    });

    println!("set_language {:?}", whisper_lang);
    println!("model_path = {:?}", model_path);
    params.set_language(whisper_lang);
    params.set_translate(false);
    params.set_temperature(0.0);

    // Token-level timestamps.
    params.set_token_timestamps(true);
    // Prefer word-ish splitting only for whitespace-separated languages.
    params.set_split_on_word(matches!(whisper_lang, Some("en")));

    state.full(params, &audio)?;

    let mut segments: Vec<Segment> = Vec::new();
    let mut tokens: Vec<TokenTimestamp> = Vec::new();
    let mut token_bytes: Vec<(f32, f32, Vec<u8>)> = Vec::new();
    let mut prev_end_for_ja: Option<f32> = None;

    for s in state.as_iter() {
        let text = strip_whisper_special_tokens(&s.to_string()).trim().to_string();

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

            if is_nonling_text(&token_text) {
                continue;
            }

            if token_text.trim().is_empty() {
                continue;
            }

            let td = tok.token_data();
            let raw_start = td.t0 as f32 / 100.0;
            let raw_end = if td.t1 > td.t0 {
                td.t1 as f32 / 100.0
            } else {
                raw_start
            };
            let raw_dur = (raw_end - raw_start).max(0.0);

            let dtw = if td.t_dtw > 0 {
                Some(td.t_dtw as f32 / 100.0)
            } else {
                None
            };

            let (start, end) = if matches!(whisper_lang, Some("ja")) {
                if let Some(dtw_end) = dtw {
                    let capped_dur = raw_dur.clamp(0.04, 0.30);
                    let start = match prev_end_for_ja {
                        Some(prev) if prev <= dtw_end => prev,
                        _ => (dtw_end - capped_dur.max(0.25)).max(0.0),
                    };
                    let end = dtw_end.max(start);
                    prev_end_for_ja = Some(end);
                    (start, end)
                } else {
                    prev_end_for_ja = Some(raw_end);
                    (raw_start, raw_end)
                }
            } else {
                (raw_start, raw_end)
            };

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

    let words: Vec<WordTimestamp> = if matches!(whisper_lang, Some("ja")) {
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
