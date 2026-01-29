use crate::model::ensure_model;
use crate::commands::whisper::{
    ffmpeg_convert_to_wav, ffmpeg_trim_with_padding_wav, transcribe_with_callbacks,
    transcribe_in_subprocess_with_overrides, whisper_gpu_backend_available, whisper_language,
    whisper_n_threads, Segment,
};
use chrono::Local;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

static CUTTER_DETECT_ABORT: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cutter_abort_flag(cutter_id: &str) -> Arc<AtomicBool> {
    let map = CUTTER_DETECT_ABORT.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = map.lock().unwrap();
    map.entry(cutter_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

fn clear_cutter_abort_flag(cutter_id: &str) {
    if let Some(map) = CUTTER_DETECT_ABORT.get() {
        let mut map = map.lock().unwrap();
        map.remove(cutter_id);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CutterDetectProgressPayload {
    cutter_id: String,
    progress: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCutterAudio {
    pub id: String,
    pub path: String,
    pub original_filename: String,
}

fn cutter_base_dir(app: &AppHandle, cutter_id: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .document_dir()
        .map_err(|_| "no document dir".to_string())?
        .join("falkoe")
        .join("cutter")
        .join(cutter_id))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let result = hasher.finalize();
    format!("{:x}", result)
}

fn is_slash_only(text: &str) -> bool {
    let t = text.trim();
    t == "/" || t == "／"
}

fn is_whisper_encoder_failure_minus6(msg: &str) -> bool {
    msg.contains("Error code: -6") || msg.contains("code: -6") || msg.contains("code -6")
}

fn is_whisper_error_minus9(msg: &str) -> bool {
    msg.contains("Error code: -9") || msg.contains("code: -9") || msg.contains("code -9")
}

fn format_cutter_whisper_error(msg: String) -> String {
    msg
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

fn strip_trailing_quotes_and_brackets(mut s: &str) -> &str {
    loop {
        let t = s.trim_end();
        let Some(last) = t.chars().last() else {
            return t;
        };
        if matches!(last, '"' | '\'' | '”' | '’' | ')' | ']' | '}' | '」' | '』') {
            // Remove one char and continue.
            let cut = t.len() - last.len_utf8();
            s = &t[..cut];
            continue;
        }
        return t;
    }
}

fn last_token(text: &str) -> Option<&str> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    t.split_whitespace().last()
}

fn is_common_abbrev_dot(text: &str) -> bool {
    // Detect cases like "Mr.", "Dr.", "U.S.", or "A." where the trailing '.'
    // should NOT be treated as a sentence boundary.
    let t = strip_trailing_quotes_and_brackets(text).trim_end();
    if !t.ends_with('.') {
        return false;
    }

    let tok = match last_token(t) {
        Some(x) => x,
        None => return false,
    };

    // Normalize token: strip trailing punctuation except '.' and then strip the final '.'
    // e.g. "Mr." -> "Mr", "U.S." -> "U.S"
    let tok = tok.trim_matches(|c: char| c == '"' || c == '”' || c == '’' || c == '\'' || c == ')');
    let base = tok.trim_end_matches('.');
    if base.is_empty() {
        return false;
    }

    // Single-letter initials like "A." or "J.".
    if base.len() == 1 {
        let ch = base.chars().next().unwrap();
        if ch.is_ascii_alphabetic() {
            return true;
        }
    }

    // Multi-initial abbreviations like "U.S." / "U.K." / "E.U.".
    if base.contains('.') {
        let ok = base
            .chars()
            .all(|c| c == '.' || (c.is_ascii_alphabetic() && c.is_ascii_uppercase()));
        if ok {
            return true;
        }
    }

    // Common English title abbreviations.
    let lower = base
        .trim_matches(|c: char| !c.is_ascii_alphabetic())
        .to_ascii_lowercase();

    matches!(
        lower.as_str(),
        "mr"
            | "mrs"
            | "ms"
            | "dr"
            | "prof"
            | "sr"
            | "jr"
            | "st"
            | "mt"
            | "vs"
            | "etc"
            | "e"
            | "i"
    )
}

fn ends_sentence(text: &str) -> bool {
    let t = strip_trailing_quotes_and_brackets(text);
    let Some(last) = t.trim_end().chars().last() else {
        return false;
    };
    match last {
        '.' => !is_common_abbrev_dot(text),
        '!' | '?' | '。' | '！' | '？' => true,
        _ => false,
    }
}

fn first_alpha_is_lowercase(text: &str) -> bool {
    for ch in text.trim_start().chars() {
        if ch.is_alphabetic() {
            return ch.is_lowercase();
        }
    }
    false
}

fn starts_with_punct(text: &str) -> bool {
    let Some(ch) = text.trim_start().chars().next() else {
        return false;
    };
    matches!(
        ch,
        ',' | ';' | ':' | '"' | '“' | '”' | '\'' | '’' | ')' | ']' | '}'
    )
}

fn last_word_lower(text: &str) -> Option<String> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let mut last = None;
    for part in t.split_whitespace() {
        last = Some(part);
    }
    let w = last?;
    let w = w
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '\'' && c != '-')
        .to_lowercase();
    if w.is_empty() {
        None
    } else {
        Some(w)
    }
}

fn join_text(a: &str, b: &str) -> String {
    let a = a.trim_end();
    let b = b.trim_start();
    if b.is_empty() {
        return a.to_string();
    }
    if a.is_empty() {
        return b.to_string();
    }
    if starts_with_punct(b) {
        format!("{a}{b}")
    } else {
        format!("{a} {b}")
    }
}

fn should_merge_prev_next(prev_text: &str, next_text: &str) -> bool {
    if prev_text.trim().is_empty() || next_text.trim().is_empty() {
        return false;
    }

    // If the next segment begins with punctuation (or is only punctuation), it almost always belongs
    // to the previous segment.
    if starts_with_punct(next_text) {
        return true;
    }

    // Prefer merging until we see a real sentence boundary.
    if !ends_sentence(prev_text) {
        return true;
    }

    // If the next looks like a continuation (lowercase), keep it attached.
    if first_alpha_is_lowercase(next_text) {
        return true;
    }

    // Common English dangling words that often indicate the sentence continues.
    if let Some(w) = last_word_lower(prev_text) {
        const DANGLING: [&str; 14] = [
            "of", "to", "and", "or", "but", "a", "an", "the", "in", "on", "at", "for", "with",
            "from",
        ];
        if DANGLING.contains(&w.as_str()) {
            return true;
        }
    }

    false
}

fn normalize_segments_for_cutter(segments: Vec<Segment>) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();

    let mut i = 0usize;
    while i < segments.len() {
        let seg = &segments[i];
        let text = seg.text.trim();

        // Drop empty/noise-only segments early.
        if text.is_empty() || is_slash_only(text) {
            i += 1;
            continue;
        }

        let start = seg.start;
        let mut end = seg.end;
        let mut texts: Vec<String> = vec![text.to_string()];

        // If we encounter slash-only segments immediately after this segment,
        // merge the next real segment(s) too. This helps when Whisper emits
        // " / " as a standalone segment between phrases.
        let mut j = i + 1;
        let mut saw_slash = false;
        while j < segments.len() {
            let next = &segments[j];
            let nt = next.text.trim();

            if nt.is_empty() {
                end = end.max(next.end);
                j += 1;
                continue;
            }

            if is_slash_only(nt) {
                saw_slash = true;
                end = end.max(next.end);
                j += 1;
                continue;
            }

            if saw_slash {
                end = end.max(next.end);
                texts.push(nt.to_string());
                j += 1;
                continue;
            }

            break;
        }

        let mut merged_text = String::new();
        for (k, part) in texts.iter().enumerate() {
            if k == 0 {
                merged_text.push_str(part);
            } else {
                merged_text = join_text(&merged_text, part);
            }
        }
        // Ensure non-decreasing time.
        if end > start {
            out.push(Segment {
                start,
                end,
                text: merged_text,
            });
        }

        i = j;
    }

    // Second pass: merge awkward mid-sentence splits (common in English) so the cut list feels natural.
    // Guard rails are important here so we don't accidentally merge across a real pause and end up with
    // huge clips.
    const MAX_GAP_SEC: f32 = 0.7;
    const MAX_MERGED_SEC: f32 = 18.0;
    const MAX_MERGED_CHARS: usize = 240;
    let mut merged: Vec<Segment> = Vec::new();
    for seg in out.into_iter() {
        if let Some(prev) = merged.last_mut() {
            let gap = (seg.start - prev.end).max(0.0);
            let merged_end = prev.end.max(seg.end);
            let merged_duration = merged_end - prev.start;
            let merged_chars = prev.text.len().saturating_add(1).saturating_add(seg.text.len());

            if gap <= MAX_GAP_SEC
                && merged_duration <= MAX_MERGED_SEC
                && merged_chars <= MAX_MERGED_CHARS
                && should_merge_prev_next(&prev.text, &seg.text)
            {
                prev.end = prev.end.max(seg.end);
                prev.text = join_text(&prev.text, &seg.text);
                continue;
            }
        }
        merged.push(seg);
    }

    merged
}

#[tauri::command]
pub fn save_cutter_audio(
    app: AppHandle,
    file_data: Vec<u8>,
    original_filename: String,
) -> Result<SavedCutterAudio, String> {
    let id = sha256_hex(&file_data);
    let base_dir = cutter_base_dir(&app, &id)?;
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    let ext = Path::new(&original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");

    let input_path = base_dir.join(format!("input.{ext}"));
    fs::write(&input_path, &file_data).map_err(|e| e.to_string())?;

    let original_filename_path = base_dir.join("original_filename.txt");
    let _ = fs::write(&original_filename_path, &original_filename);

    Ok(SavedCutterAudio {
        id,
        path: input_path.to_string_lossy().to_string(),
        original_filename,
    })
}

#[tauri::command]
pub async fn cutter_suggest_segments(
    app: AppHandle,
    cutter_id: String,
    input_path: String,
    lang: String,
) -> Result<Vec<Segment>, String> {
    let base_dir = cutter_base_dir(&app, &cutter_id)?;
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    let wav_path = base_dir.join("input_16k.wav");
    ffmpeg_convert_to_wav(&app, Path::new(&input_path), &wav_path).map_err(|e| e.to_string())?;
    let whisper_lang = whisper_language(&lang);

    let wav_str = wav_path
        .to_str()
        .ok_or_else(|| "invalid wav path".to_string())?;

    let abort_flag = cutter_abort_flag(&cutter_id);
    abort_flag.store(false, Ordering::Relaxed);

    let wav_str = wav_str.to_string();
    let app_for_cb = app.clone();
    let cutter_id_for_cb = cutter_id.clone();
    let abort_for_cb = abort_flag.clone();

    let join = tauri::async_runtime::spawn_blocking(move || {
        let model_path = ensure_model(&app_for_cb)?;

        let base_threads = whisper_n_threads().max(1);
        let mut thread_attempts: Vec<i32> = Vec::new();
        for n in [base_threads, (base_threads / 2).max(1), 2, 1] {
            if n <= base_threads && !thread_attempts.contains(&n) {
                thread_attempts.push(n);
            }
        }
        if thread_attempts.is_empty() {
            thread_attempts.push(1);
        }

        let force_use_gpu = env_bool("FALKOE_WHISPER_USE_GPU");
        let backend_attempts: Vec<bool> = match force_use_gpu {
            Some(false) => vec![false],
            Some(true) => {
                if whisper_gpu_backend_available() {
                    vec![true]
                } else {
                    crate::logging::log_line(
                        &app_for_cb,
                        "[cutter] FALKOE_WHISPER_USE_GPU=1 but this build has no GPU backend; using CPU",
                    );
                    vec![false]
                }
            }
            None => {
                if whisper_gpu_backend_available() {
                    vec![true, false]
                } else {
                    vec![false]
                }
            }
        };

        let mut last_err: Option<anyhow::Error> = None;

        for use_gpu in backend_attempts {
            if !use_gpu {
                crate::logging::log_line(&app_for_cb, "[cutter] trying CPU backend (use_gpu=0)");
            }

            for (idx, n_threads) in thread_attempts.iter().copied().enumerate() {
                if idx > 0 {
                    crate::logging::log_line(
                        &app_for_cb,
                        format!("[cutter] retry transcribe with n_threads={n_threads} use_gpu={}", if use_gpu { 1 } else { 0 }),
                    );
                }

                let mut last_progress: i32 = -1;
                let res = if cfg!(target_os = "windows") {
                    if abort_for_cb.load(Ordering::Relaxed) {
                        Err(anyhow::anyhow!("cancelled"))
                    } else {
                        // The in-process whisper path can fail on some Windows setups.
                        // Use the same subprocess helper path as regular transcription.
                        let running = Arc::new(AtomicBool::new(true));
                        let running_for_thread = running.clone();
                        let app_for_progress = app_for_cb.clone();
                        let cutter_id_for_progress = cutter_id_for_cb.clone();
                        let abort_for_progress = abort_for_cb.clone();

                        let progress_thread = std::thread::spawn(move || {
                            // Simple time-based progress: keep UI responsive while the helper runs.
                            // Cap at 95 until completion.
                            let mut p: i32 = 1;
                            while running_for_thread.load(Ordering::Relaxed)
                                && !abort_for_progress.load(Ordering::Relaxed)
                            {
                                let _ = app_for_progress.emit(
                                    "cutter-detect-progress",
                                    CutterDetectProgressPayload {
                                        cutter_id: cutter_id_for_progress.clone(),
                                        progress: p,
                                    },
                                );
                                p = (p + 1).min(95);
                                std::thread::sleep(std::time::Duration::from_millis(300));
                            }
                        });

                        let res = transcribe_in_subprocess_with_overrides(
                            &app_for_cb,
                            &wav_str,
                            &model_path,
                            whisper_lang,
                            n_threads,
                            use_gpu,
                        );

                        running.store(false, Ordering::Relaxed);
                        let _ = progress_thread.join();
                        res
                    }
                } else {
                    transcribe_with_callbacks(
                        &wav_str,
                        &model_path,
                        whisper_lang,
                        n_threads,
                        use_gpu,
                        {
                            let app_for_cb = app_for_cb.clone();
                            let cutter_id_for_cb = cutter_id_for_cb.clone();
                            move |p| {
                                if p == last_progress {
                                    return;
                                }
                                last_progress = p;
                                let _ = app_for_cb.emit(
                                    "cutter-detect-progress",
                                    CutterDetectProgressPayload {
                                        cutter_id: cutter_id_for_cb.clone(),
                                        progress: p,
                                    },
                                );
                            }
                        },
                        {
                            let abort_for_cb = abort_for_cb.clone();
                            move || abort_for_cb.load(Ordering::Relaxed)
                        },
                    )
                };

                match res {
                    Ok(t) => return Ok(t),
                    Err(e) => {
                        let msg = e.to_string();
                        crate::logging::log_line(
                            &app_for_cb,
                            format!(
                                "[cutter] transcribe failed n_threads={n_threads} use_gpu={}: {msg}",
                                if use_gpu { 1 } else { 0 }
                            ),
                        );
                        let should_retry_threads =
                            (is_whisper_encoder_failure_minus6(&msg) || is_whisper_error_minus9(&msg))
                                && n_threads > 1;

                        // If GPU backend fails with these codes, also try CPU backend.
                        let should_try_cpu = use_gpu
                            && (is_whisper_encoder_failure_minus6(&msg) || is_whisper_error_minus9(&msg));

                        last_err = Some(e);

                        if should_retry_threads {
                            continue;
                        }

                        if should_try_cpu {
                            break;
                        }

                        return Err(last_err.unwrap());
                    }
                }
            }
        }

        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("transcribe failed")))
    })
    .await;

    clear_cutter_abort_flag(&cutter_id);

    let res = join.map_err(|e| e.to_string())?;

    let transcript = match res {
        Ok(t) => t,
        Err(e) => {
            if abort_flag.load(Ordering::Relaxed) {
                return Err("cancelled".to_string());
            }
            return Err(format_cutter_whisper_error(e.to_string()));
        }
    };

    let _ = app.emit(
        "cutter-detect-progress",
        CutterDetectProgressPayload {
            cutter_id: cutter_id.clone(),
            progress: 100,
        },
    );

    Ok(normalize_segments_for_cutter(transcript.segments))
}

