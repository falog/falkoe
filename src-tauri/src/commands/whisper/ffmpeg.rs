use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

fn resolve_bundled_tool(app: &AppHandle, base_name: &str) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let exe_name = if cfg!(target_os = "windows") {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    };

    let candidates = [
        resource_dir.join("bin").join(&exe_name),
        resource_dir.join(&exe_name),
    ];

    candidates.into_iter().find(|p| p.exists())
}

pub(crate) fn ffmpeg_convert_to_wav(app: &AppHandle, input: &Path, output_wav: &Path) -> Result<()> {
    let cmd = resolve_bundled_tool(app, "ffmpeg").unwrap_or_else(|| PathBuf::from("ffmpeg"));

    let args = build_convert_to_wav_args(input, output_wav)?;
    let status = Command::new(&cmd).args(args).status()?;

    if !status.success() {
        bail!("ffmpeg conversion failed (cmd={:?})", cmd);
    }

    Ok(())
}

fn build_convert_to_wav_args(input: &Path, output_wav: &Path) -> Result<Vec<String>> {
    Ok(vec![
        "-y".into(),
        "-i".into(),
        input
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("invalid input path"))?
            .to_string(),
        "-ar".into(),
        "16000".into(),
        "-ac".into(),
        "1".into(),
        output_wav
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("invalid output path"))?
            .to_string(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn build_convert_to_wav_args_shape() {
        let args = build_convert_to_wav_args(Path::new("/tmp/in.mp3"), Path::new("/tmp/out.wav"))
            .expect("args");
        assert_eq!(args[0], "-y");
        assert_eq!(args[1], "-i");
        assert_eq!(args[2], "/tmp/in.mp3");
        assert!(args.contains(&"16000".to_string()));
        assert_eq!(args.last().map(|s| s.as_str()), Some("/tmp/out.wav"));
    }
}
