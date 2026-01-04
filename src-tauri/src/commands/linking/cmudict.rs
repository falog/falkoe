use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use tauri::AppHandle;
use tauri::Manager;

const CMUDICT_URLS: [&str; 2] = [
    "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict",
    "https://raw.githubusercontent.com/Alexir/CMUdict/master/cmudict-0.7b",
];

#[derive(Clone, Debug)]
pub(crate) struct CmuDict {
    pub(crate) map: HashMap<String, Vec<String>>,
}

static CMUDICT_CACHE: OnceLock<Mutex<Option<Arc<CmuDict>>>> = OnceLock::new();

fn cmudict_cache() -> &'static Mutex<Option<Arc<CmuDict>>> {
    CMUDICT_CACHE.get_or_init(|| Mutex::new(None))
}

fn cmudict_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cmudict"))
}

fn cmudict_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cmudict_dir(app)?.join("cmudict.dict"))
}

fn parse_cmudict(text: &str) -> CmuDict {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with(";;;") {
            continue;
        }

        let mut it = line.split_whitespace();
        let Some(raw_key) = it.next() else {
            continue;
        };

        // e.g. WORD(1) -> WORD
        let key = if raw_key.ends_with(')') {
            match raw_key.find('(') {
                Some(idx) => &raw_key[..idx],
                None => raw_key,
            }
        } else {
            raw_key
        }
        .to_ascii_lowercase();

        if key.is_empty() {
            continue;
        }

        // already have a primary entry
        if map.contains_key(&key) {
            continue;
        }

        let phonemes: Vec<String> = it.map(|s| s.to_string()).collect();
        if phonemes.is_empty() {
            continue;
        }

        map.insert(key, phonemes);
    }

    CmuDict { map }
}

fn download_cmudict() -> Result<String, String> {
    let mut last_error: Option<String> = None;

    for url in CMUDICT_URLS {
        match reqwest::blocking::get(url) {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_error = Some(format!("HTTP {} from {url}", resp.status()));
                    continue;
                }

                match resp.text() {
                    Ok(t) => return Ok(t),
                    Err(e) => {
                        last_error = Some(format!("read body failed from {url}: {e}"));
                        continue;
                    }
                }
            }
            Err(e) => {
                last_error = Some(format!("request failed to {url}: {e}"));
                continue;
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "failed to download cmudict".to_string()))
}

fn load_cmudict_from_disk(path: &Path) -> Result<Option<CmuDict>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(Some(parse_cmudict(&text)))
}

pub(crate) fn ensure_cmudict_loaded(app: &AppHandle) -> Result<Arc<CmuDict>, String> {
    // Fast path: already loaded
    if let Some(existing) = cmudict_cache().lock().unwrap().clone() {
        return Ok(existing);
    }

    let path = cmudict_path(app)?;

    // Try disk
    if let Some(dict) = load_cmudict_from_disk(&path)? {
        let arc = Arc::new(dict);
        *cmudict_cache().lock().unwrap() = Some(arc.clone());
        return Ok(arc);
    }

    // Download then save
    let text = download_cmudict()?;
    let dir = cmudict_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    {
        let mut f = fs::File::create(&path).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
    }

    let dict = parse_cmudict(&text);
    let arc = Arc::new(dict);
    *cmudict_cache().lock().unwrap() = Some(arc.clone());
    Ok(arc)
}

/// 起動時などに呼んで、初回のrender_linkingを軽くする。
pub(crate) fn warmup_cmudict(app: &AppHandle) -> Result<(), String> {
    let _ = ensure_cmudict_loaded(app)?;
    Ok(())
}
