/// Native Rust implementation of Praat's autocorrelation-based pitch detection
/// ("To Pitch (ac)..." in Praat).
///
/// Based on: Boersma, P. (1993). "Accurate short-term analysis of the
/// fundamental frequency and the harmonics-to-noise ratio of a sampled sound."
///
/// This allows pitch extraction on all platforms (including Android) without
/// requiring an external Praat binary.

use anyhow::{bail, Result};

// ── Default parameters matching Praat's "To Pitch (ac)..." ──────────────────

const MAX_CANDIDATES: usize = 15;
const SILENCE_THRESHOLD: f32 = 0.03;
const VOICING_THRESHOLD: f32 = 0.45;
const OCTAVE_COST: f32 = 0.01;
const OCTAVE_JUMP_COST: f32 = 0.35;
const VOICED_UNVOICED_COST: f32 = 0.14;

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Candidate {
    frequency: f32, // 0 = unvoiced
    strength: f32,
}

struct Frame {
    candidates: Vec<Candidate>,
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Symmetric Hanning window.
fn hanning_window(n: usize) -> Vec<f32> {
    let mut w = vec![0.0f32; n];
    if n <= 1 {
        if n == 1 {
            w[0] = 1.0;
        }
        return w;
    }
    let factor = 2.0 * std::f32::consts::PI / (n as f32 - 1.0);
    for i in 0..n {
        w[i] = 0.5 * (1.0 - (factor * i as f32).cos());
    }
    w
}

/// Direct autocorrelation up to `max_lag` (inclusive).
/// Returns a vector of length `max_lag + 1`.
fn autocorrelation(x: &[f32], max_lag: usize) -> Vec<f32> {
    let n = x.len();
    let max_lag = max_lag.min(n.saturating_sub(1));
    let mut r = vec![0.0f32; max_lag + 1];
    for tau in 0..=max_lag {
        let mut sum = 0.0f64; // accumulate in f64 for precision
        let limit = n - tau;
        for i in 0..limit {
            sum += x[i] as f64 * x[i + tau] as f64;
        }
        r[tau] = sum as f32;
    }
    r
}

/// Root-mean-square of a slice.
fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    let mut acc = 0.0f64;
    for &v in x {
        acc += v as f64 * v as f64;
    }
    (acc / x.len() as f64).sqrt() as f32
}

// ── Core algorithm ──────────────────────────────────────────────────────────