#[tauri::command]
pub async fn cutter_suggest_segments_raw(
    app: AppHandle,
    cutter_id: String,
    input_path: String,
    lang: String,
) -> Result<Vec<Segment>, String> {
    let base_dir = cutter_base_dir(&app, &cutter_id)?;
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    let wav_path = base_dir.join("input_16k.wav");
    ffmpeg_convert_to_wav(&app, Path::new(&input_path), &wav_path).map_err(|e| e.to_string())?;
    let whisper_lang = whisper_language(&lang);

    let wav_str = wav_path
        .to_str()
        .ok_or_else(|| "invalid wav path".to_string())?;

    let abort_flag = cutter_abort_flag(&cutter_id);
    abort_flag.store(false, Ordering::Relaxed);

    let wav_str = wav_str.to_string();
    let app_for_cb = app.clone();
    let cutter_id_for_cb = cutter_id.clone();
    let abort_for_cb = abort_flag.clone();

    let join = tauri::async_runtime::spawn_blocking(move || {
        let model_path = ensure_model(&app_for_cb)?;

        let base_threads = whisper_n_threads().max(1);
        let mut thread_attempts: Vec<i32> = Vec::new();
        for n in [base_threads, (base_threads / 2).max(1), 2, 1] {
            if n <= base_threads && !thread_attempts.contains(&n) {
                thread_attempts.push(n);
            }
        }
        if thread_attempts.is_empty() {
            thread_attempts.push(1);
        }

        let force_use_gpu = env_bool("FALKOE_WHISPER_USE_GPU");
        let backend_attempts: Vec<bool> = match force_use_gpu {
            Some(false) => vec![false],
            Some(true) => {
                if whisper_gpu_backend_available() {
                    vec![true]
                } else {
                    crate::logging::log_line(
                        &app_for_cb,
                        "[cutter] FALKOE_WHISPER_USE_GPU=1 but this build has no GPU backend; using CPU",
                    );
                    vec![false]
                }
            }
            None => {
                if whisper_gpu_backend_available() {
                    vec![true, false]
                } else {
                    vec![false]
                }
            }
        };

        let mut last_err: Option<anyhow::Error> = None;

        for use_gpu in backend_attempts {
            if !use_gpu {
                crate::logging::log_line(&app_for_cb, "[cutter] trying CPU backend (use_gpu=0)");
            }

            for (idx, n_threads) in thread_attempts.iter().copied().enumerate() {
                if idx > 0 {
                    crate::logging::log_line(
                        &app_for_cb,
                        format!("[cutter] retry transcribe with n_threads={n_threads} use_gpu={}", if use_gpu { 1 } else { 0 }),
                    );
                }

                let mut last_progress: i32 = -1;
                let res = if cfg!(target_os = "windows") {
                    if abort_for_cb.load(Ordering::Relaxed) {
                        Err(anyhow::anyhow!("cancelled"))
                    } else {
                        let running = Arc::new(AtomicBool::new(true));
                        let running_for_thread = running.clone();
                        let app_for_progress = app_for_cb.clone();
                        let cutter_id_for_progress = cutter_id_for_cb.clone();
                        let abort_for_progress = abort_for_cb.clone();

                        let progress_thread = std::thread::spawn(move || {
                            let mut p: i32 = 1;
                            while running_for_thread.load(Ordering::Relaxed)
                                && !abort_for_progress.load(Ordering::Relaxed)
                            {
                                let _ = app_for_progress.emit(
                                    "cutter-detect-progress",
                                    CutterDetectProgressPayload {
                                        cutter_id: cutter_id_for_progress.clone(),
                                        progress: p,
                                    },
                                );
                                p = (p + 1).min(95);
                                std::thread::sleep(std::time::Duration::from_millis(300));
                            }
                        });

                        let res = transcribe_in_subprocess_with_overrides(
                            &app_for_cb,
                            &wav_str,
                            &model_path,
                            whisper_lang,
                            n_threads,
                            use_gpu,
                        );

                        running.store(false, Ordering::Relaxed);
                        let _ = progress_thread.join();
                        res
                    }
                } else {
                    transcribe_with_callbacks(
                        &wav_str,
                        &model_path,
                        whisper_lang,
                        n_threads,
                        use_gpu,
                        {
                            let app_for_cb = app_for_cb.clone();
                            let cutter_id_for_cb = cutter_id_for_cb.clone();
                            move |p| {
                                if p == last_progress {
                                    return;
                                }
                                last_progress = p;
                                let _ = app_for_cb.emit(
                                    "cutter-detect-progress",
                                    CutterDetectProgressPayload {
                                        cutter_id: cutter_id_for_cb.clone(),
                                        progress: p,
                                    },
                                );
                            }
                        },
                        {
                            let abort_for_cb = abort_for_cb.clone();
                            move || abort_for_cb.load(Ordering::Relaxed)
                        },
                    )
                };

                match res {
                    Ok(t) => return Ok(t),
                    Err(e) => {
                        let msg = e.to_string();
                        crate::logging::log_line(
                            &app_for_cb,
                            format!(
                                "[cutter] transcribe failed n_threads={n_threads} use_gpu={}: {msg}",
                                if use_gpu { 1 } else { 0 }
                            ),
                        );
                        let should_retry_threads =
                            (is_whisper_encoder_failure_minus6(&msg) || is_whisper_error_minus9(&msg))
                                && n_threads > 1;
                        let should_try_cpu = use_gpu
                            && (is_whisper_encoder_failure_minus6(&msg) || is_whisper_error_minus9(&msg));

                        last_err = Some(e);

                        if should_retry_threads {
                            continue;
                        }

                        if should_try_cpu {
                            break;
                        }

                        return Err(last_err.unwrap());
                    }
                }
            }
        }

        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("transcribe failed")))
    })
    .await;

    clear_cutter_abort_flag(&cutter_id);

    let res = join.map_err(|e| e.to_string())?;

    let transcript = match res {
        Ok(t) => t,
        Err(e) => {
            if abort_flag.load(Ordering::Relaxed) {
                return Err("cancelled".to_string());
            }
            return Err(format_cutter_whisper_error(e.to_string()));
        }
    };

    let _ = app.emit(
        "cutter-detect-progress",
        CutterDetectProgressPayload {
            cutter_id: cutter_id.clone(),
            progress: 100,
        },
    );

    // Keep it "raw": no merging heuristics. Still drop empty/noise segments.
    Ok(transcript
        .segments
        .into_iter()
        .filter(|s| {
            let t = s.text.trim();
            !t.is_empty() && !is_slash_only(t)
        })
        .collect())
}

