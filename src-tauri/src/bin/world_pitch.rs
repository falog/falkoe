#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
use anyhow::{bail, Context, Result};
use std::{
    env,
    fs::File,
    io::{BufWriter, Write},
    path::Path,
};

fn usage() -> ! {
    eprintln!(
        "usage: world_pitch <wav_path> <out_tsv_path> <time_step> <pitch_floor> <pitch_ceiling>\n\nOutputs TSV lines: time<TAB>f0_hz"
    );
    std::process::exit(2);
}

fn main() {
    if let Err(e) = run() {
        eprintln!("world_pitch error: {e:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 6 {
        usage();
    }

    let wav_path = Path::new(&args[1]);
    let out_path = Path::new(&args[2]);
    let time_step: f32 = args[3].parse().context("invalid time_step")?;
    let pitch_floor: f32 = args[4].parse().context("invalid pitch_floor")?;
    let pitch_ceiling: f32 = args[5].parse().context("invalid pitch_ceiling")?;

    if !wav_path.exists() {
        bail!("wav not found: {}", wav_path.display());
    }

    // NOTE: Despite the name, this binary currently uses Falkoe's built-in pitch extractor
    // (YIN-based). It exists to provide a stable, redistributable helper interface.
    // If/when a true WORLD implementation is added, it can be swapped in here without
    // changing the app-facing contract.
    let analysis = falkoe_lib::analyze_pitch_noapp(
        wav_path.to_string_lossy().to_string(),
        Some(time_step),
        Some(pitch_floor),
        Some(pitch_ceiling),
        Some(false),
    )
    .map_err(anyhow::Error::msg)?;

    let mut w = BufWriter::new(File::create(out_path).with_context(|| {
        format!("failed to create out_tsv_path: {}", out_path.display())
    })?);

    let dt = analysis.time_step.max(0.000_1);
    for (i, f0) in analysis.f0_hz.iter().enumerate() {
        let t = (i as f32) * dt;
        let hz = f0.unwrap_or(0.0);
        writeln!(w, "{t}\t{hz}")?;
    }

    Ok(())
}
