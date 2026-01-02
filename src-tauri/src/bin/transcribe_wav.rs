use anyhow::{bail, Context, Result};
use std::{
    env,
    path::{Path, PathBuf},
};

fn parse_args() -> Result<(PathBuf, Option<PathBuf>, Option<String>)> {
    let mut wav_path: Option<PathBuf> = None;
    let mut out_path: Option<PathBuf> = None;
    let mut lang: Option<String> = None;

    let mut it = env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--out" => {
                let p = it.next().context("--out requires a path")?;
                out_path = Some(PathBuf::from(p));
            }
            "--lang" => {
                let l = it.next().context("--lang requires a value")?;
                lang = Some(l);
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

    let wav_path = wav_path.context("usage: transcribe_wav <path.wav> [--lang ja|en] [--out out.json]")?;

    Ok((wav_path, out_path, lang))
}

fn main() -> Result<()> {
    let (wav_path, out_path, lang) = parse_args()?;

    if !wav_path.is_file() {
        bail!("wav not found: {}", wav_path.display());
    }

    let model_path = falkoe_lib::find_existing_model_path_noapp().context(
        "model not found. Set FALKOE_MODEL_PATH or download model via the app first.",
    )?;

    let whisper_lang = match lang.as_deref() {
        None => Some("ja"),
        Some("ja") => Some("ja"),
        Some("en") => Some("en"),
        Some(other) => bail!("unsupported --lang: {other} (use ja|en)"),
    };

    let transcript = falkoe_lib::transcribe(
        wav_path
            .to_str()
            .context("wav path must be valid utf-8")?,
        Path::new(&model_path),
        whisper_lang,
    )?;

    let out_path = out_path.unwrap_or_else(|| wav_path.with_extension("json"));
    let json = serde_json::to_string_pretty(&transcript)?;
    std::fs::write(&out_path, json)?;

    let segments = transcript.segments.len();
    let tokens = transcript.tokens.as_ref().map(|t| t.len()).unwrap_or(0);
    let words = transcript.words.as_ref().map(|w| w.len()).unwrap_or(0);

    println!("wrote: {}", out_path.display());
    println!("segments={segments} tokens={tokens} words={words}");

    Ok(())
}