#[tauri::command]
pub fn cutter_cancel_detect(cutter_id: String) -> Result<(), String> {
    let flag = cutter_abort_flag(&cutter_id);
    flag.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn cutter_preview_segment(
    app: AppHandle,
    cutter_id: String,
    input_path: String,
    segment_index: u32,
    segment: Segment,
    margin_before: f32,
    margin_after: f32,
    silence_sec: f32,
) -> Result<String, String> {
    let base_dir = cutter_base_dir(&app, &cutter_id)?;
    let preview_dir = base_dir.join("previews");
    fs::create_dir_all(&preview_dir).map_err(|e| e.to_string())?;

    let start = (segment.start - margin_before).max(0.0);
    let end = segment.end + margin_after;
    if !(end > start) {
        return Err("invalid segment time range".into());
    }

    let out_path = preview_dir.join(format!("preview_{:04}.wav", segment_index));

    ffmpeg_trim_with_padding_wav(
        &app,
        Path::new(&input_path),
        start,
        end,
        silence_sec.max(0.0),
        0.0,
        &out_path,
    )
    .map_err(|e| e.to_string())?;

    Ok(out_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cutter_export_segments(
    app: AppHandle,
    cutter_id: String,
    input_path: String,
    segments: Vec<Segment>,
    margin_before: f32,
    margin_after: f32,
    silence_sec: f32,
) -> Result<Vec<String>, String> {
    let base_dir = cutter_base_dir(&app, &cutter_id)?;
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    let stamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let out_dir = base_dir.join("exports").join(stamp);
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let mut out_paths = Vec::new();

    for (idx, seg) in segments.iter().enumerate() {
        let start = (seg.start - margin_before).max(0.0);
        let end = seg.end + margin_after;

        if !(end > start) {
            continue;
        }

        let out_path = out_dir.join(format!("clip_{:04}.wav", idx + 1));

        // Add a short silence BEFORE the clip so the next sentence doesn't start too abruptly.
        // This also helps with playback that tends to clip the first few ms.
        let pad_start = silence_sec.max(0.0);
        let pad_end = 0.0;

        ffmpeg_trim_with_padding_wav(
            &app,
            Path::new(&input_path),
            start,
            end,
            pad_start,
            pad_end,
            &out_path,
        )
        .map_err(|e| e.to_string())?;

        out_paths.push(out_path.to_string_lossy().to_string());
    }

    Ok(out_paths)
}
