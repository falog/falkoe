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
static MAIN_CTX: OnceLock<Mutex<Option<CachedWhisperContext>>> = OnceLock::new();
static WARNED_GPU_BACKEND_UNAVAILABLE: OnceLock<()> = OnceLock::new();

struct CachedWhisperContext {
    key: String,
    ctx: WhisperContext,
}

fn env_bool(key: &str) -> Option<bool> {
    let value = std::env::var(key).ok()?;
    let value = value.trim().to_ascii_lowercase();
    match value.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn env_usize(key: &str) -> Option<usize> {
    let value = std::env::var(key).ok()?;
    value.trim().parse::<usize>().ok()
}

pub(crate) fn whisper_gpu_backend_available() -> bool {
    // whisper-rs exposes a single `use_gpu` flag. For Vulkan builds, this default can remain
    // false even though a GPU backend is available (ggml_vulkan), which would incorrectly
    // disable GPU usage and cause massive slowdowns.
    if cfg!(any(feature = "whisper-vulkan", feature = "whisper-metal")) {
        return true;
    }

    WhisperContextParameters::default().use_gpu
}

fn env_use_gpu() -> Option<bool> {
    env_bool("FALKOE_WHISPER_USE_GPU")
}

fn env_segments_only() -> bool {
    env_bool("FALKOE_WHISPER_SEGMENTS_ONLY").unwrap_or(false)
}

fn whisper_use_gpu() -> bool {
    let requested = env_use_gpu();
    let available = whisper_gpu_backend_available();

    match requested {
        Some(true) if !available => {
            // If the binary wasn't compiled with a GPU backend, don't pretend we can use it.
            WARNED_GPU_BACKEND_UNAVAILABLE.get_or_init(|| {
                log::warn!(
                    "FALKOE_WHISPER_USE_GPU=1 was requested but this build has no GPU backend; falling back to CPU"
                );
            });
            false
        }
        Some(v) => v,
        None => available,
    }
}

fn whisper_gpu_device() -> i32 {
    env_usize("FALKOE_WHISPER_GPU_DEVICE")
        .unwrap_or(0)
        .clamp(0, i32::MAX as usize) as i32
}

pub(crate) fn whisper_n_threads() -> i32 {
    // override example: FALKOE_WHISPER_THREADS=8
    if let Some(n) = env_usize("FALKOE_WHISPER_THREADS") {
        // Too many threads can increase per-thread scratch memory and cause
        // whisper.cpp encoder failures on some systems.
        return (n.clamp(1, 64)) as i32;
    }

    // Default: leave a couple of cores free (Tauri UI shares the same process)
    // and cap to a reasonable number to avoid excessive memory use.
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let n = n.saturating_sub(2).max(1).min(8);
    n as i32
}

fn should_enable_dtw(whisper_lang: Option<&str>) -> bool {
    // override examples:
    // - FALKOE_WHISPER_DTW=0 (disable)
    // - FALKOE_WHISPER_DTW=1 (force enable)
    if let Some(v) = env_bool("FALKOE_WHISPER_DTW") {
        return v;
    }

    // DTW is expensive; keep it on by default only where we rely on it most.
    // We also enable it for English because we render per-word alignment overlays
    // and timestamp drift is noticeable even for short recordings.
    matches!(whisper_lang, Some("ja") | Some("en"))
}

fn dtw_preset_for_model_path(model_path: &Path) -> Option<DtwModelPreset> {
    let name = model_path
        .file_name()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    if name.contains("tiny") {
        // Includes ggml-tiny-q8_0.bin
        return Some(DtwModelPreset::Tiny);
    }
    if name.contains("base") {
        return Some(DtwModelPreset::Base);
    }
    if name.contains("small") {
        return Some(DtwModelPreset::Small);
    }

    if name.contains("medium") {
        return Some(DtwModelPreset::Medium);
    }

    if name.contains("large-v3-turbo") {
        return Some(DtwModelPreset::LargeV3Turbo);
    }

    if name.contains("large-v3") {
        return Some(DtwModelPreset::LargeV3);
    }

    if name.contains("large-v2") {
        return Some(DtwModelPreset::LargeV2);
    }

    if name.contains("large-v1") {
        return Some(DtwModelPreset::LargeV1);
    }

    if name.contains("large") {
        // Default large -> v3
        return Some(DtwModelPreset::LargeV3);
    }

    None
}

fn ctx_cache_key(model_path: &Path, dtw_preset: Option<DtwModelPreset>) -> String {
    let p = model_path.to_string_lossy();
    match dtw_preset {
        Some(preset) => format!("{}|dtw=preset:{preset:?}", p),
        None => format!("{}|dtw=off", p),
    }
}

fn ctx_cache_key_with_backend(
    model_path: &Path,
    dtw_preset: Option<DtwModelPreset>,
    use_gpu: bool,
    gpu_device: i32,
) -> String {
    format!(
        "{}|gpu={}|gpu_device={}",
        ctx_cache_key(model_path, dtw_preset),
        if use_gpu { 1 } else { 0 },
        gpu_device
    )
}

fn build_ctx_params(
    model_path: &Path,
    whisper_lang: Option<&str>,
    use_gpu: bool,
    enable_dtw: bool,
) -> (WhisperContextParameters<'static>, Option<DtwModelPreset>) {
    let mut ctx_params = WhisperContextParameters::default();
    ctx_params.use_gpu = use_gpu;
    if use_gpu {
        ctx_params.gpu_device = whisper_gpu_device();
    }

    let mut dtw_preset: Option<DtwModelPreset> = None;
    if enable_dtw && should_enable_dtw(whisper_lang) {
        if let Some(preset) = dtw_preset_for_model_path(model_path) {
            dtw_preset = Some(preset.clone());
            ctx_params.dtw_parameters.mode = DtwMode::ModelPreset {
                model_preset: preset,
            };
        } else {
            log::warn!(
                "DTW enabled, but model filename is unknown; DTW disabled to avoid init failure: {:?}",
                model_path
            );
        }
    }

    (ctx_params, dtw_preset)
}

fn is_whisper_error_code(msg: &str, code: i32) -> bool {
    msg.contains(&format!("Error code: {code}"))
        || msg.contains(&format!("code: {code}"))
        || msg.contains(&format!("code {code}"))
}

fn whisper_sampling_strategy() -> SamplingStrategy {
    // Default: Greedy (faster). Opt-in BeamSearch via env.
    // - FALKOE_WHISPER_BEAM_SIZE=5
    // - FALKOE_WHISPER_BEST_OF=5
    let beam_size: i32 = env_usize("FALKOE_WHISPER_BEAM_SIZE")
        .unwrap_or(1)
        .clamp(1, i32::MAX as usize) as i32;
    if beam_size > 1 {
        return SamplingStrategy::BeamSearch {
            beam_size,
            patience: 1.0,
        };
    }

    SamplingStrategy::Greedy {
        best_of: env_usize("FALKOE_WHISPER_BEST_OF")
            .unwrap_or(1)
            .clamp(1, i32::MAX as usize) as i32,
    }
}

fn should_split_on_word(whisper_lang: Option<&str>) -> bool {
    match whisper_lang {
        // Languages that typically separate words with whitespace.
        Some(
            "en" | "es" | "fr" | "de" | "it" | "pt" | "ru" | "uk" | "pl" | "nl" | "sv"
            | "tr" | "vi" | "id" | "ar" | "hi" | "ko",
        ) => true,
        // Japanese/Chinese/Thai generally do not use spaces for word boundaries.
        _ => false,
    }
}

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
    params.set_n_threads(whisper_n_threads());
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
    let segments_only = env_segments_only();

    fn run_once(
        audio: &[f32],
        model_path: &Path,
        whisper_lang: Option<&str>,
        use_gpu: bool,
        segments_only: bool,
    ) -> Result<Transcript> {
        // Cutter (segment suggestion) doesn't need DTW/token/word alignment; skipping it is
        // dramatically faster (especially on CPU).
        let enable_dtw = !segments_only;
        let (ctx_params, dtw_preset) = build_ctx_params(model_path, whisper_lang, use_gpu, enable_dtw);

        // Loading the Whisper model can be very expensive; cache the context for the
        // currently selected model+backend to speed up repeated transcriptions.
        let key = ctx_cache_key_with_backend(
            model_path,
            dtw_preset,
            ctx_params.use_gpu,
            ctx_params.gpu_device,
        );
        let ctx_mutex = MAIN_CTX.get_or_init(|| Mutex::new(None));
        let mut cached = ctx_mutex.lock().unwrap();
        let needs_reload = cached.as_ref().map(|c| c.key != key).unwrap_or(true);
        if needs_reload {
            let ctx = WhisperContext::new_with_params(model_path.to_str().unwrap(), ctx_params)?;
            *cached = Some(CachedWhisperContext { key, ctx });
        }

        // Keep the lock guard alive while the state exists.
        let ctx_ref = &cached.as_ref().unwrap().ctx;
        let mut state = ctx_ref.create_state()?;

        let mut params = FullParams::new(whisper_sampling_strategy());
        params.set_n_threads(whisper_n_threads());

        params.set_language(whisper_lang);
        params.set_translate(false);
        params.set_temperature(0.0);

        if segments_only {
            params.set_token_timestamps(false);
            params.set_split_on_word(false);
        } else {
            // Token-level timestamps.
            params.set_token_timestamps(true);
            // Prefer word-ish splitting only for whitespace-separated languages.
            params.set_split_on_word(should_split_on_word(whisper_lang));
        }

        state.full(params, audio)?;

        let mut segments: Vec<Segment> = Vec::new();

        if segments_only {
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
            }

            return Ok(Transcript {
                segments,
                tokens: None,
                words: None,
            });
        }

        let mut tokens: Vec<TokenTimestamp> = Vec::new();
        let mut token_bytes: Vec<(f32, f32, Vec<u8>)> = Vec::new();
        let mut prev_end_for_dtw: Option<f32> = None;

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

                let bytes = match tok.to_bytes() {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                let token_text = std::str::from_utf8(bytes)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned());

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

                let (start, end) = if let Some(dtw_end) = dtw {
                    let capped_dur = raw_dur.clamp(0.04, 0.30);
                    let start = match prev_end_for_dtw {
                        Some(prev) if prev <= dtw_end => prev,
                        _ => (dtw_end - capped_dur.max(0.25)).max(0.0),
                    };
                    let end = dtw_end.max(start);
                    prev_end_for_dtw = Some(end);
                    (start, end)
                } else {
                    (raw_start, raw_end)
                };

                let (start, end) = if end <= start {
                    (start, start + 0.04)
                } else {
                    (start, end)
                };

                if dtw.is_some() {
                    prev_end_for_dtw = Some(end);
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

    let want_gpu = whisper_use_gpu();
    match run_once(&audio, model_path, whisper_lang, want_gpu, segments_only) {
        Ok(t) => Ok(t),
        Err(e) => {
            let msg = e.to_string();
            if want_gpu
                && whisper_gpu_backend_available()
                && (is_whisper_error_code(&msg, -6) || is_whisper_error_code(&msg, -9))
            {
                // Some GPU backends can fail on certain drivers/inputs; retry on CPU.
                return run_once(&audio, model_path, whisper_lang, false, segments_only);
            }
            Err(e)
        }
    }
}

pub fn transcribe_segments_with_callbacks<P, A>(
    wav_path: &str,
    model_path: &Path,
    whisper_lang: Option<&str>,
    n_threads: i32,
    use_gpu: bool,
    progress_callback: P,
    abort_callback: A,
) -> Result<Transcript>
where
    P: FnMut(i32) + 'static,
    A: FnMut() -> bool + 'static,
{
    let audio = load_wav_as_f32(wav_path)?;

    // Cutter doesn't need token/word alignment. Disable DTW and token timestamps for speed.
    let (ctx_params, dtw_preset) = build_ctx_params(model_path, whisper_lang, use_gpu, false);

    let key = ctx_cache_key_with_backend(
        model_path,
        dtw_preset,
        ctx_params.use_gpu,
        ctx_params.gpu_device,
    );
    let ctx_mutex = MAIN_CTX.get_or_init(|| Mutex::new(None));
    let mut cached = ctx_mutex.lock().unwrap();
    let needs_reload = cached.as_ref().map(|c| c.key != key).unwrap_or(true);
    if needs_reload {
        let ctx = WhisperContext::new_with_params(model_path.to_str().unwrap(), ctx_params)?;
        *cached = Some(CachedWhisperContext { key, ctx });
    }

    let ctx_ref = &cached.as_ref().unwrap().ctx;
    let mut state = ctx_ref.create_state()?;

    let mut params = FullParams::new(whisper_sampling_strategy());
    params.set_n_threads(n_threads.clamp(1, 64));

    params.set_language(whisper_lang);
    params.set_translate(false);
    params.set_temperature(0.0);

    params.set_token_timestamps(false);
    params.set_split_on_word(false);

    params.set_print_progress(false);
    params.set_progress_callback_safe::<Option<P>, P>(Some(progress_callback));
    params.set_abort_callback_safe::<Option<A>, A>(Some(abort_callback));

    state.full(params, &audio)?;

    let mut segments: Vec<Segment> = Vec::new();
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
    }

    Ok(Transcript {
        segments,
        tokens: None,
        words: None,
    })
}

