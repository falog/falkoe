use crate::model::ensure_model;

use anyhow::{bail, Context, Result};
use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use super::ffmpeg::ffmpeg_convert_to_wav;
use super::lang::whisper_language;
use super::manifest::save_sentence_manifest_json;
use super::paths::sentence_audio_dir;
use super::transcript::save_transcript_json;
use super::types::{FinalResult, Segment};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TranscribeBackendPref {
    Auto,
    CpuOnly,
    Vulkan,
    Metal,
}

fn parse_backend_pref() -> TranscribeBackendPref {
    match std::env::var("FALKOE_WHISPER_BACKEND") {
        Ok(v) if v.eq_ignore_ascii_case("cpu") || v.eq_ignore_ascii_case("default") => {
            TranscribeBackendPref::CpuOnly
        }
        Ok(v) if v.eq_ignore_ascii_case("vulkan") || v.eq_ignore_ascii_case("gpu") => {
            TranscribeBackendPref::Vulkan
        }
        Ok(v) if v.eq_ignore_ascii_case("metal") => TranscribeBackendPref::Metal,
        _ => TranscribeBackendPref::Auto,
    }
}

fn helper_dirs(resource_dir: &std::path::Path) -> [std::path::PathBuf; 4] {
    // Keep this consistent with resolve_bundled_tool() used by ffmpeg/mecab/etc.
    // Depending on how Tauri is launched (dev vs bundle), resources may live under:
    // - <resource_dir>/bin
    // - <resource_dir>/resources/bin
    // - or directly under <resource_dir>
    [
        resource_dir.join("bin"),
        resource_dir.to_path_buf(),
        resource_dir.join("resources").join("bin"),
        resource_dir.join("resources"),
    ]
}

#[cfg(all(target_os = "windows", any(target_arch = "x86", target_arch = "x86_64")))]
fn transcribe_helper_candidates(
    resource_dir: &std::path::Path,
) -> Vec<(std::path::PathBuf, &'static str)> {
    let dirs = helper_dirs(resource_dir);
    let mut out = Vec::new();
    for d in dirs {
        out.push((d.join("falkoe-transcribe-vulkan.exe"), "vulkan"));
        out.push((d.join("falkoe-transcribe-avx2.exe"), "avx2"));
        out.push((d.join("falkoe-transcribe-avx.exe"), "avx"));
    }
    out
}

#[cfg(not(all(target_os = "windows", any(target_arch = "x86", target_arch = "x86_64"))))]
fn transcribe_helper_candidates(
    resource_dir: &std::path::Path,
) -> Vec<(std::path::PathBuf, &'static str)> {
    let dirs = helper_dirs(resource_dir);
    let mut out = Vec::new();
    for d in dirs {
        // CPU helper (portable default)
        out.push((d.join("falkoe-transcribe-cpu"), "cpu"));

        // Optional GPU helpers
        out.push((d.join("falkoe-transcribe-vulkan"), "vulkan"));
        out.push((d.join("falkoe-transcribe-metal"), "metal"));
    }
    out
}

fn has_any_transcribe_helper(app: &AppHandle) -> bool {
    let Ok(resource_dir) = app.path().resource_dir() else {
        return false;
    };
    transcribe_helper_candidates(&resource_dir)
        .into_iter()
        .any(|(p, _)| p.is_file())
}

fn should_isolate_transcribe(app: &AppHandle) -> bool {
    // Isolation via subprocess avoids taking down the whole app if native code crashes.
    // Behavior:
    // - Windows: default on
    // - Others: default off unless helpers are bundled (or explicitly enabled)
    match std::env::var("FALKOE_ISOLATE_TRANSCRIBE") {
        Ok(v) if v == "0" || v.eq_ignore_ascii_case("false") => return false,
        Ok(v) if v == "1" || v.eq_ignore_ascii_case("true") => return true,
        _ => {}
    }

    if cfg!(target_os = "windows") {
        return true;
    }

    // If user requested a GPU backend, we must use a helper if available.
    // (In-process CPU path cannot satisfy this.)
    let pref = parse_backend_pref();
    if matches!(pref, TranscribeBackendPref::Vulkan | TranscribeBackendPref::Metal) {
        return true;
    }

    // If helpers are bundled, prefer subprocess even on non-Windows.
    has_any_transcribe_helper(app)
}

