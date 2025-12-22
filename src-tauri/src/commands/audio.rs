use base64;
use reqwest;

#[tauri::command]
pub async fn fetch_audio_base64(url: String) -> Result<String, String> {
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    Ok(base64::encode(bytes))
}