pub fn transcribe_with_callbacks<P, A>(
    wav_path: &str,
    model_path: &Path,
    whisper_lang: Option<&str>,
    n_threads: i32,
    use_gpu: bool,
    progress_callback: P,
    abort_callback: A,
) -> Result<Transcript>
where
    P: FnMut(i32) + 'static,
    A: FnMut() -> bool + 'static,
{
    let audio = load_wav_as_f32(wav_path)?;

    let (ctx_params, dtw_preset) = build_ctx_params(model_path, whisper_lang, use_gpu, true);

    // Loading the Whisper model can be very expensive; cache the context for the
    // currently selected model to speed up repeated transcriptions.
    let key = ctx_cache_key_with_backend(
        model_path,
        dtw_preset,
        ctx_params.use_gpu,
        ctx_params.gpu_device,
    );
    let ctx_mutex = MAIN_CTX.get_or_init(|| Mutex::new(None));
    let mut cached = ctx_mutex.lock().unwrap();
    let needs_reload = cached.as_ref().map(|c| c.key != key).unwrap_or(true);
    if needs_reload {
        let ctx = WhisperContext::new_with_params(model_path.to_str().unwrap(), ctx_params)?;
        *cached = Some(CachedWhisperContext { key, ctx });
    }

    // Keep the lock guard alive while the state exists.
    let ctx_ref = &cached.as_ref().unwrap().ctx;
    let mut state = ctx_ref.create_state()?;

    let mut params = FullParams::new(whisper_sampling_strategy());
    params.set_n_threads(n_threads.clamp(1, 64));

    params.set_language(whisper_lang);
    params.set_translate(false);
    params.set_temperature(0.0);

    // Token-level timestamps.
    params.set_token_timestamps(true);
    // Prefer word-ish splitting only for whitespace-separated languages.
    params.set_split_on_word(should_split_on_word(whisper_lang));

    params.set_print_progress(false);
    // Turbofish: avoid type inference ambiguity between P / &P / &mut P / Box<P> etc.
    params.set_progress_callback_safe::<Option<P>, P>(Some(progress_callback));
    params.set_abort_callback_safe::<Option<A>, A>(Some(abort_callback));

    state.full(params, &audio)?;

    let mut segments: Vec<Segment> = Vec::new();
    let mut tokens: Vec<TokenTimestamp> = Vec::new();
    let mut token_bytes: Vec<(f32, f32, Vec<u8>)> = Vec::new();
    // When DTW is enabled, token_data().t_dtw provides a more stable end timestamp.
    // Use it to keep token/word overlays aligned (not just for Japanese).
    let mut prev_end_for_dtw: Option<f32> = None;

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

            let (start, end) = if let Some(dtw_end) = dtw {
                // DTW provides a more reliable end timestamp; back-compute a plausible start.
                // Also enforce monotonicity to avoid overlaps when tokens jitter.
                let capped_dur = raw_dur.clamp(0.04, 0.30);
                let start = match prev_end_for_dtw {
                    Some(prev) if prev <= dtw_end => prev,
                    _ => (dtw_end - capped_dur.max(0.25)).max(0.0),
                };
                let end = dtw_end.max(start);
                prev_end_for_dtw = Some(end);
                (start, end)
            } else {
                (raw_start, raw_end)
            };

            let (start, end) = if end <= start {
                (start, start + 0.04)
            } else {
                (start, end)
            };

            if dtw.is_some() {
                prev_end_for_dtw = Some(end);
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