fn resolve_transcribe_helper(
    app: &AppHandle,
    pref: TranscribeBackendPref,
) -> Result<(std::path::PathBuf, &'static str)> {
    let resource_dir = app.path().resource_dir()?;

    let candidates = transcribe_helper_candidates(&resource_dir);
    let mut tried: Vec<std::path::PathBuf> = Vec::new();

    // Avoid rare startup races where resources are being synced/copied.
    for _ in 0..10 {
        tried.clear();

        // 0) Optional GPU helpers
        if pref != TranscribeBackendPref::CpuOnly {
            if matches!(pref, TranscribeBackendPref::Vulkan | TranscribeBackendPref::Auto) {
                for (p, _) in candidates.iter().filter(|(_, k)| *k == "vulkan") {
                    tried.push(p.clone());
                    if p.is_file() {
                        return Ok((p.clone(), "vulkan"));
                    }
                }
                if pref == TranscribeBackendPref::Vulkan {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
            }

            if matches!(pref, TranscribeBackendPref::Metal | TranscribeBackendPref::Auto) {
                for (p, _) in candidates.iter().filter(|(_, k)| *k == "metal") {
                    tried.push(p.clone());
                    if p.is_file() {
                        return Ok((p.clone(), "metal"));
                    }
                }
                if pref == TranscribeBackendPref::Metal {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
            }
        }

        // 1) CPU helpers
        #[cfg(all(target_os = "windows", any(target_arch = "x86", target_arch = "x86_64")))]
        {
            let has_avx2 = std::is_x86_feature_detected!("avx2");
            let has_avx = std::is_x86_feature_detected!("avx");
            if !has_avx {
                bail!("CPU does not support AVX; transcription helper requires AVX");
            }

            if has_avx2 {
                for (p, _) in candidates.iter().filter(|(_, k)| *k == "avx2") {
                    tried.push(p.clone());
                    if p.is_file() {
                        return Ok((p.clone(), "avx2"));
                    }
                }
            }
            for (p, _) in candidates.iter().filter(|(_, k)| *k == "avx") {
                tried.push(p.clone());
                if p.is_file() {
                    return Ok((p.clone(), "avx"));
                }
            }
        }

        #[cfg(not(all(target_os = "windows", any(target_arch = "x86", target_arch = "x86_64"))))]
        {
            for (p, _) in candidates.iter().filter(|(_, k)| *k == "cpu") {
                tried.push(p.clone());
                if p.is_file() {
                    return Ok((p.clone(), "cpu"));
                }
            }
        }

        std::thread::sleep(Duration::from_millis(200));
    }

    crate::logging::log_line(
        app,
        format!(
            "[whisper] transcribe(subprocess): helper missing; resource_dir={} tried={} (showing up to 8)",
            resource_dir.display(),
            tried.len(),
        ),
    );
    for p in tried.iter().take(8) {
        crate::logging::log_line(
            app,
            format!(
                "[whisper] transcribe(subprocess): tried path exists={} is_file={} path={}",
                p.exists(),
                p.is_file(),
                p.display()
            ),
        );
    }

    let tried_joined = tried
        .iter()
        .take(12)
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join("; ");
    bail!(
        "transcribe helper not found: tried {}{}",
        tried_joined,
        if tried.len() > 12 { " (and more)" } else { "" }
    );
}

fn make_transcribe_command(
    app: &AppHandle,
    wav_path: &str,
    model_path: &std::path::Path,
    whisper_lang: Option<&'static str>,
) -> Result<(Command, &'static str)> {
    let pref = parse_backend_pref();
    make_transcribe_command_with_pref(app, wav_path, model_path, whisper_lang, pref)
}

fn make_transcribe_command_with_pref(
    app: &AppHandle,
    wav_path: &str,
    model_path: &std::path::Path,
    whisper_lang: Option<&'static str>,
    pref: TranscribeBackendPref,
) -> Result<(Command, &'static str)> {
    // Prefer bundled helper binaries when available.
    // If none are present, fall back to the existing self-spawn path.
    let (helper, picked) = match resolve_transcribe_helper(app, pref) {
        Ok(v) => v,
        Err(_) => {
            let exe = std::env::current_exe()?;
            let mut cmd = Command::new(&exe);

            // Hide transient console windows on Windows (GUI app spawning CLI helper).
            #[cfg(target_os = "windows")]
            {
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            cmd.arg("__transcribe_wav_json");
            cmd.arg(wav_path);
            cmd.arg("--model");
            cmd.arg(model_path);
            crate::logging::log_line(
                app,
                format!(
                    "[whisper] transcribe(subprocess): helper missing; falling back to self (backend_pref={pref:?})",
                ),
            );
            return Ok((cmd, "self"));
        }
    };

    #[cfg(all(target_os = "windows", any(target_arch = "x86", target_arch = "x86_64")))]
    let has_avx2 = std::is_x86_feature_detected!("avx2");
    #[cfg(not(all(target_os = "windows", any(target_arch = "x86", target_arch = "x86_64"))))]
    let has_avx2 = false;

    crate::logging::log_line(
        app,
        format!(
            "[whisper] transcribe(subprocess): helper={} picked={} avx2={} avx=true lang={:?}",
            helper.display(),
            picked,
            has_avx2,
            whisper_lang
        ),
    );

    let mut cmd = Command::new(&helper);

    // Hide transient console windows on Windows (GUI app spawning CLI helper).
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.arg(wav_path);
    cmd.arg("--model");
    cmd.arg(model_path);
    Ok((cmd, picked))
}

fn transcribe_in_subprocess(
    app: &AppHandle,
    wav_path: &str,
    model_path: &std::path::Path,
    whisper_lang: Option<&'static str>,
) -> Result<super::types::Transcript> {
    let (mut cmd0, _picked0) = make_transcribe_command(app, wav_path, model_path, whisper_lang)?;
    if let Some(l) = whisper_lang {
        cmd0.arg("--lang");
        cmd0.arg(l);
    }
    cmd0.env("RUST_BACKTRACE", "1");
    cmd0.stdout(std::process::Stdio::piped());
    cmd0.stderr(std::process::Stdio::piped());

    let out = cmd0.output()?;
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        crate::logging::log_line(
            app,
            format!(
                "[whisper] transcribe(subprocess): failed status={:?} stderr={}",
                out.status.code(),
                crate::logging::truncate_for_log(&stderr, 2000)
            ),
        );

        // If Vulkan helper failed, retry once with CPU-only backend.
        #[cfg(all(target_os = "windows", any(target_arch = "x86", target_arch = "x86_64")))]
        {
            if _picked0 == "vulkan" {
                crate::logging::log_line(app, "[whisper] transcribe(subprocess): vulkan helper failed; retrying with CPU helper".to_string());

                let (mut cmd1, _picked1) = make_transcribe_command_with_pref(
                    app,
                    wav_path,
                    model_path,
                    whisper_lang,
                    TranscribeBackendPref::CpuOnly,
                )?;
                if let Some(l) = whisper_lang {
                    cmd1.arg("--lang");
                    cmd1.arg(l);
                }
                cmd1.env("RUST_BACKTRACE", "1");
                cmd1.stdout(std::process::Stdio::piped());
                cmd1.stderr(std::process::Stdio::piped());

                let out2 = cmd1.output()?;
                let stderr2 = String::from_utf8_lossy(&out2.stderr).trim().to_string();
                if !out2.status.success() {
                    crate::logging::log_line(
                        app,
                        format!(
                            "[whisper] transcribe(subprocess): cpu retry failed status={:?} stderr={}",
                            out2.status.code(),
                            crate::logging::truncate_for_log(&stderr2, 2000)
                        ),
                    );
                    bail!("transcribe subprocess failed");
                }

                if !stderr2.is_empty() {
                    crate::logging::log_line(
                        app,
                        format!(
                            "[whisper] transcribe(subprocess): stderr={}",
                            crate::logging::truncate_for_log(&stderr2, 2000)
                        ),
                    );
                }

                let stdout2 = String::from_utf8_lossy(&out2.stdout);
                let stdout2_trimmed = stdout2.trim();
                // Parse JSON from retry stdout.
                let parsed2: Result<super::types::Transcript> = (|| {
                    if let Ok(t) = serde_json::from_str::<super::types::Transcript>(stdout2_trimmed) {
                        return Ok(t);
                    }
                    let start = stdout2_trimmed.find('{');
                    let end = stdout2_trimmed.rfind('}');
                    if let (Some(s), Some(e)) = (start, end) {
                        if s < e {
                            let json_slice = &stdout2_trimmed[s..=e];
                            let t = serde_json::from_str::<super::types::Transcript>(json_slice)?;
                            return Ok(t);
                        }
                    }
                    bail!("no JSON object found in stdout")
                })();

                return match parsed2 {
                    Ok(t) => Ok(t),
                    Err(e) => {
                        crate::logging::log_line(
                            app,
                            format!(
                                "[whisper] transcribe(subprocess): stdout(truncated)={}",
                                crate::logging::truncate_for_log(stdout2_trimmed, 2000)
                            ),
                        );
                        Err(e).with_context(|| "failed to parse transcribe subprocess stdout as JSON")
                    }
                };
            }
        }

        bail!("transcribe subprocess failed");
    }

    if !stderr.is_empty() {
        crate::logging::log_line(
            app,
            format!(
                "[whisper] transcribe(subprocess): stderr={}",
                crate::logging::truncate_for_log(&stderr, 2000)
            ),
        );
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stdout_trimmed = stdout.trim();

    // Some native dependencies (whisper.cpp) may print logs to stdout.
    // Extract the JSON object from stdout and parse that.
    let parsed: Result<super::types::Transcript> = (|| {
        if let Ok(t) = serde_json::from_str::<super::types::Transcript>(stdout_trimmed) {
            return Ok(t);
        }

        let start = stdout_trimmed.find('{');
        let end = stdout_trimmed.rfind('}');
        if let (Some(s), Some(e)) = (start, end) {
            if s < e {
                let json_slice = &stdout_trimmed[s..=e];
                let t = serde_json::from_str::<super::types::Transcript>(json_slice)?;
                return Ok(t);
            }
        }

        bail!("no JSON object found in stdout")
    })();

    match parsed {
        Ok(t) => Ok(t),
        Err(e) => {
            crate::logging::log_line(
                app,
                format!(
                    "[whisper] transcribe(subprocess): stdout(truncated)={}",
                    crate::logging::truncate_for_log(stdout_trimmed, 2000)
                ),
            );
            Err(e).with_context(|| "failed to parse transcribe subprocess stdout as JSON")
        }
    }
}

fn run_whisper_for_wav(app: &AppHandle, wav_path: &str, sentence_hash: &str, lang: &str) -> Result<()> {
    println!("=== run_whisper START ===");
    println!("wav_path = {}", wav_path);
    crate::logging::log_line(
        app,
        format!(
            "[whisper] start wav_path={} sentence_hash={} lang={}",
            wav_path, sentence_hash, lang
        ),
    );

    crate::logging::log_line(app, "[whisper] ensure_model: begin");
    let model_path = ensure_model(app)?;
    crate::logging::log_line(app, format!("[whisper] ensure_model: ok model_path={:?}", model_path));

    crate::logging::log_line(app, "[whisper] transcribe: begin");
    let whisper_lang = whisper_language(lang);

    let transcript_res = if should_isolate_transcribe(app) {
        transcribe_in_subprocess(app, wav_path, &model_path, whisper_lang)
    } else {
        Ok(super::transcribe(wav_path, &model_path, whisper_lang)?)
    };

    let transcript = match transcript_res {
        Ok(t) => {
            crate::logging::log_line(
                app,
                format!(
                    "[whisper] transcribe: ok segments={} tokens={} words={}",
                    t.segments.len(),
                    t.tokens.as_ref().map(|t| t.len()).unwrap_or(0),
                    t.words.as_ref().map(|w| w.len()).unwrap_or(0)
                ),
            );
            t
        }
        Err(e) => {
            // Ensure the UI completes even when transcription fails.
            crate::logging::log_line(app, format!("[whisper] transcribe: error: {e}"));
            super::types::Transcript {
                segments: Vec::new(),
                tokens: None,
                words: None,
            }
        }
    };
    save_transcript_json(wav_path, &transcript)?;
    crate::logging::log_line(app, "[whisper] save_transcript_json: ok");

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
    crate::logging::log_line(app, "[whisper] emitted transcript-final");

    // Run pitch analysis and persist it next to the transcript.
    // Japanese-only: also write accent.json (Heiban/Odaka/Nakadaka/Atamadaka labels).
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
            crate::logging::log_line(app, format!("[pitch] panic in analyze_pitch (caught): {msg}"));
            return Ok(());
        }
    };

    match pitch_ok {
        Ok(mut pitch) => {
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
                crate::logging::log_line(app, format!("[pitch] saved pitch: {:?}", pitch_path));
            }

            if is_ja {
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

            // Japanese tokenization helper input.
            // Build from Whisper word timestamps when available so MeCab output can be aligned.
            // (If this differs from whisper_words concat, mecab alignment will intentionally fall back.)
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
                // Tokens that should not be considered for lexical pitch accent labeling.
                // We treat them as boundaries and omit them from the accent overlay.
                //
                // Particles (dependent): は, が, を, に, で, と, も, へ, から, まで, より
                // Sentence-final / discourse: よ, ね, な, さ, ぞ, わ, か
                // Copula / polite auxiliaries: だ, です, ます, でした, でしたら
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

            fn flush_content_word(pitch: &crate::commands::pitch::PitchAnalysis, pending: &mut Option<PendingContent>, out_words: &mut Vec<AccentWordOut>) {
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

            // Prefer transcript word boundaries when available. If Whisper doesn't provide word
            // timestamps, fall back to segment timing so MeCab can still be used (approximate).
            let mut used_mecab = false;
            let mecab_wordlikes: Option<(Vec<super::mecab::WordLike>, &'static str)> = if let Some(t_words) = transcript.words.as_ref() {
                Some((
                    t_words
                        .iter()
                        .map(|w| super::mecab::WordLike {
                            start: w.start,
                            end: w.end,
                            text: w.text.clone(),
                        })
                        .collect::<Vec<_>>(),
                    "words",
                ))
            } else if !transcript.segments.is_empty() {
                Some((
                    transcript
                        .segments
                        .iter()
                        .map(|s| super::mecab::WordLike {
                            start: s.start,
                            end: s.end,
                            text: s.text.clone(),
                        })
                        .collect::<Vec<_>>(),
                    "segments",
                ))
            } else {
                None
            };

            if let Some((mecab_wordlikes, src)) = mecab_wordlikes.as_ref() {
                if let Some(mecab_tokens) = super::mecab::mecab_timed_tokens_with_app(
                    app,
                    &mecab_text_ja,
                    mecab_wordlikes,
                ) {
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
                    crate::logging::log_line(app, "[mecab] not used");
                }
            }

            if !used_mecab {
                if let Some(t_words) = transcript.words.as_ref() {
                    crate::logging::log_line(app, "[mecab] fallback to whisper word boundaries");
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
                            let out = emit_token_with_time(&pitch, p, cur, next);
                            if !out.word.is_empty() {
                                out_words.push(out);
                            }
                            cur = next;
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
            }

            let accent_path = Path::new(wav_path).with_extension("accent.json");
            if let Ok(json) = serde_json::to_string_pretty(&AccentOut { words: out_words }) {
                let _ = fs::write(&accent_path, json);
                println!("saved accent: {:?}", accent_path);
                crate::logging::log_line(app, format!("[accent] saved accent: {:?}", accent_path));
            }
            }
        }
        Err(e) => {
            crate::logging::log_line(app, format!("[pitch] analyze_pitch: error: {e}"));
        }
    }

    Ok(())
}

pub(crate) fn run_whisper_model_impl(
    app: AppHandle,
    url: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    let wav_path = download_and_convert_to_wav(&app, &url, &sentence_hash)?;

    std::thread::spawn(move || {
        let res = catch_unwind(AssertUnwindSafe(|| run_whisper_for_wav(&app, &wav_path, &sentence_hash, &lang)));
        match res {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                eprintln!("whisper model error: {e}");
                crate::logging::log_line(&app, format!("[whisper] model error: {e}"));
            }
            Err(payload) => {
                let msg = crate::logging::panic_payload_to_string(&*payload);
                eprintln!("whisper model panic (caught): {msg}");
                crate::logging::log_line(&app, format!("[whisper] model panic (caught): {msg}"));
            }
        }
    });

    Ok(())
}

pub(crate) fn run_whisper_uploaded_impl(
    app: AppHandle,
    uploaded_path: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    let wav_path = convert_uploaded_to_wav(&app, &uploaded_path, &sentence_hash)?;

    std::thread::spawn(move || {
        let res = catch_unwind(AssertUnwindSafe(|| run_whisper_for_wav(&app, &wav_path, &sentence_hash, &lang)));
        match res {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                eprintln!("whisper uploaded error: {e}");
                crate::logging::log_line(&app, format!("[whisper] uploaded error: {e}"));
            }
            Err(payload) => {
                let msg = crate::logging::panic_payload_to_string(&*payload);
                eprintln!("whisper uploaded panic (caught): {msg}");
                crate::logging::log_line(&app, format!("[whisper] uploaded panic (caught): {msg}"));
            }
        }
    });

    Ok(())
}

