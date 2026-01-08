#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

fn run_transcribe_wav_json(mut args: impl Iterator<Item = String>) -> anyhow::Result<()> {
    let mut wav_path: Option<String> = None;
    let mut model_path: Option<String> = None;
    let mut lang: Option<String> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" => model_path = Some(args.next().unwrap_or_default()),
            "--lang" => lang = Some(args.next().unwrap_or_default()),
            _ => {
                if wav_path.is_none() {
                    wav_path = Some(arg);
                }
            }
        }
    }

    let wav_path = wav_path.ok_or_else(|| anyhow::anyhow!("missing wav path"))?;
    let model_path = model_path.ok_or_else(|| anyhow::anyhow!("missing --model <path>"))?;
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

fn main() {
    let mut args = std::env::args();
    let _exe = args.next();

    if let Some(cmd) = args.next() {
        if cmd == "__transcribe_wav_json" {
            if let Err(e) = run_transcribe_wav_json(args) {
                eprintln!("transcribe_wav_json failed: {e:#}");
                std::process::exit(1);
            }
            return;
        }

        // Put it back is not possible; fall through to GUI.
        // (Unknown commands are ignored and the GUI starts.)
    }

    falkoe_lib::run();
}