/// Extract F0 using Praat's autocorrelation method (native Rust implementation).
///
/// This closely follows Praat's "To Pitch (ac)..." with `very_accurate = false`.
pub(crate) fn extract_f0_praat_ac(
    samples: &[f32],
    sample_rate: u32,
    time_step: f32,
    pitch_floor: f32,
    pitch_ceiling: f32,
) -> Result<Vec<Option<f32>>> {
    let sr = sample_rate as f32;

    // Window duration: 3 periods of the lowest pitch (Praat default for non-accurate mode).
    let window_duration = 3.0 / pitch_floor;
    let mut window_samples = (window_duration * sr).round() as usize;
    // Ensure odd for symmetric centering.
    if window_samples % 2 == 0 {
        window_samples += 1;
    }
    if window_samples < 8 {
        bail!("window too small for given pitch_floor / sample_rate");
    }

    let hop = (time_step * sr).round() as usize;
    if hop < 1 {
        bail!("invalid time_step");
    }

    let lag_min = (sr / pitch_ceiling).floor().max(2.0) as usize;
    let lag_max = (sr / pitch_floor).ceil() as usize;

    if lag_max >= window_samples {
        bail!("lag_max exceeds window; raise pitch_floor or lower sample_rate");
    }

    // Pre-compute Hanning window and its autocorrelation.
    let window = hanning_window(window_samples);
    let window_ac = autocorrelation(&window, lag_max);

    // Global RMS for relative intensity computation.
    let global_rms = rms(samples);

    // ── Per-frame candidate extraction ──────────────────────────────────

    let half_win = window_samples / 2;
    let n_samples = samples.len();
    let mut frames: Vec<Frame> = Vec::new();

    let mut center = half_win;
    while center + half_win < n_samples {
        let start = center - half_win;

        // Local RMS (un-windowed) for silence/voicing decision.
        let local_rms = rms(&samples[start..start + window_samples]);

        // Relative power (intensity) ratio.
        let relative_power = if global_rms > 1e-15 {
            (local_rms / global_rms).min(1.0)
        } else {
            0.0
        };

        // Apply Hanning window and subtract mean from windowed segment.
        let mut windowed = vec![0.0f32; window_samples];
        let mut mean = 0.0f64;
        for i in 0..window_samples {
            let v = samples[start + i] * window[i];
            windowed[i] = v;
            mean += v as f64;
        }
        mean /= window_samples as f64;
        for v in &mut windowed {
            *v -= mean as f32;
        }

        // Autocorrelation of windowed signal.
        let signal_ac = autocorrelation(&windowed, lag_max);

        // Normalized autocorrelation: r[τ] = signal_ac[τ] / window_ac[τ]
        // Then normalize by r[0] so r_norm[0] = 1.
        let mut r_norm = vec![0.0f32; lag_max + 1];
        for tau in 0..=lag_max {
            if window_ac[tau].abs() > 1e-15 {
                r_norm[tau] = signal_ac[tau] / window_ac[tau];
            }
        }
        let r0 = if r_norm[0].abs() > 1e-15 {
            r_norm[0]
        } else {
            1.0
        };
        for v in &mut r_norm {
            *v /= r0;
        }

        // ── Candidate extraction ────────────────────────────────────────

        let mut candidates: Vec<Candidate> = Vec::with_capacity(MAX_CANDIDATES + 1);

        // Unvoiced candidate.
        // Praat: strength = voicing_threshold + 2 * silence_threshold *
        //        (1 − local_power / global_peak_power)
        // A higher silence_threshold input means quieter frames lean more
        // towards unvoiced.
        let unvoiced_strength =
            VOICING_THRESHOLD + 2.0 * SILENCE_THRESHOLD * (1.0 - relative_power);
        candidates.push(Candidate {
            frequency: 0.0,
            strength: unvoiced_strength.max(0.0),
        });

        // Voiced candidates: local maxima of r_norm in [lag_min, lag_max].
        let search_end = lag_max.min(r_norm.len().saturating_sub(2));
        if lag_min + 1 < search_end {
            for tau in (lag_min + 1)..search_end {
                if r_norm[tau] > r_norm[tau - 1] && r_norm[tau] >= r_norm[tau + 1] {
                    // Parabolic interpolation around the peak.
                    let a = r_norm[tau - 1];
                    let b = r_norm[tau];
                    let c = r_norm[tau + 1];
                    let denom = a + c - 2.0 * b;

                    let (better_tau, strength) = if denom.abs() > 1e-9 {
                        let delta = 0.5 * (a - c) / denom;
                        let peak = b - 0.25 * (a - c) * delta;
                        (tau as f32 + delta, peak)
                    } else {
                        (tau as f32, b)
                    };

                    if better_tau > 0.0 && strength > 0.0 {
                        let freq = sr / better_tau;
                        if freq >= pitch_floor && freq <= pitch_ceiling {
                            // Apply octave cost like Praat:
                            // penalize candidates far from the ceiling.
                            let adjusted_strength = strength
                                - OCTAVE_COST
                                    * (pitch_ceiling / freq).log2().abs();
                            candidates.push(Candidate {
                                frequency: freq,
                                strength: adjusted_strength,
                            });
                        }
                    }
                }
            }
        }

        // Keep top N candidates sorted by strength (descending).
        candidates.sort_by(|a, b| {
            b.strength
                .partial_cmp(&a.strength)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(MAX_CANDIDATES);

        frames.push(Frame { candidates });
        center += hop;
    }

    if frames.is_empty() {
        bail!("no frames extracted");
    }

    // ── Viterbi path finding ────────────────────────────────────────────

    let n_frames = frames.len();

    // best_cost[t][j] = minimum accumulated cost ending at candidate j of frame t.
    // best_prev[t][j] = which candidate index at frame t-1 led to that cost.
    let mut best_cost: Vec<Vec<f32>> = Vec::with_capacity(n_frames);
    let mut best_prev: Vec<Vec<usize>> = Vec::with_capacity(n_frames);

    // Initialize frame 0.
    {
        let frame = &frames[0];
        let costs: Vec<f32> = frame.candidates.iter().map(|c| -c.strength).collect();
        let prevs = vec![0usize; frame.candidates.len()];
        best_cost.push(costs);
        best_prev.push(prevs);
    }

    // Forward pass.
    for t in 1..n_frames {
        let prev_frame = &frames[t - 1];
        let curr_frame = &frames[t];

        let n_curr = curr_frame.candidates.len();
        let mut costs = vec![f32::MAX; n_curr];
        let mut prevs = vec![0usize; n_curr];

        for (j, curr_cand) in curr_frame.candidates.iter().enumerate() {
            for (i, prev_cand) in prev_frame.candidates.iter().enumerate() {
                let transition = transition_cost(prev_cand, curr_cand);
                let total = best_cost[t - 1][i] + transition - curr_cand.strength;

                if total < costs[j] {
                    costs[j] = total;
                    prevs[j] = i;
                }
            }
        }

        best_cost.push(costs);
        best_prev.push(prevs);
    }

    // Backtrace.
    let mut path = vec![0usize; n_frames];
    {
        let last_costs = &best_cost[n_frames - 1];
        let mut best_idx = 0;
        let mut best_val = f32::MAX;
        for (i, &c) in last_costs.iter().enumerate() {
            if c < best_val {
                best_val = c;
                best_idx = i;
            }
        }
        path[n_frames - 1] = best_idx;
    }

    for t in (0..n_frames - 1).rev() {
        path[t] = best_prev[t + 1][path[t + 1]];
    }

    // ── Convert to output ───────────────────────────────────────────────

    let result: Vec<Option<f32>> = (0..n_frames)
        .map(|t| {
            let cand = &frames[t].candidates[path[t]];
            if cand.frequency > 0.0 {
                Some(cand.frequency)
            } else {
                None
            }
        })
        .collect();

    Ok(result)
}

/// Compute transition cost between two candidates across consecutive frames.
fn transition_cost(prev: &Candidate, curr: &Candidate) -> f32 {
    let prev_voiced = prev.frequency > 0.0;
    let curr_voiced = curr.frequency > 0.0;

    if prev_voiced && curr_voiced {
        // Octave-jump cost.
        OCTAVE_JUMP_COST * (curr.frequency / prev.frequency).log2().abs()
    } else if prev_voiced != curr_voiced {
        // Voiced ↔ unvoiced transition cost.
        VOICED_UNVOICED_COST
    } else {
        // Both unvoiced: no transition cost.
        0.0
    }
}
