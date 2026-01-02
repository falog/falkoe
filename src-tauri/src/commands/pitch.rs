use anyhow::{bail, Result};
use hound;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct SegmentPitch {
    pub start: f32,
    pub end: f32,
    pub text: String,
    pub label: Option<String>,
    pub peak_pos: Option<f32>,
    pub pitch_range: Option<f32>,
    pub slope: Option<f32>,
}

#[derive(Serialize)]
pub struct WordPitch {
    pub start: f32,
    pub end: f32,
    // Backward/UX: some consumers want an explicit "word" key.
    // Keep both `word` and `text` (same value).
    pub word: String,
    pub text: String,
    pub label: Option<String>,
    pub peak_pos: Option<f32>,
    pub pitch_range: Option<f32>,
    pub slope: Option<f32>,
}

#[derive(Serialize)]
pub struct PitchAnalysis {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extractor: Option<String>,
    pub time_step: f32,
    pub sample_rate: u32,
    pub f0_hz: Vec<Option<f32>>,   // Hz
    pub f0_rel: Vec<Option<f32>>,  // log2-normalized (mean=0,std=1) over voiced frames
    pub segments: Option<Vec<SegmentPitch>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<WordPitch>>,
}

#[derive(Deserialize)]
struct Transcript {
    segments: Vec<TranscriptSegment>,
    #[serde(default)]
    words: Vec<TranscriptWord>,
}

#[derive(Deserialize)]
struct TranscriptSegment {
    start: f32,
    end: f32,
    text: String,
}

#[derive(Deserialize)]
struct TranscriptWord {
    start: f32,
    end: f32,
    text: String,
}

fn estimate_accent_label(peak_pos: f32, pitch_range: f32) -> String {
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

fn time_to_index_floor(t: f32, time_step: f32) -> usize {
    ((t / time_step).floor() as i64).max(0) as usize
}

fn time_to_index_ceil(t: f32, time_step: f32) -> usize {
    ((t / time_step).ceil() as i64).max(0) as usize
}

fn adjust_span_to_voiced(
    mut si: usize,
    mut ei: usize,
    f0_rel: &[Option<f32>],
    expand_frames: usize,
) -> Option<(usize, usize)> {
    if f0_rel.is_empty() {
        return None;
    }

    si = si.min(f0_rel.len().saturating_sub(1));
    ei = ei.min(f0_rel.len());
    if ei <= si {
        return None;
    }

    let mut has_voiced = false;
    for v in &f0_rel[si..ei] {
        if v.is_some() {
            has_voiced = true;
            break;
        }
    }

    if !has_voiced {
        let new_si = si.saturating_sub(expand_frames);
        let new_ei = (ei + expand_frames).min(f0_rel.len());
        if new_ei <= new_si {
            return None;
        }

        let mut ok = false;
        for v in &f0_rel[new_si..new_ei] {
            if v.is_some() {
                ok = true;
                break;
            }
        }
        if !ok {
            return None;
        }
        si = new_si;
        ei = new_ei;
    }

    // snap to first/last voiced within the window
    let mut first = None;
    let mut last = None;
    for i in si..ei {
        if f0_rel[i].is_some() {
            first = Some(i);
            break;
        }
    }
    for i in (si..ei).rev() {
        if f0_rel[i].is_some() {
            last = Some(i);
            break;
        }
    }
    let (first, last) = (first?, last?);
    let adj_si = first;
    let adj_ei = (last + 1).min(f0_rel.len());
    if adj_ei <= adj_si {
        return None;
    }
    Some((adj_si, adj_ei))
}

fn read_wav_mono_f32(path: &Path) -> Result<(Vec<f32>, u32)> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let sample_rate = spec.sample_rate;

    if channels == 0 {
        bail!("invalid wav: channels=0");
    }

    let mut mono = Vec::<f32>::new();

    match spec.sample_format {
        hound::SampleFormat::Int => {
            // Most of our pipeline uses i16.
            // Convert to [-1, 1].
            if spec.bits_per_sample == 16 {
                let mut frame = Vec::<f32>::with_capacity(channels);
                for s in reader.samples::<i16>() {
                    frame.push(s? as f32 / i16::MAX as f32);
                    if frame.len() == channels {
                        let sum: f32 = frame.iter().sum();
                        mono.push(sum / channels as f32);
                        frame.clear();
                    }
                }
            } else if spec.bits_per_sample == 32 {
                let mut frame = Vec::<f32>::with_capacity(channels);
                for s in reader.samples::<i32>() {
                    frame.push(s? as f32 / i32::MAX as f32);
                    if frame.len() == channels {
                        let sum: f32 = frame.iter().sum();
                        mono.push(sum / channels as f32);
                        frame.clear();
                    }
                }
            } else {
                bail!("unsupported int wav bits_per_sample={}", spec.bits_per_sample);
            }
        }
        hound::SampleFormat::Float => {
            // Usually f32
            let mut frame = Vec::<f32>::with_capacity(channels);
            for s in reader.samples::<f32>() {
                frame.push(s?);
                if frame.len() == channels {
                    let sum: f32 = frame.iter().sum();
                    mono.push(sum / channels as f32);
                    frame.clear();
                }
            }
        }
    }

    Ok((mono, sample_rate))
}

