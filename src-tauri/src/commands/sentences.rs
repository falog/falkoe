use crate::model::hash_sentence;

use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SentenceManifest {
    audio_id: String,
    sentence_id: Option<String>,
    lang: String,
    text: Option<String>,
    last_wav_path: Option<String>,
}

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
        let mut manifest = serde_json::from_str::<SentenceManifest>(&manifest_text)
            .map_err(|e| e.to_string())?;

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
