pub(crate) fn rms(x: &[f32]) -> f32 {
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
pub(crate) fn yin_f0(
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

    // Silence gate.
    // Too strict a threshold makes quiet recordings look "misaligned" because
    // we render word overlays but have no voiced f0 for the same time span.
    if rms(frame) < 0.015 {
        return None;
    }

    let n = frame.len();
    let mut diff = vec![0.0f32; tau_max + 1];

    for tau in 1..=tau_max {
        let mut sum = 0.0f32;
        let limit = n - tau;
        for i in 0..limit {
            let d = frame[i] - frame[i + tau];
            sum += d * d;
        }
        diff[tau] = sum;
    }

    let mut cmnd = vec![0.0f32; tau_max + 1];
    cmnd[0] = 1.0;

    let mut running_sum = 0.0f32;
    for tau in 1..=tau_max {
        running_sum += diff[tau];
        cmnd[tau] = if running_sum > 0.0 {
            diff[tau] * (tau as f32) / running_sum
        } else {
            1.0
        };
    }

    // Find first dip below threshold.
    let threshold = 0.1;
    let mut tau = tau_min;
    while tau < tau_max {
        if cmnd[tau] < threshold {
            // local minimum search
            while tau + 1 < tau_max && cmnd[tau + 1] < cmnd[tau] {
                tau += 1;
            }
            break;
        }
        tau += 1;
    }

    if tau >= tau_max {
        return None;
    }

    // Parabolic interpolation for better precision.
    let t0 = if tau > 1 { tau - 1 } else { tau };
    let t2 = if tau + 1 <= tau_max { tau + 1 } else { tau };

    let (a, b, c) = (cmnd[t0], cmnd[tau], cmnd[t2]);
    let denom = a + c - 2.0 * b;
    let better_tau = if denom.abs() > 1e-9 {
        tau as f32 + (a - c) / (2.0 * denom)
    } else {
        tau as f32
    };

    if better_tau <= 0.0 {
        return None;
    }

    let f0 = sr / better_tau;
    if f0 < pitch_floor || f0 > pitch_ceiling {
        return None;
    }
    Some(f0)
}

pub(crate) fn extract_f0_with_yin(
    samples: &[f32],
    sample_rate: u32,
    time_step: f32,
    pitch_floor: f32,
    pitch_ceiling: f32,
) -> anyhow::Result<Vec<Option<f32>>> {
    use anyhow::bail;

    let hop = (time_step * sample_rate as f32).round() as usize;
    if hop < 1 {
        bail!("invalid time_step");
    }

    // Window: 50ms (roughly), but ensure it covers tau_max * 2.
    let tau_max = (sample_rate as f32 / pitch_floor).ceil() as usize;
    let min_win = (tau_max * 2 + 2).max(256);
    let win = min_win.max((0.05 * sample_rate as f32).round() as usize);

    let mut out = Vec::<Option<f32>>::new();
    let mut pos = 0usize;
    while pos + win <= samples.len() {
        let frame = &samples[pos..pos + win];
        out.push(yin_f0(frame, sample_rate, pitch_floor, pitch_ceiling));
        pos += hop;
    }
    Ok(out)
}
