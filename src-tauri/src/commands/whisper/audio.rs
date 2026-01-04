use anyhow::{bail, Result};
use hound;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

pub fn load_wav_as_f32(path: &str) -> Result<Vec<f32>> {
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
    println!(
        "wav: {} ch, {} Hz, samples={}, sec={:.2}",
        spec.channels,
        spec.sample_rate,
        mono.len(),
        mono.len() as f32 / spec.sample_rate as f32
    );

    // ---------- already 16k ----------
    if spec.sample_rate == 16_000 {
        return Ok(mono);
    }

    // ---------- resample (SAFE VERSION) ----------
    let ratio = 16_000.0 / spec.sample_rate as f64;

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