pub(crate) fn run_whisper_impl(
    app: AppHandle,
    path: String,
    sentence_hash: String,
    lang: String,
) -> Result<(), String> {
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let res = catch_unwind(AssertUnwindSafe(|| run_whisper_for_wav(&app_handle, &path, &sentence_hash, &lang)));
        match res {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                eprintln!("whisper error: {e}");
                crate::logging::log_line(&app_handle, format!("[whisper] error: {e}"));
            }
            Err(payload) => {
                let msg = crate::logging::panic_payload_to_string(&*payload);
                eprintln!("whisper panic (caught): {msg}");
                crate::logging::log_line(&app_handle, format!("[whisper] panic (caught): {msg}"));
            }
        }
    });

    Ok(())
}

fn convert_uploaded_to_wav(app: &AppHandle, uploaded_path: &str, sentence_hash: &str) -> Result<String, String> {
    (|| -> Result<String> {
        let base_dir = sentence_audio_dir(app, sentence_hash, "uploaded")?;
        fs::create_dir_all(&base_dir)?;

        let wav_path = base_dir.join("uploaded.wav");
        let input_path = Path::new(uploaded_path);

        // If the uploaded path already points to our destination wav, do not try to
        // re-convert in-place (ffmpeg errors: "Output ... same as Input ...").
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
            bail!("uploaded_path points to output wav but it does not exist: {}", uploaded_path);
        }

        ffmpeg_convert_to_wav(app, input_path, &wav_path)?;
        Ok(wav_path.to_string_lossy().to_string())
    })()
    .map_err(|e| e.to_string())
}

fn download_and_convert_to_wav(app: &AppHandle, url: &str, sentence_hash: &str) -> Result<String, String> {
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

#[allow(dead_code)]
fn _validate_segment(seg: &Segment) -> Result<()> {
    if seg.end < seg.start {
        bail!("invalid segment: end < start");
    }
    Ok(())
}
