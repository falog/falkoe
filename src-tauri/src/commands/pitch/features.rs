use anyhow::{bail, Result};

pub(crate) fn estimate_accent_label(peak_pos: f32, pitch_range: f32) -> String {
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

pub(crate) fn time_to_index_floor(t: f32, time_step: f32) -> usize {
    ((t / time_step).floor() as i64).max(0) as usize
}

pub(crate) fn time_to_index_ceil(t: f32, time_step: f32) -> usize {
    ((t / time_step).ceil() as i64).max(0) as usize
}

pub(crate) fn adjust_span_to_voiced(
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

pub(crate) fn normalize_log2(f0_hz: &[Option<f32>]) -> Result<Vec<Option<f32>>> {
    let mut log2_vals: Vec<f32> = Vec::new();
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

pub(crate) fn segment_features(seg: &[f32]) -> (f32, f32, f32) {
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
    let peak_pos = if !seg.is_empty() {
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
