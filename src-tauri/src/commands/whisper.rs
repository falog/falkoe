#![allow(dead_code)]

use crate::model::ensure_model;

use anyhow::{Result, bail};
use hound;
use whisper_rs::*;
use tauri::{AppHandle, Emitter};
use std::{fs, path::Path};
use rubato::{
    Resampler,
    SincFixedIn,
    SincInterpolationParameters,
    SincInterpolationType,
    WindowFunction,
};
use std::sync::{OnceLock, Mutex};
use whisper_rs::{WhisperContext, WhisperContextParameters};
use std::io::Write;


#[derive(serde::Serialize, Clone)]
pub struct PreviewResult {
    pub status: String, // "preview"
    pub text: String,
    pub score: f32,
}


#[derive(serde::Serialize, Clone)]
pub struct FinalResult {
    pub status: String,
    pub wav_path: String,
    pub segments: Vec<Segment>,
    pub score: f32,
}

#[derive(serde::Serialize, Default, Clone)]
pub struct Segment {
    pub start: f32,
    pub end: f32,
    pub text: String,

   // pub avg_logprob: Option<f32>,
   // pub compression_ratio: Option<f32>,
   // pub no_speech_prob: Option<f32>,
}


#[derive(serde::Serialize)]
pub struct Transcript {
    pub segments: Vec<Segment>,
}

#[derive(serde::Serialize, Clone)]
pub struct PartialSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}





#[tauri::command]
pub fn run_whisper(
    app: AppHandle,
    path: String,
    sentence_id: u64,
    lang: String,
) -> Result<(), String> {
    let app_handle = app.clone();

    std::thread::spawn(move || {
        if let Err(e) = run_whisper_inner(&app_handle, &path, sentence_id, &lang) {
            eprintln!("whisper error: {e}");
        }
    });

    Ok(())
}

fn run_whisper_inner(
    app: &AppHandle,
    wav_path: &str,
    _sentence_id: u64,
    lang: &str,
) -> Result<()> {

    println!("=== run_whisper_inner START ===");
    println!("wav_path = {}", wav_path);

    let model_path = ensure_model(app)?;
    println!("model_path = {:?}", model_path);

    let whisper_lang =match lang {
        "eng" => Some("en"),
        "jpn" => Some("ja"),
        _ => None,
    };
    let transcript = transcribe(wav_path, &model_path, whisper_lang)?;

    println!("transcribe OK, segments = {}", transcript.segments.len());

    save_transcript_json(wav_path, &transcript)?;
    println!("json saved");

    let _full_text = transcript.segments
        .iter()
        .map(|s| s.text.clone())
        .collect::<Vec<_>>()
        .join(" ");

    let score = 0.0;

    let final_result = FinalResult {
        status: "final".into(),
        wav_path: wav_path.to_string(),
        segments: transcript.segments.clone(),
        score,
    };

    app.emit("transcript-final", final_result)?;

    Ok(())
}


/*
fn run_whisper_inner(
    app: &AppHandle,
    wav_path: &str,
    _sentence_id: u64,
) -> Result<()> {

    let segments = transcribe_streaming(app, wav_path)?;

    let transcript = Transcript { segments: segments.clone() };
    save_transcript_json(wav_path, &transcript)?;

let final_result = FinalResult {
    status: "final".into(),
    wav_path: wav_path.to_string(),
    segments,
    score: 0.0,
};

app.emit("transcript-final", final_result)?;


    Ok(())
}
    */

fn append_segment_json(wav_path: &str, seg: &Segment) -> Result<()> {
    let json_path = Path::new(wav_path).with_extension("jsonl");

    let line = serde_json::to_string(seg)?;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(json_path)?
        .write_all(format!("{}\n", line).as_bytes())?;

    Ok(())
}


fn get_tiny_ctx(model_path: &str) -> Result<&'static Mutex<WhisperContext>> {
    Ok(TINY_CTX.get_or_init(|| {
        let params = WhisperContextParameters::default();
        let ctx = WhisperContext::new_with_params(model_path, params)
            .expect("failed to load whisper model");
        Mutex::new(ctx)
    }))
}



/*
fn quick_score(recognized: &str, expected: u64) -> f32 {
    let r = recognized.to_lowercase();
    let e = expected.to_lowercase();

    let r_words: Vec<_> = r.split_whitespace().collect();
    let e_words: Vec<_> = e.split_whitespace().collect();

    let matched = r_words
        .iter()
        .filter(|w| e_words.contains(w))
        .count();

    matched as f32 / e_words.len().max(1) as f32 * 100.0
}
*/

