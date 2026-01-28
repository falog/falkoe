use crate::model::hash_sentence;
use crate::commands::whisper::{SentenceAttribution, SentenceManifest};

use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertManifestTextResult {
    pub status: String, // "created" | "updated" | "conflict"
    pub manifest_path: String,
    pub previous_text: Option<String>,
}

#[derive(Serialize)]
pub struct FoundAudio {
    pub audio_id: String,
    pub sentence_id: String,
    pub lang: String,
    pub manifest_path: String,
    pub uploaded_path: Option<String>,
    pub uploaded_json_path: Option<String>,
    pub uploaded_wav_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceHistoryItem {
    pub audio_id: String,
    pub lang: String,
    pub text: Option<String>,
    pub attribution: Option<SentenceAttribution>,
    pub recordings_count: u32,
    pub last_recording_timestamp: Option<String>,
    pub last_recording_wav_path: Option<String>,
    pub model_wav_path: Option<String>,
    pub tatoeba_mp3_path: Option<String>,
    pub uploaded_path: Option<String>,
    pub uploaded_original_filename: Option<String>,
}

fn sentences_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("falkoe")
        .join("sentences"))
}

fn pick_uploaded_path(uploaded_dir: &Path) -> Option<PathBuf> {
    let wav = uploaded_dir.join("uploaded.wav");
    if wav.exists() {
        return Some(wav);
    }

    // fallback: uploaded.<ext>
    if let Ok(entries) = fs::read_dir(uploaded_dir) {
        for ent in entries.flatten() {
            let p = ent.path();
            if !p.is_file() {
                continue;
            }
            if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                if name.starts_with("uploaded.") && !name.ends_with(".json") {
                    return Some(p);
                }
            }
        }
    }

    None
}

fn list_recorded_wavs(recorded_dir: &Path) -> (u32, Option<String>, Option<String>) {
    if !recorded_dir.exists() {
        return (0, None, None);
    }

    let mut count: u32 = 0;
    let mut last_ts: Option<String> = None;

    let Ok(entries) = fs::read_dir(recorded_dir) else {
        return (0, None, None);
    };

    for ent in entries.flatten() {
        let p = ent.path();
        if p.extension().and_then(|e| e.to_str()) != Some("wav") {
            continue;
        }
        count += 1;
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            // recording file names are timestamps like 20250104_123456
            if last_ts.as_deref().map(|v| v < stem).unwrap_or(true) {
                last_ts = Some(stem.to_string());
            }
        }
    }

    let last_wav_path = last_ts.as_deref().map(|stem| {
        recorded_dir
            .join(format!("{}.wav", stem))
            .to_string_lossy()
            .to_string()
    });

    (count, last_ts, last_wav_path)
}