fn read_wav_sample_rate(path: &Path) -> Result<u32> {
    let reader = hound::WavReader::open(path)?;
    Ok(reader.spec().sample_rate)
}

fn resolve_bundled_tool(app: &AppHandle, base_name: &str) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let exe_name = if cfg!(target_os = "windows") {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    };

    // In production bundles, resource_dir typically points at the resources dir.
    // In dev, it can point at `target/debug` while resources are synced to `target/debug/resources`.
    let candidates = [
        // bundle layout
        resource_dir.join("bin").join(&exe_name),
        resource_dir.join(&exe_name),
        // dev layout
        resource_dir.join("resources").join("bin").join(&exe_name),
        resource_dir.join("resources").join(&exe_name),
    ];

    candidates.into_iter().find(|p| p.exists())
}

fn resolve_praat_cmd_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();

    // Prefer bundled console build.
    if let Some(p) = resolve_bundled_tool(app, "praatcon") {
        out.push(p);
    }
    if let Some(p) = resolve_bundled_tool(app, "praat") {
        out.push(p);
    }

    // Then try PATH (console first).
    if cfg!(target_os = "windows") {
        out.push(PathBuf::from("praatcon.exe"));
        out.push(PathBuf::from("praat.exe"));
    } else {
        out.push(PathBuf::from("praatcon"));
        out.push(PathBuf::from("praat"));
    }

    out
}

fn resolve_praat_script(app: &AppHandle) -> Result<PathBuf> {
    let resource_dir = app.path().resource_dir()?;
    let candidates = [
        // workspace layout (dev): src-tauri/resources/...
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("praat")
            .join("extract_pitch_to_tsv.praat"),
        // bundle layout
        resource_dir
            .join("praat")
            .join("extract_pitch_to_tsv.praat"),
        // dev layout
        resource_dir
            .join("resources")
            .join("praat")
            .join("extract_pitch_to_tsv.praat"),
    ];

    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!(
            "praat script not found; tried: {} | {} | {}",
            candidates[0].display(),
            candidates[1].display(),
            candidates[2].display(),
        ))
}

