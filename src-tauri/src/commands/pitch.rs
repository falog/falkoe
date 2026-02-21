use anyhow::Result;
use std::path::Path;
use tauri::AppHandle;

mod analysis;
mod features;
mod paths;
mod praat;
mod praat_ac;
mod types;
mod wav;
mod world;
mod yin;

pub use types::PitchAnalysis;

use analysis::build_segments_words;
use features::normalize_log2;
use praat::extract_f0_with_praat;
use praat_ac::extract_f0_praat_ac;
use wav::read_wav_mono_f32;
use world::extract_f0_with_world;
use yin::extract_f0_with_yin;

#[tauri::command]
pub fn analyze_pitch(
    app: AppHandle,
    wav_path: String,
    time_step: Option<f32>,
    pitch_floor: Option<f32>,
    pitch_ceiling: Option<f32>,
    include_segments: Option<bool>,
) -> Result<PitchAnalysis, String> {
    fn debug_external_tools_enabled() -> bool {
        std::env::var("FALKOE_DEBUG_EXTERNAL_TOOLS")
            .ok()
            .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    }

    (|| -> Result<PitchAnalysis> {
        let wav_path = Path::new(&wav_path);
        let time_step = time_step.unwrap_or(0.01).max(0.001);
        let pitch_floor = pitch_floor.unwrap_or(75.0).max(20.0);
        let pitch_ceiling = pitch_ceiling.unwrap_or(500.0).max(pitch_floor + 10.0);
        let include_segments = include_segments.unwrap_or(true);

        let (samples, sample_rate) = read_wav_mono_f32(wav_path)?;

        // ── Extraction cascade ──────────────────────────────────────────
        //
        // 1. Native Praat AC  – works on every platform (including Android)
        // 2. External Praat   – desktop only; higher fidelity when bundled
        // 3. External WORLD   – desktop only; optional helper binary
        // 4. Built-in YIN     – final fallback

        let (extractor, f0_hz) = match extract_f0_praat_ac(
            &samples,
            sample_rate,
            time_step,
            pitch_floor,
            pitch_ceiling,
        ) {
            Ok(v) => (Some("praat-ac".to_string()), v),
            Err(e_ac) => {
                if debug_external_tools_enabled() {
                    crate::logging::log_line(
                        &app,
                        format!(
                            "[pitch] Native Praat-AC failed; trying external Praat: {}",
                            e_ac
                        ),
                    );
                } else {
                    crate::logging::log_line(&app, "[pitch] Native Praat-AC failed; trying external Praat");
                }
                match extract_f0_with_praat(
                    &app,
                    wav_path,
                    time_step,
                    pitch_floor,
                    pitch_ceiling,
                ) {
                    Ok(v) => (Some("praat".to_string()), v),
                    Err(e_praat) => {
                        if debug_external_tools_enabled() {
                            crate::logging::log_line(
                                &app,
                                format!(
                                    "[pitch] External Praat failed; trying WORLD helper: {}",
                                    e_praat
                                ),
                            );
                        } else {
                            crate::logging::log_line(&app, "[pitch] External Praat failed; trying WORLD helper");
                        }
                        match extract_f0_with_world(&app, wav_path, time_step, pitch_floor, pitch_ceiling)
                        {
                            Ok(v) => (Some("world".to_string()), v),
                            Err(e_world) => {
                                if debug_external_tools_enabled() {
                                    crate::logging::log_line(
                                        &app,
                                        format!(
                                            "[pitch] WORLD extraction failed; falling back to YIN: {}",
                                            e_world
                                        ),
                                    );
                                } else {
                                    crate::logging::log_line(&app, "[pitch] WORLD extraction failed; falling back to YIN");
                                }
                                (
                                    Some("yin".to_string()),
                                    extract_f0_with_yin(&samples, sample_rate, time_step, pitch_floor, pitch_ceiling)?,
                                )
                            }
                        }
                    }
                }
            }
        };

        let f0_rel = normalize_log2(&f0_hz)?;
        let (segments, words) = build_segments_words(wav_path, time_step, &f0_rel, include_segments)?;

        Ok(PitchAnalysis {
            extractor,
            time_step,
            sample_rate,
            f0_hz,
            f0_rel,
            segments,
            words,
        })
    })()
    .map_err(|e| e.to_string())
}

// Internal/helper entrypoint for CLI tools that don't have a Tauri AppHandle.
// Uses native Praat-AC, falling back to YIN.
pub fn analyze_pitch_noapp(
    wav_path: String,
    time_step: Option<f32>,
    pitch_floor: Option<f32>,
    pitch_ceiling: Option<f32>,
    include_segments: Option<bool>,
) -> Result<PitchAnalysis, String> {
    (|| -> Result<PitchAnalysis> {
        let wav_path = Path::new(&wav_path);
        let time_step = time_step.unwrap_or(0.01).max(0.001);
        let pitch_floor = pitch_floor.unwrap_or(75.0).max(20.0);
        let pitch_ceiling = pitch_ceiling.unwrap_or(500.0).max(pitch_floor + 10.0);
        let include_segments = include_segments.unwrap_or(true);

        let (samples, sample_rate) = read_wav_mono_f32(wav_path)?;

        let (extractor, f0_hz) = match extract_f0_praat_ac(&samples, sample_rate, time_step, pitch_floor, pitch_ceiling) {
            Ok(v) => ("praat-ac", v),
            Err(_) => {
                let v = extract_f0_with_yin(&samples, sample_rate, time_step, pitch_floor, pitch_ceiling)?;
                ("yin", v)
            }
        };
        let f0_rel = normalize_log2(&f0_hz)?;
        let (segments, words) = build_segments_words(wav_path, time_step, &f0_rel, include_segments)?;

        Ok(PitchAnalysis {
            extractor: Some(extractor.to_string()),
            time_step,
            sample_rate,
            f0_hz,
            f0_rel,
            segments,
            words,
        })
    })()
    .map_err(|e| e.to_string())
}