pub fn transcribe_preview(
    app: &AppHandle,
    wav_path: &str,
    _sentence_id: u64,
) -> Result<PreviewResult>{


    let audio = load_wav_as_f32(wav_path)?;

    // tiny / fast model想定
    let text = fast_transcribe(app, &audio)?; // rwhisper 等

   // let expected_text = load_expected_sentence(sentence_id)?;
   // let score = quick_score(&full_text, &expected_text);
    let score = 0.0;

    Ok(PreviewResult {
        status: "preview".into(),
        text,
        score,
    })
}

fn split_audio(audio: &[f32], chunk_sec: f32) -> Vec<Vec<f32>> {
    let chunk_samples = (16_000.0 * chunk_sec) as usize;
    audio
        .chunks(chunk_samples)
        .map(|c| c.to_vec())
        .collect()
}


static TINY_CTX: OnceLock<Mutex<WhisperContext>> = OnceLock::new();

fn fast_transcribe(
    app: &AppHandle,
    audio: &[f32],
) -> Result<String> {
    let model_path = ensure_model(app)?; // tiny を返すようにしてもOK

    let ctx_mutex = get_tiny_ctx(model_path.to_str().unwrap())?;
    let ctx = ctx_mutex.lock().unwrap();

    let mut state = ctx.create_state()?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_progress(false);
    params.set_translate(false);

    state.full(params, audio)?;

    let text = state
        .as_iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join(" ");

    Ok(text.trim().to_string())
}

fn transcribe_streaming(
    app: &AppHandle,
    wav_path: &str,
) -> Result<Vec<Segment>> {
    let audio = load_wav_as_f32(wav_path)?;
    let chunks = split_audio(&audio, 1.0); // 1秒刻み

    let model_path = ensure_model(app)?;
    let ctx_mutex = get_tiny_ctx(model_path.to_str().unwrap())?;
    let ctx = ctx_mutex.lock().unwrap();

    let mut all_segments = Vec::new();
    let mut time_offset = 0.0;

    for chunk in chunks {
        let mut state = ctx.create_state()?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_print_progress(false);

        state.full(params, &chunk)?;

        for s in state.as_iter() {
            let text = s.to_string().trim().to_string();

            if text.is_empty() {
                continue;
            }
            if (text.starts_with('(') && text.ends_with(')'))
                || (text.starts_with('[') && text.ends_with(']'))
                || text == "[BLANK_AUDIO]"
            {   
                continue;
            }
            let seg = Segment {
                start: time_offset + s.start_timestamp() as f32 / 100.0,
                end: time_offset + s.end_timestamp() as f32 / 100.0,
                text: text.clone(),
            };

            let _ = app.emit("transcript-partial", &seg);

            append_segment_json(wav_path, &seg)?;

            all_segments.push(seg);
        }

        time_offset += chunk.len() as f32 / 16_000.0;
    }

    Ok(all_segments)
}

/*
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

       // avg_logprob: None,
       // compression_ratio: None,
       // no_speech_prob: Some(s.no_speech_probability()),
    })

    })
    .collect();



    println!("segments = {}", segments.len());

    Ok(Transcript { segments })
}
*/
pub fn transcribe(wav_path: &str, model_path: &Path, whisper_lang: Option<&str>) -> Result<Transcript> {
    let audio = load_wav_as_f32(wav_path)?;

    println!("before WhisperContext::new_with_params");
    let ctx = WhisperContext::new_with_params(
        model_path.to_str().unwrap(),
        WhisperContextParameters::default(),
    )?;
    println!("after WhisperContext::new_with_params");
    let mut state = ctx.create_state()?;

    let mut params = FullParams::new(
        SamplingStrategy::Greedy { best_of: 1 }
    );

    println!("set_language {:?}", whisper_lang);
    println!("model_path = {:?}", model_path);
    params.set_language(whisper_lang);
    params.set_translate(false);

    // ❌ streaming / chunk 系は一切使わない
    // params.set_single_segment(false);
    // params.set_split_on_word(false);

    // ★ full は state に対して呼ぶ
    state.full(params, &audio)?;

   let segments: Vec<Segment> = state
    .as_iter()
    .filter_map(|s| {
        let text = s.to_string().trim().to_string();

        if text.is_empty()
            || text == "[BLANK_AUDIO]"
            || (text.starts_with('(') && text.ends_with(')'))
            || (text.starts_with('[') && text.ends_with(']'))
        {
            return None;
        }

        Some(Segment {
            start: s.start_timestamp() as f32 / 100.0,
            end: s.end_timestamp() as f32 / 100.0,
            text,
        })
    })
    .collect();

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

