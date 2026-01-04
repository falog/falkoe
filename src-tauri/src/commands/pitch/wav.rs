use anyhow::{bail, Result};
use hound;
use std::path::Path;

pub(crate) fn read_wav_mono_f32(path: &Path) -> Result<(Vec<f32>, u32)> {
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

pub(crate) fn read_wav_sample_rate(path: &Path) -> Result<u32> {
    let reader = hound::WavReader::open(path)?;
    Ok(reader.spec().sample_rate)
}