fn extract_f0_with_praat(
    app: &AppHandle,
    wav_path: &Path,
    time_step: f32,
    pitch_floor: f32,
    pitch_ceiling: f32,
) -> Result<Vec<Option<f32>>> {
    let script = resolve_praat_script(app)?;

    if !script.exists() {
        bail!("praat script not found: {}", script.display());
    }

    let out_path = std::env::temp_dir().join(format!(
        "falkoe_praat_pitch_{}_{}.tsv",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));

    let script_s = script
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid praat script path"))?
        .to_string();
    let wav_s = wav_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid wav path"))?
        .to_string();
    let out_s = out_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid out path"))?
        .to_string();

    // Praat scripts with a `form` can be called by passing arguments in order.
    // Try multiple candidates because some installs only provide GUI praat (or it fails in headless).
    let mut errors: Vec<String> = Vec::new();
    let mut ok = false;
    for praat in resolve_praat_cmd_candidates(app) {
        let output = Command::new(&praat)
            .args([
                "--run",
                &script_s,
                &wav_s,
                &out_s,
                &format!("{time_step}"),
                &format!("{pitch_floor}"),
                &format!("{pitch_ceiling}"),
            ])
            .output();

        match output {
            Ok(out) if out.status.success() => {
                ok = true;
                break;
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let stdout = String::from_utf8_lossy(&out.stdout);
                errors.push(format!(
                    "- cmd={:?}\n  status={}\n  stdout={}\n  stderr={}",
                    praat,
                    out.status,
                    stdout.trim(),
                    stderr.trim()
                ));
            }
            Err(e) => {
                errors.push(format!("- cmd={:?}\n  error={}", praat, e));
            }
        }
    }

    if !ok {
        let combined = if errors.is_empty() {
            "(no candidates tried)".to_string()
        } else {
            errors.join("\n")
        };
        bail!(
            "praat failed (script={}, wav={})\n{}",
            script.display(),
            wav_path.display(),
            combined
        );
    }

    let tsv = fs::read_to_string(&out_path)?;
    let _ = fs::remove_file(&out_path);

    let mut out = Vec::new();
    for (i, line) in tsv.lines().enumerate() {
        if i == 0 {
            // header
            continue;
        }
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        let mut it = l.split('\t');
        let _t = it.next();
        let f0s = it.next().unwrap_or("");
        let f0s = f0s.trim();
        if f0s.is_empty() || f0s.eq_ignore_ascii_case("nan") {
            out.push(None);
            continue;
        }
        let v: f32 = f0s.parse()?;
        if v.is_finite() {
            out.push(Some(v));
        } else {
            out.push(None);
        }
    }

    if out.is_empty() {
        bail!("praat returned empty pitch");
    }
    Ok(out)
}

fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    let mut acc = 0.0f32;
    for &v in x {
        acc += v * v;
    }
    (acc / x.len() as f32).sqrt()
}

// Minimal YIN implementation.
fn yin_f0(
    frame: &[f32],
    sample_rate: u32,
    pitch_floor: f32,
    pitch_ceiling: f32,
) -> Option<f32> {
    if frame.len() < 32 {
        return None;
    }

    let sr = sample_rate as f32;
    let tau_min = (sr / pitch_ceiling).floor().max(2.0) as usize;
    let tau_max = (sr / pitch_floor).ceil() as usize;

    if tau_max + 2 >= frame.len() {
        return None;
    }

    // Silence gate (slightly relaxed to catch softer onsets)
    if rms(frame) < 0.0015 {
        return None;
    }

    let n = frame.len();
    let mut diff = vec![0.0f32; tau_max + 1];

    for tau in 1..=tau_max {
        let mut sum = 0.0f32;
        let limit = n - tau;
        for j in 0..limit {
            let d = frame[j] - frame[j + tau];
            sum += d * d;
        }
        diff[tau] = sum;
    }

    // CMND
    let mut cmnd = vec![1.0f32; tau_max + 1];
    let mut running_sum = 0.0f32;
    for tau in 1..=tau_max {
        running_sum += diff[tau];
        if running_sum > 0.0 {
            cmnd[tau] = diff[tau] * (tau as f32) / running_sum;
        } else {
            cmnd[tau] = 1.0;
        }
    }

    // absolute threshold
    let threshold = 0.1f32;
    let mut tau = None;
    for t in tau_min..=tau_max {
        if cmnd[t] < threshold {
            // local minimum
            let next = if t + 1 <= tau_max { cmnd[t + 1] } else { 1.0 };
            if next > cmnd[t] {
                tau = Some(t);
                break;
            }
        }
    }

    let tau = tau?;

    // Parabolic interpolation around tau using cmnd
    let x0 = if tau > 1 { tau - 1 } else { tau };
    let x2 = if tau + 1 <= tau_max { tau + 1 } else { tau };

    let s0 = cmnd[x0];
    let s1 = cmnd[tau];
    let s2 = cmnd[x2];

    let denom = 2.0 * s1 - s2 - s0;
    let tau_refined = if denom.abs() > 1e-6 {
        tau as f32 + (s2 - s0) / (2.0 * denom)
    } else {
        tau as f32
    };

    if tau_refined <= 0.0 {
        return None;
    }

    let f0 = sr / tau_refined;
    if f0 < pitch_floor || f0 > pitch_ceiling {
        return None;
    }

    Some(f0)
}

