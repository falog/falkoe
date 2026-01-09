use anyhow::{Context, Result};
use std::path::Path;

fn whisper_lang_arg_to_code(lang: Option<&str>) -> Option<&'static str> {
    match lang {
        None => None,
        Some("eng") | Some("en") => Some("en"),
        Some("jpn") | Some("ja") => Some("ja"),
        Some("spa") | Some("es") => Some("es"),
        Some("fra") | Some("fr") => Some("fr"),
        Some("deu") | Some("de") => Some("de"),
        Some("ita") | Some("it") => Some("it"),
        Some("por") | Some("pt") => Some("pt"),
        Some("rus") | Some("ru") => Some("ru"),
        Some("kor") | Some("ko") => Some("ko"),
        Some("zho") | Some("zh") | Some("cmn") | Some("yue") => Some("zh"),
        Some("ara") | Some("ar") => Some("ar"),
        Some("hin") | Some("hi") => Some("hi"),
        Some("tur") | Some("tr") => Some("tr"),
        Some("vie") | Some("vi") => Some("vi"),
        Some("tha") | Some("th") => Some("th"),
        Some("ind") | Some("id") => Some("id"),
        Some("ukr") | Some("uk") => Some("uk"),
        Some("pol") | Some("pl") => Some("pl"),
        Some("nld") | Some("nl") => Some("nl"),
        Some("swe") | Some("sv") => Some("sv"),
        _ => None,
    }
}

fn main() -> Result<()> {
    let mut wav_path: Option<String> = None;
    let mut model_path: Option<String> = None;
    let mut lang: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" => model_path = Some(args.next().context("--model requires a path")?),
            "--lang" => lang = Some(args.next().context("--lang requires a value")?),
            "--help" | "-h" => {
                eprintln!("usage: transcribe_wav_json <path.wav> --model <model.bin> [--lang ja|en]");
                std::process::exit(0);
            }
            _ => {
                if wav_path.is_none() {
                    wav_path = Some(arg);
                }
            }
        }
    }

    let wav_path = wav_path.context("missing wav path")?;
    let model_path = model_path.context("missing --model <path>")?;

    if !Path::new(&wav_path).is_file() {
        anyhow::bail!("wav not found: {wav_path}");
    }
    if !Path::new(&model_path).is_file() {
        anyhow::bail!("model not found: {model_path}");
    }

    let whisper_lang = whisper_lang_arg_to_code(lang.as_deref());
    let transcript = falkoe_lib::transcribe(&wav_path, Path::new(&model_path), whisper_lang)?;

    // Emit transcript JSON to stdout for the parent process to parse.
    let json = serde_json::to_string(&transcript)?;
    println!("{json}");

    Ok(())
}
