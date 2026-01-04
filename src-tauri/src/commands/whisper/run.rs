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

            // Japanese tokenization helper input (avoid inserting spaces between segments).
            let mecab_text_ja = transcript
                .segments
                .iter()
                .map(|s| s.text.trim())
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("");

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

                t.chars().all(|c| {
                    c.is_ascii_punctuation()
                        || matches!(
                            c,
                            '。' | '、' | '！' | '？' | '…' | '・' | '「' | '」' | '『' | '』' | '（'
                                | '）' | '【' | '】' | '［' | '］' | '〔' | '〕' | '〈' | '〉' | '《'
                                | '》' | '“' | '”' | '‘' | '’' | '：' | '；'
                        )
                })
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
                        Some(estimate_accent_label_py(pp, pr)),
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
                        Some(estimate_accent_label_py(pp, pr)),
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
                // Try MeCab first (if installed) to re-tokenize and align onto Whisper word times.
                let mecab_wordlikes = t_words
                    .iter()
                    .map(|w| super::mecab::WordLike {
                        start: w.start,
                        end: w.end,
                        text: w.text.clone(),
                    })
                    .collect::<Vec<_>>();

                if let Some(mecab_tokens) =
                    super::mecab::mecab_timed_tokens(&mecab_text_ja, &mecab_wordlikes)
                {
                    println!("[accent] mecab used: {} tokens", mecab_tokens.len());
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
                    if std::env::var("FALKOE_DEBUG_MECAB").is_ok() {
                        println!("[accent] mecab not used; fallback to whisper word boundaries");
                    }
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
