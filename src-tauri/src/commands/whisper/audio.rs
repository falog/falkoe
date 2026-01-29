use anyhow::{bail, Result};
use hound;
use log::{info, warn};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

pub fn load_wav_as_f32(path: &str) -> Result<Vec<f32>> {
    let file_size_bytes = std::fs::metadata(path).map(|m| m.len()).ok();
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();

    // ---------- read & mono ----------
    let mono: Vec<f32> = match (spec.channels, spec.sample_format) {
        (1, hound::SampleFormat::Int) => reader
            .samples::<i16>()
            .map(|s| Ok(s? as f32 / i16::MAX as f32))
            .collect::<Result<Vec<f32>>>()?,

        (1, hound::SampleFormat::Float) => reader
            .samples::<f32>()
            .map(|s| s.map_err(anyhow::Error::from))
            .collect::<Result<Vec<f32>>>()?,

        (2, hound::SampleFormat::Int) => {
            let mut out = Vec::new();
            let mut it = reader.samples::<i16>();
            while let (Some(l), Some(r)) = (it.next(), it.next()) {
                out.push((l? as f32 + r? as f32) * 0.5 / i16::MAX as f32);
            }
            out
        }

        (2, hound::SampleFormat::Float) => {
            let mut out = Vec::new();
            let mut it = reader.samples::<f32>();
            while let (Some(l), Some(r)) = (it.next(), it.next()) {
                out.push((l? + r?) * 0.5);
            }
            out
        }

        _ => bail!("unsupported wav format"),
    };

    // ---------- sanity check ----------
    if mono.is_empty() {
        bail!(
            "wav has no audio samples (empty): path={path} channels={} sample_rate={} file_size_bytes={:?}",
            spec.channels,
            spec.sample_rate,
            file_size_bytes
        );
    }

    let mut nan_count: usize = 0;
    let mut inf_count: usize = 0;
    let mut min_v: f32 = f32::INFINITY;
    let mut max_v: f32 = f32::NEG_INFINITY;

    for v in &mono {
        if v.is_nan() {
            nan_count += 1;
            continue;
        }
        if !v.is_finite() {
            inf_count += 1;
            continue;
        }
        min_v = min_v.min(*v);
        max_v = max_v.max(*v);
    }

    let secs = mono.len() as f64 / spec.sample_rate as f64;
    info!(
        "wav: path={path} channels={} sample_rate={} samples={} sec={:.2} file_size_bytes={:?} nan={} inf={} min={:.3} max={:.3}",
        spec.channels,
        spec.sample_rate,
        mono.len(),
        secs,
        file_size_bytes,
        nan_count,
        inf_count,
        if min_v.is_finite() { min_v } else { 0.0 },
        if max_v.is_finite() { max_v } else { 0.0 },
    );

    // Sanitize any non-finite samples to reduce the chance of whisper encoder failures.
    // (Some decoders can produce NaN/Inf for malformed inputs.)
    if nan_count > 0 || inf_count > 0 {
        warn!(
            "wav contains non-finite samples; sanitizing: path={path} nan={} inf={}",
            nan_count,
            inf_count
        );
        let mut fixed = mono;
        for v in &mut fixed {
            if !v.is_finite() {
                *v = 0.0;
            }
            // Keep within expected amplitude range.
            *v = (*v).clamp(-1.0, 1.0);
        }
        return resample_if_needed(path, spec.sample_rate, fixed);
    }

    // Keep within expected amplitude range.
    let mono: Vec<f32> = mono.into_iter().map(|v| v.clamp(-1.0, 1.0)).collect();

    resample_if_needed(path, spec.sample_rate, mono)
}

fn resample_if_needed(path: &str, sample_rate: u32, mono: Vec<f32>) -> Result<Vec<f32>> {
    if mono.is_empty() {
        bail!("wav has no audio samples (empty after decode): path={path}");
    }

    // Whisper tends to fail with an opaque encoder error for extremely short inputs.
    // Make this actionable at the boundary.
    let secs = mono.len() as f64 / sample_rate as f64;
    if secs < 0.05 {
        bail!(
            "wav is too short ({secs:.3}s). Please provide a longer clip (>= 0.05s): path={path}"
        );
    }

    // ---------- already 16k ----------
    if sample_rate == 16_000 {
        return Ok(mono);
    }

    // ---------- resample (SAFE VERSION) ----------
    let ratio = 16_000.0 / sample_rate as f64;

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let mut resampler = SincFixedIn::<f32>::new(ratio, 1.0, params, mono.len(), 1)?;

    let input = vec![mono];
    let output = resampler.process(&input, None)?;

    Ok(output[0].clone())
}
