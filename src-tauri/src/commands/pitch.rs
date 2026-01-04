use anyhow::Result;
use std::path::Path;
use tauri::AppHandle;

mod analysis;
mod features;
mod paths;
mod praat;
mod types;
mod wav;
mod yin;

pub use types::PitchAnalysis;

use analysis::build_segments_words;
use features::normalize_log2;
use praat::extract_f0_with_praat;
use wav::{read_wav_mono_f32, read_wav_sample_rate};
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
    (|| -> Result<PitchAnalysis> {
        let wav_path = Path::new(&wav_path);
        let time_step = time_step.unwrap_or(0.01).max(0.001);
        let pitch_floor = pitch_floor.unwrap_or(75.0).max(20.0);
        let pitch_ceiling = pitch_ceiling.unwrap_or(500.0).max(pitch_floor + 10.0);
        let include_segments = include_segments.unwrap_or(true);

        // Sample rate is used for display; Praat extraction doesn't require loading all samples.
        let sample_rate = read_wav_sample_rate(wav_path)?;

        // Prefer Praat when bundled (or available on PATH). If it fails for any reason,
        // fall back to the built-in YIN implementation.
        let (extractor, f0_hz) = match extract_f0_with_praat(
            &app,
            wav_path,
            time_step,
            pitch_floor,
            pitch_ceiling,
        ) {
            Ok(v) => (Some("praat".to_string()), v),
            Err(e) => {
                eprintln!("[pitch] Praat extraction failed; falling back to YIN: {}", e);
                let (samples, sr) = read_wav_mono_f32(wav_path)?;
                (Some("yin".to_string()), extract_f0_with_yin(&samples, sr, time_step, pitch_floor, pitch_ceiling)?)
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
// This always uses the built-in YIN implementation.
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
        let f0_hz = extract_f0_with_yin(&samples, sample_rate, time_step, pitch_floor, pitch_ceiling)?;
        let f0_rel = normalize_log2(&f0_hz)?;
        let (segments, words) = build_segments_words(wav_path, time_step, &f0_rel, include_segments)?;

        Ok(PitchAnalysis {
            extractor: Some("yin".to_string()),
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