fn normalize_log2(f0_hz: &[Option<f32>]) -> Result<Vec<Option<f32>>> {
    let mut log2_vals: Vec<f32> = Vec::new();
    log2_vals.reserve(f0_hz.len());

    for &v in f0_hz {
        if let Some(hz) = v {
            if hz > 0.0 {
                log2_vals.push(hz.log2());
            }
        }
    }

    if log2_vals.len() < 10 {
        bail!("voiced frames too short");
    }

    let mean = log2_vals.iter().sum::<f32>() / log2_vals.len() as f32;
    let var = log2_vals
        .iter()
        .map(|x| {
            let d = x - mean;
            d * d
        })
        .sum::<f32>()
        / log2_vals.len() as f32;
    let std = var.sqrt().max(1e-6);

    let mut out = Vec::with_capacity(f0_hz.len());
    for &v in f0_hz {
        if let Some(hz) = v {
            if hz > 0.0 {
                out.push(Some((hz.log2() - mean) / std));
            } else {
                out.push(None);
            }
        } else {
            out.push(None);
        }
    }

    Ok(out)
}

fn segment_features(seg: &[f32]) -> (f32, f32, f32) {
    // peak_pos, pitch_range, slope
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
    let peak_pos = if seg.len() > 0 {
        peak_i as f32 / seg.len() as f32
    } else {
        0.0
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

fn transcript_json_path(wav_path: &Path) -> PathBuf {
    wav_path.with_extension("json")
}

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
                eprintln!(
                    "[pitch] Praat extraction failed; falling back to YIN: {}",
                    e
                );
                let (samples, sample_rate) = read_wav_mono_f32(wav_path)?;

                let hop = (time_step * sample_rate as f32).round() as usize;
                if hop < 1 {
                    bail!("invalid time_step");
                }

                // Window: 50ms (roughly), but ensure it covers tau_max * 2.
                let tau_max = (sample_rate as f32 / pitch_floor).ceil() as usize;
                let min_win = (tau_max * 2 + 2).max(256);
                let win = min_win.max((0.05 * sample_rate as f32).round() as usize);

                let mut f0_hz = Vec::<Option<f32>>::new();
                let mut pos = 0usize;
                while pos + win <= samples.len() {
                    let frame = &samples[pos..pos + win];
                    let f0 = yin_f0(frame, sample_rate, pitch_floor, pitch_ceiling);
                    f0_hz.push(f0);
                    pos += hop;
                }
                (Some("yin".to_string()), f0_hz)
            }
        };

        let f0_rel = normalize_log2(&f0_hz)?;

        let (segments, words) = if include_segments.unwrap_or(true) {
            let tj = transcript_json_path(wav_path);
            if tj.exists() {
                let s = fs::read_to_string(&tj)?;
                let t: Transcript = serde_json::from_str(&s)?;

                let mut segments_out = Vec::with_capacity(t.segments.len());
                for seg in &t.segments {
                    let si = time_to_index_floor(seg.start, time_step);
                    let ei = time_to_index_ceil(seg.end, time_step);

                    if si >= f0_rel.len() || ei <= si {
                        segments_out.push(SegmentPitch {
                            start: seg.start,
                            end: seg.end,
                            text: seg.text.clone(),
                            label: None,
                            peak_pos: None,
                            pitch_range: None,
                            slope: None,
                        });
                        continue;
                    }

                    let base_ei = ei.min(f0_rel.len());
                    let base_slice = if si < base_ei { &f0_rel[si..base_ei] } else { &[] };
                    let mut voiced: Vec<f32> = base_slice.iter().copied().flatten().collect();

                    // If there are no voiced frames inside the original segment span, expand and snap.
                    if voiced.is_empty() {
                        let adj = adjust_span_to_voiced(si, base_ei, &f0_rel, 8);
                        let Some((adj_si, adj_ei)) = adj else {
                            segments_out.push(SegmentPitch {
                                start: seg.start,
                                end: seg.end,
                                text: seg.text.clone(),
                                label: None,
                                peak_pos: None,
                                pitch_range: None,
                                slope: None,
                            });
                            continue;
                        };

                        let slice = &f0_rel[adj_si..adj_ei];
                        voiced = slice.iter().copied().flatten().collect();
                    }

                    let (peak_pos, pitch_range, slope) = segment_features(&voiced);
                    let label = estimate_accent_label(peak_pos, pitch_range);

                    segments_out.push(SegmentPitch {
                        start: seg.start,
                        end: seg.end,
                        text: seg.text.clone(),
                        label: Some(label),
                        peak_pos: Some(peak_pos),
                        pitch_range: Some(pitch_range),
                        slope: Some(slope),
                    });
                }

                let words_out = if t.words.is_empty() {
                    None
                } else {
                    let mut out = Vec::with_capacity(t.words.len());

                    for w in &t.words {
                        let si = time_to_index_floor(w.start, time_step);
                        let ei = time_to_index_ceil(w.end, time_step);

                        if si >= f0_rel.len() || ei <= si {
                            out.push(WordPitch {
                                start: w.start,
                                end: w.end,
                                word: w.text.clone(),
                                text: w.text.clone(),
                                label: None,
                                peak_pos: None,
                                pitch_range: None,
                                slope: None,
                            });
                            continue;
                        }

                        let base_ei = ei.min(f0_rel.len());
                        let base_slice = if si < base_ei { &f0_rel[si..base_ei] } else { &[] };
                        let mut voiced: Vec<f32> = base_slice.iter().copied().flatten().collect();

                        // If there are no voiced frames inside the original word span, expand and snap.
                        if voiced.is_empty() {
                            let adj = adjust_span_to_voiced(si, base_ei, &f0_rel, 8);
                            let Some((adj_si, adj_ei)) = adj else {
                                out.push(WordPitch {
                                    start: w.start,
                                    end: w.end,
                                    word: w.text.clone(),
                                    text: w.text.clone(),
                                    label: None,
                                    peak_pos: None,
                                    pitch_range: None,
                                    slope: None,
                                });
                                continue;
                            };

                            let slice = &f0_rel[adj_si..adj_ei];
                            voiced = slice.iter().copied().flatten().collect();
                        }

                        let (peak_pos, pitch_range, slope) = segment_features(&voiced);
                        let label = estimate_accent_label(peak_pos, pitch_range);

                        out.push(WordPitch {
                            start: w.start,
                            end: w.end,
                            word: w.text.clone(),
                            text: w.text.clone(),
                            label: Some(label),
                            peak_pos: Some(peak_pos),
                            pitch_range: Some(pitch_range),
                            slope: Some(slope),
                        });
                    }

                    Some(out)
                };

                (Some(segments_out), words_out)
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

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
        let (samples, sample_rate) = read_wav_mono_f32(wav_path)?;

        let time_step = time_step.unwrap_or(0.01).max(0.001);
        let pitch_floor = pitch_floor.unwrap_or(75.0).max(20.0);
        let pitch_ceiling = pitch_ceiling.unwrap_or(500.0).max(pitch_floor + 10.0);

        let hop = (time_step * sample_rate as f32).round() as usize;
        if hop < 1 {
            bail!("invalid time_step");
        }

        // Window: 50ms (roughly), but ensure it covers tau_max * 2.
        let tau_max = (sample_rate as f32 / pitch_floor).ceil() as usize;
        let min_win = (tau_max * 2 + 2).max(256);
        let win = min_win.max((0.05 * sample_rate as f32).round() as usize);

        let mut f0_hz = Vec::<Option<f32>>::new();
        let mut pos = 0usize;
        while pos + win <= samples.len() {
            let frame = &samples[pos..pos + win];
            let f0 = yin_f0(frame, sample_rate, pitch_floor, pitch_ceiling);
            f0_hz.push(f0);
            pos += hop;
        }

        let f0_rel = normalize_log2(&f0_hz)?;

        let (segments, words) = if include_segments.unwrap_or(true) {
            let tj = transcript_json_path(wav_path);
            if tj.exists() {
                let s = fs::read_to_string(&tj)?;
                let t: Transcript = serde_json::from_str(&s)?;

                let mut segments_out = Vec::with_capacity(t.segments.len());
                for seg in &t.segments {
                    let si = time_to_index_floor(seg.start, time_step);
                    let ei = time_to_index_ceil(seg.end, time_step);

                    if si >= f0_rel.len() || ei <= si {
                        segments_out.push(SegmentPitch {
                            start: seg.start,
                            end: seg.end,
                            text: seg.text.clone(),
                            label: None,
                            peak_pos: None,
                            pitch_range: None,
                            slope: None,
                        });
                        continue;
                    }

                    let base_ei = ei.min(f0_rel.len());
                    let base_slice = if si < base_ei { &f0_rel[si..base_ei] } else { &[] };
                    let mut voiced: Vec<f32> = base_slice.iter().copied().flatten().collect();

                    if voiced.is_empty() {
                        let adj = adjust_span_to_voiced(si, base_ei, &f0_rel, 8);
                        let Some((adj_si, adj_ei)) = adj else {
                            segments_out.push(SegmentPitch {
                                start: seg.start,
                                end: seg.end,
                                text: seg.text.clone(),
                                label: None,
                                peak_pos: None,
                                pitch_range: None,
                                slope: None,
                            });
                            continue;
                        };

                        let slice = &f0_rel[adj_si..adj_ei];
                        voiced = slice.iter().copied().flatten().collect();
                    }

                    let (peak_pos, pitch_range, slope) = segment_features(&voiced);
                    let label = estimate_accent_label(peak_pos, pitch_range);

                    segments_out.push(SegmentPitch {
                        start: seg.start,
                        end: seg.end,
                        text: seg.text.clone(),
                        label: Some(label),
                        peak_pos: Some(peak_pos),
                        pitch_range: Some(pitch_range),
                        slope: Some(slope),
                    });
                }

                let words_out = if t.words.is_empty() {
                    None
                } else {
                    let mut out = Vec::with_capacity(t.words.len());

                    for w in &t.words {
                        let si = time_to_index_floor(w.start, time_step);
                        let ei = time_to_index_ceil(w.end, time_step);

                        if si >= f0_rel.len() || ei <= si {
                            out.push(WordPitch {
                                start: w.start,
                                end: w.end,
                                word: w.text.clone(),
                                text: w.text.clone(),
                                label: None,
                                peak_pos: None,
                                pitch_range: None,
                                slope: None,
                            });
                            continue;
                        }

                        let base_ei = ei.min(f0_rel.len());
                        let base_slice = if si < base_ei { &f0_rel[si..base_ei] } else { &[] };
                        let mut voiced: Vec<f32> = base_slice.iter().copied().flatten().collect();

                        if voiced.is_empty() {
                            let adj = adjust_span_to_voiced(si, base_ei, &f0_rel, 8);
                            let Some((adj_si, adj_ei)) = adj else {
                                out.push(WordPitch {
                                    start: w.start,
                                    end: w.end,
                                    word: w.text.clone(),
                                    text: w.text.clone(),
                                    label: None,
                                    peak_pos: None,
                                    pitch_range: None,
                                    slope: None,
                                });
                                continue;
                            };

                            let slice = &f0_rel[adj_si..adj_ei];
                            voiced = slice.iter().copied().flatten().collect();
                        }

                        let (peak_pos, pitch_range, slope) = segment_features(&voiced);
                        let label = estimate_accent_label(peak_pos, pitch_range);

                        out.push(WordPitch {
                            start: w.start,
                            end: w.end,
                            word: w.text.clone(),
                            text: w.text.clone(),
                            label: Some(label),
                            peak_pos: Some(peak_pos),
                            pitch_range: Some(pitch_range),
                            slope: Some(slope),
                        });
                    }

                    Some(out)
                };

                (Some(segments_out), words_out)
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

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
