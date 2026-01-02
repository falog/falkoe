use anyhow::{bail, Context, Result};
use std::{env, path::PathBuf};

fn parse_args() -> Result<(PathBuf, Option<PathBuf>)> {
    let mut wav_path: Option<PathBuf> = None;
    let mut out_path: Option<PathBuf> = None;

    let mut it = env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--out" => {
                let p = it.next().context("--out requires a path")?;
                out_path = Some(PathBuf::from(p));
            }
            _ => {
                if wav_path.is_none() {
                    wav_path = Some(PathBuf::from(arg));
                } else {
                    bail!("unexpected argument: {arg}");
                }
            }
        }
    }

    let wav_path = wav_path.context("usage: analyze_pitch_wav <path.wav> [--out out.json]")?;
    Ok((wav_path, out_path))
}

fn main() -> Result<()> {
    let (wav_path, out_path) = parse_args()?;

    if !wav_path.is_file() {
        bail!("wav not found: {}", wav_path.display());
    }

    let analysis = falkoe_lib::analyze_pitch_noapp(
        wav_path
            .to_str()
            .context("wav path must be valid utf-8")?
            .to_string(),
        None,
        None,
        None,
        Some(true),
    )
    .map_err(|e| anyhow::anyhow!(e))?;

    let out_path = out_path.unwrap_or_else(|| wav_path.with_extension("pitch.json"));
    let json = serde_json::to_string_pretty(&analysis)?;
    std::fs::write(&out_path, json)?;

    println!("wrote: {}", out_path.display());
    println!(
        "segments={} words={} frames={}",
        analysis.segments.as_ref().map(|v| v.len()).unwrap_or(0),
        analysis.words.as_ref().map(|v| v.len()).unwrap_or(0),
        analysis.f0_hz.len()
    );

    Ok(())
}
