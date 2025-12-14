use anyhow::{Result, bail};
use hound;
use whisper_rs::*;
use tauri::{AppHandle, Emitter,Manager};
use std::{fs, path::{Path, PathBuf}};
use rubato::{
    Resampler,
    SincFixedIn,
    SincInterpolationParameters,
    SincInterpolationType,
    WindowFunction,
};

#[derive(serde::Serialize)]
pub struct Segment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(serde::Serialize)]
pub struct Transcript {
    pub segments: Vec<Segment>,
}

#[tauri::command]
pub fn run_whisper(app: AppHandle, path: String) -> Result<(), String> {
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let _ = app_handle.emit("transcript-started", path.clone());

        if let Err(e) = run_whisper_inner(&app_handle, &path) {
            eprintln!("whisper error: {e}");
        }

        let _ = app_handle.emit("transcript-ready", path);
    });

    Ok(())
}


fn run_whisper_inner(app: &AppHandle, wav_path: &str) -> Result<()> {
    let model_path = ensure_model(app)?;
    println!("model path = {:?}", model_path);

    let transcript = transcribe(wav_path, &model_path)?;
    save_transcript_json(wav_path, &transcript)?;

    Ok(())
}

fn ensure_model(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .expect("app_data_dir not found");

    fs::create_dir_all(&dir)?;

    let model = dir.join("ggml-base.en.bin");

    if !model.exists() {
        bail!("Whisper model not found: {:?}", model);
    }

    Ok(model)
}

fn transcribe(wav_path: &str, model_path: &Path) -> Result<Transcript> {
    println!("loading wav...");
    let mut audio = load_wav_as_f32(wav_path)?;

const MIN_SAMPLES: usize = 16_000 / 5; // 200ms

if audio.len() < MIN_SAMPLES {
    audio.resize(MIN_SAMPLES, 0.0);
}

    println!("loading whisper model...");
    let ctx = WhisperContext::new_with_params(
        model_path.to_str().unwrap(),
        WhisperContextParameters::default(),
    )?;

    let mut state = ctx.create_state()?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_progress(false);

    println!("running whisper...");
    state.full(params, &audio)?;

    let segments: Vec<Segment> = state
    .as_iter()
    .filter_map(|s| {
        let mut text = s.to_string();

        // 非言語トークン除去
        if text.starts_with('(') && text.ends_with(')') {
            return None;
        }
        if text.starts_with('[') && text.ends_with(']') {
            return None;
        }

        text = text.trim().to_string();
        if text.is_empty() || text == "[BLANK_AUDIO]" {
            return None;
        }

        Some(Segment {
            start: s.start_timestamp() as f32 / 100.0,
            end: s.end_timestamp() as f32 / 100.0,
            text,
        })
    })
    .collect();



    println!("segments = {}", segments.len());

    Ok(Transcript { segments })
}

fn save_transcript_json(wav_path: &str, transcript: &Transcript) -> Result<()> {
    let json_path = Path::new(wav_path).with_extension("json");
    let json = serde_json::to_string_pretty(transcript)?;
    fs::write(&json_path, json)?;
    println!("saved transcript: {:?}", json_path);
    Ok(())
}

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

    let mut resampler = SincFixedIn::<f32>::new(
        ratio,
        1.0,
        params,
        mono.len(),
        1,
    )?;

    let input = vec![mono];
    let output = resampler.process(&input, None)?;

    Ok(output[0].clone())
}