#[tauri::command]
pub fn list_sentence_history(app: AppHandle) -> Result<Vec<SentenceHistoryItem>, String> {
    let root = sentences_root(&app)?;
    if !root.exists() {
        return Ok(vec![]);
    }

    let mut out: Vec<SentenceHistoryItem> = Vec::new();

    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let base = entry.path();
        if !base.is_dir() {
            continue;
        }

        let audio_id = match base.file_name().and_then(|s| s.to_str()) {
            Some(v) => v.to_string(),
            None => continue,
        };

        let manifest_path = base.join("manifest.json");
        let mut lang: Option<String> = None;
        let mut text: Option<String> = None;
        let mut attribution: Option<SentenceAttribution> = None;
        if manifest_path.exists() {
            if let Ok(manifest_text) = fs::read_to_string(&manifest_path) {
                if let Ok(manifest) = serde_json::from_str::<SentenceManifest>(&manifest_text) {
                    lang = Some(manifest.lang);
                    text = manifest.text;
                    attribution = manifest.attribution;
                }
            }
        }

        let recorded_dir = base.join("recorded");
        let (recordings_count, last_recording_timestamp, last_recording_wav_path) =
            list_recorded_wavs(&recorded_dir);

        let model_wav = base.join("model").join("model.wav");
        let model_wav_path = model_wav
            .exists()
            .then(|| model_wav.to_string_lossy().to_string());

        let tatoeba_mp3 = base.join("tatoeba").join("tatoeba.mp3");
        let tatoeba_mp3_path = tatoeba_mp3
            .exists()
            .then(|| tatoeba_mp3.to_string_lossy().to_string());

        let uploaded_dir = base.join("uploaded");
        let uploaded_path = pick_uploaded_path(&uploaded_dir)
            .map(|p| p.to_string_lossy().to_string());

        let uploaded_original_filename = uploaded_dir
            .join("original_filename.txt")
            .exists()
            .then(|| {
                fs::read_to_string(uploaded_dir.join("original_filename.txt"))
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
            .flatten();

        // If we don't know the language yet (manifest missing), still list the item.
        // Default to "eng" so the UI can open it for playback; the user can later
        // recreate/overwrite manifest.json by opening the sentence normally.
        let lang = lang.unwrap_or_else(|| "eng".to_string());

        out.push(SentenceHistoryItem {
            audio_id,
            lang,
            text,
            attribution,
            recordings_count,
            last_recording_timestamp,
            last_recording_wav_path,
            model_wav_path,
            tatoeba_mp3_path,
            uploaded_path,
            uploaded_original_filename,
        });
    }

    // Sort by newest recording first.
    out.sort_by(|a, b| b.last_recording_timestamp.cmp(&a.last_recording_timestamp));
    Ok(out)
}

#[tauri::command]
pub fn upsert_sentence_manifest_text(
    app: AppHandle,
    audio_id: String,
    lang: String,
    text: String,
    overwrite: bool,
) -> Result<UpsertManifestTextResult, String> {
    let normalized_text = text.trim();
    if normalized_text.is_empty() {
        return Err("text is empty".into());
    }

    let sentence_id = hash_sentence(normalized_text, &lang);

    let base_dir = sentences_root(&app)?.join(&audio_id);
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    let manifest_path = base_dir.join("manifest.json");
    let manifest_path_str = manifest_path.to_string_lossy().to_string();

    if manifest_path.exists() {
        let manifest_text = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
        let mut manifest =
            serde_json::from_str::<SentenceManifest>(&manifest_text).map_err(|e| e.to_string())?;

        let prev = manifest.text.clone();
        let prev_norm = prev.as_deref().unwrap_or("").trim();
        if !prev_norm.is_empty() && prev_norm != normalized_text && !overwrite {
            return Ok(UpsertManifestTextResult {
                status: "conflict".into(),
                manifest_path: manifest_path_str,
                previous_text: prev,
            });
        }

        manifest.audio_id = audio_id;
        manifest.lang = lang;
        manifest.text = Some(normalized_text.to_string());
        manifest.sentence_id = Some(sentence_id);

        let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        fs::write(&manifest_path, json).map_err(|e| e.to_string())?;

        return Ok(UpsertManifestTextResult {
            status: "updated".into(),
            manifest_path: manifest_path_str,
            previous_text: prev,
        });
    }

    let manifest = SentenceManifest {
        audio_id: audio_id.clone(),
        sentence_id: Some(sentence_id),
        lang,
        text: Some(normalized_text.to_string()),
        last_wav_path: None,
        attribution: None,
    };

    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(&manifest_path, json).map_err(|e| e.to_string())?;

    Ok(UpsertManifestTextResult {
        status: "created".into(),
        manifest_path: manifest_path_str,
        previous_text: None,
    })
}

#[tauri::command]
pub fn upsert_sentence_manifest_attribution(
    app: AppHandle,
    audio_id: String,
    lang: String,
    attribution: SentenceAttribution,
) -> Result<String, String> {
    let audio_id = audio_id.trim();
    if audio_id.is_empty() {
        return Err("audio_id is empty".into());
    }
    let lang = lang.trim();
    if lang.is_empty() {
        return Err("lang is empty".into());
    }

    let base_dir = sentences_root(&app)?.join(audio_id);
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    let manifest_path = base_dir.join("manifest.json");

    let mut manifest: SentenceManifest = if manifest_path.exists() {
        match fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|s| serde_json::from_str::<SentenceManifest>(&s).ok())
        {
            Some(v) => v,
            None => SentenceManifest {
                audio_id: audio_id.to_string(),
                sentence_id: None,
                lang: lang.to_string(),
                text: None,
                last_wav_path: None,
                attribution: None,
            },
        }
    } else {
        SentenceManifest {
            audio_id: audio_id.to_string(),
            sentence_id: None,
            lang: lang.to_string(),
            text: None,
            last_wav_path: None,
            attribution: None,
        }
    };

    manifest.audio_id = audio_id.to_string();
    manifest.lang = lang.to_string();
    manifest.attribution = Some(attribution);

    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(&manifest_path, json).map_err(|e| e.to_string())?;

    Ok("updated".into())
}

#[tauri::command]
pub fn find_audio_by_sentence(
    app: AppHandle,
    text: String,
    lang: String,
) -> Result<Option<FoundAudio>, String> {
    let normalized_text = text.trim();
    if normalized_text.is_empty() {
        return Ok(None);
    }

    let sentence_id = hash_sentence(normalized_text, &lang);

    let root = sentences_root(&app)?;
    if !root.exists() {
        return Ok(None);
    }

    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let base = entry.path();
        if !base.is_dir() {
            continue;
        }

        let manifest_path = base.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }

        let Ok(manifest_text) = fs::read_to_string(&manifest_path) else {
            continue;
        };

        let Ok(manifest) = serde_json::from_str::<SentenceManifest>(&manifest_text) else {
            continue;
        };

        if manifest.lang != lang {
            continue;
        }

        if manifest.sentence_id.as_deref() != Some(&sentence_id) {
            continue;
        }

        let uploaded_dir = base.join("uploaded");
        let uploaded_json = uploaded_dir.join("uploaded.json");
        let uploaded_wav = uploaded_dir.join("uploaded.wav");
        let uploaded_path = pick_uploaded_path(&uploaded_dir);

        return Ok(Some(FoundAudio {
            audio_id: manifest.audio_id,
            sentence_id,
            lang,
            manifest_path: manifest_path.to_string_lossy().to_string(),
            uploaded_path: uploaded_path.map(|p| p.to_string_lossy().to_string()),
            uploaded_json_path: uploaded_json
                .exists()
                .then(|| uploaded_json.to_string_lossy().to_string()),
            uploaded_wav_path: uploaded_wav
                .exists()
                .then(|| uploaded_wav.to_string_lossy().to_string()),
        }));
    }

    Ok(None)
}
