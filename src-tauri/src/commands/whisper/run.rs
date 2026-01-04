use crate::model::ensure_model;

use anyhow::{bail, Result};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Emitter};

use super::ffmpeg::ffmpeg_convert_to_wav;
use super::lang::whisper_language;
use super::manifest::save_sentence_manifest_json;
use super::paths::sentence_audio_dir;
use super::transcribe_impl::transcribe;
use super::transcript::save_transcript_json;
use super::types::{FinalResult, Segment};

fn run_whisper_for_wav(app: &AppHandle, wav_path: &str, sentence_hash: &str, lang: &str) -> Result<()> {
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
                t.chars().all(|c| c.is_ascii_punctuation())
            }

            fn is_ja_particle(s: &str) -> bool {
                // Minimal particle set to separate content words from particles.
                // This is intentionally conservative and single-character.
                matches!(
                    s.trim(),
                    "が" | "は" | "を" | "に" | "で" | "と" | "も" | "へ" | "の" | "や" | "か" | "ね" | "よ" | "な"
                )
            }

            fn count_ja_mora_like(s: &str) -> usize {
                // Approximate mora count from kana. This is intentionally simple:
                // - counts hiragana/katakana base chars and prolonged sound mark 'ー'
                // - ignores small kana that modify the previous mora (ゃゅょぁぃぅぇぉゎ + katakana variants)
                let mut n = 0usize;
                for ch in s.chars() {
                    match ch {
                        // small kana that don't form a mora by themselves
                        'ゃ' | 'ゅ' | 'ょ' | 'ぁ' | 'ぃ' | 'ぅ' | 'ぇ' | 'ぉ' | 'ゎ'
                        | 'ャ' | 'ュ' | 'ョ' | 'ァ' | 'ィ' | 'ゥ' | 'ェ' | 'ォ' | 'ヮ' => {
                            continue;
                        }
                        // prolonged sound mark counts
                        'ー' => {
                            n += 1;
                        }
                        _ => {
                            let is_hira = ('ぁ'..='ゖ').contains(&ch);
                            let is_kata = ('ァ'..='ヺ').contains(&ch);
                            if is_hira || is_kata {
                                n += 1;
                            }
                        }
                    }
                }
                n
            }

            #[derive(Clone)]
            struct MergedWord {
                text: String,
                start: f32,
                end: f32,
                fallback_label: Option<String>,
                fallback_peak_pos: Option<f32>,
                fallback_pitch_range: Option<f32>,
                fallback_slope: Option<f32>,
            }

            let mut out_words: Vec<AccentWordOut> = Vec::new();

            if let Some(words) = &pitch.words {
                // JA: merge per-character "words" into more word-like units (content word vs particles)
                // before estimating pitch-accent.
                let mut merged: Vec<MergedWord> = Vec::new();
                for w in words {
                    let t = w.text.trim();
                    if t.is_empty() {
                        continue;
                    }

                    if is_punct_word(&w.text) {
                        if let Some(last) = merged.last_mut() {
                            last.text.push_str(&w.text);
                            last.end = w.end;
                        }
                        continue;
                    }

                    if is_ja_particle(&w.text) {
                        merged.push(MergedWord {
                            text: w.text.clone(),
                            start: w.start,
                            end: w.end,
                            fallback_label: w.label.clone(),
                            fallback_peak_pos: w.peak_pos,
                            fallback_pitch_range: w.pitch_range,
                            fallback_slope: w.slope,
                        });
                        continue;
                    }

                    match merged.last_mut() {
                        Some(last) if !is_ja_particle(&last.text) => {
                            last.text.push_str(&w.text);
                            last.end = w.end;
                        }
                        _ => {
                            merged.push(MergedWord {
                                text: w.text.clone(),
                                start: w.start,
                                end: w.end,
                                fallback_label: w.label.clone(),
                                fallback_peak_pos: w.peak_pos,
                                fallback_pitch_range: w.pitch_range,
                                fallback_slope: w.slope,
                            });
                        }
                    }
                }
                for mw in merged {
                    let n = pitch.f0_rel.len();
                    let time_step = pitch.time_step.max(0.001);

                    let si0 = time_to_index_floor(mw.start, time_step);
                    let ei0 = time_to_index_ceil(mw.end, time_step);
                    let si = si0.min(n);
                    let ei = ei0.min(n);

                    let voiced = collect_voiced(&pitch.f0_rel, si, ei);
                    let (mut label, mut peak_pos, pitch_range, slope) = if voiced.len() >= 5 {
                        let (pp, pr, sl) = segment_features_py(&voiced);
                        (
                            Some(estimate_accent_label_py(pp, pr)),
                            Some(pp),
                            Some(pr),
                            Some(sl),
                        )
                    } else {
                        (
                            mw.fallback_label.clone(),
                            mw.fallback_peak_pos,
                            mw.fallback_pitch_range,
                            mw.fallback_slope,
                        )
                    };

                    // If a content word spans multiple mora, detect an early accent nucleus by
                    // looking at the first-mora window. This helps cases like "さくら" where
                    // phrase-final rises can push the global maximum late.
                    // IMPORTANT: only apply this override when the whole-word label is already
                    // leaning Odaka (peak late). Otherwise it can incorrectly flip Nakadaka->Atamadaka.
                    if voiced.len() >= 5
                        && !is_ja_particle(&mw.text)
                        && matches!(label.as_deref(), Some("Odaka"))
                    {
                        let mora_n = count_ja_mora_like(&mw.text);
                        if mora_n >= 2 {
                            let first_end_t = mw.start + (mw.end - mw.start).max(0.0) / mora_n as f32;
                            let fsi0 = time_to_index_floor(mw.start, time_step);
                            let fei0 = time_to_index_ceil(first_end_t, time_step);
                            let fsi = fsi0.min(n);
                            let fei = fei0.min(n);
                            let first_voiced = collect_voiced(&pitch.f0_rel, fsi, fei);
                            if first_voiced.len() >= 5 {
                                let (pp1, pr1, _sl1) = segment_features_py(&first_voiced);
                                let l1 = estimate_accent_label_py(pp1, pr1);
                                if l1 == "Atamadaka" {
                                    label = Some(l1);
                                    // Keep peak_pos consistent with Atamadaka.
                                    peak_pos = Some(0.0);
                                }
                            }
                        }
                    }

                    out_words.push(AccentWordOut {
                        word: mw.text.clone(),
                        start: mw.start,
                        end: mw.end,
                        text: mw.text,
                        label,
                        peak_pos,
                        pitch_range,
                        slope,
                    });
                }
            } else if let Some(words) = &pitch.words {
                // Fallback: use whatever pitch analysis produced.
                for w in words {
                    if is_punct_word(&w.text) && !out_words.is_empty() {
                        let last = out_words.last_mut().unwrap();
                        last.word.push_str(&w.text);
                        last.text.push_str(&w.text);
                        last.end = w.end;
                        continue;
                    }

                    out_words.push(AccentWordOut {
                        word: w.word.clone(),
                        start: w.start,
                        end: w.end,
                        text: w.text.clone(),
                        label: w.label.clone(),
                        peak_pos: w.peak_pos,
                        pitch_range: w.pitch_range,
                        slope: w.slope,
                    });
                }
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

pub(crate) fn run_whisper_model_impl(
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

pub(crate) fn run_whisper_uploaded_impl(
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

pub(crate) fn run_whisper_impl(
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
