use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::io::ErrorKind;
use tauri::{AppHandle, Manager};

fn resolve_bundled_tool(app: &AppHandle, base_name: &str) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let exe_name = if cfg!(target_os = "windows") {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    };

    let candidates = [
        // bundle layout
        resource_dir.join("bin").join(&exe_name),
        resource_dir.join(&exe_name),
        // dev layout (resources synced under target/*/resources)
        resource_dir.join("resources").join("bin").join(&exe_name),
        resource_dir.join("resources").join(&exe_name),
    ];

    candidates.into_iter().find(|p| p.is_file())
}

pub(crate) fn ffmpeg_convert_to_wav(app: &AppHandle, input: &Path, output_wav: &Path) -> Result<()> {
    let cmd = resolve_bundled_tool(app, "ffmpeg").unwrap_or_else(|| PathBuf::from("ffmpeg"));

    // Heuristic: on Windows, package-manager "shim" executables are often a few hundred KB.
    // Real ffmpeg builds are typically many MB. If we detect a tiny bundled exe, hint at the fix.
    #[cfg(target_os = "windows")]
    if cmd.is_absolute() {
        if let Ok(meta) = fs::metadata(&cmd) {
            if meta.is_file() && meta.len() > 0 && meta.len() < 1_000_000 {
                eprintln!(
                    "[ffmpeg] bundled ffmpeg looks unusually small ({} bytes): {:?}. If this is a Chocolatey/Scoop shim, bundle the real ffmpeg.exe + required DLLs instead.",
                    meta.len(),
                    cmd
                );
            }
        }
    }

    let args = build_convert_to_wav_args(input, output_wav)?;
    let out = match Command::new(&cmd).args(&args).output() {
        Ok(o) => o,
        Err(e) => {
            // Make the common Windows failure modes actionable:
            // - NotFound: ffmpeg.exe missing from resources or PATH
            // - 126: "The specified module could not be found" (often a missing DLL dependency)
            if e.kind() == ErrorKind::NotFound {
                bail!(
                    "ffmpeg not found. To bundle it, place it at resources/bin/ffmpeg.exe (Windows) or resources/bin/ffmpeg (macOS/Linux), or install ffmpeg and ensure it is on PATH. (cmd={:?})",
                    cmd
                );
            }
            #[cfg(target_os = "windows")]
            if e.raw_os_error() == Some(126) {
                bail!(
                    "failed to start ffmpeg (Windows error 126: missing module). This usually means ffmpeg.exe depends on DLLs that are not next to it. Bundle ffmpeg.exe AND any required *.dll files in resources/bin, or use a static ffmpeg build. (cmd={:?})",
                    cmd
                );
            }
            return Err(e).with_context(|| format!("failed to spawn ffmpeg: {:?}", cmd));
        }
    };

    if !out.status.success() {
        let cmdline = {
            let mut s = cmd.to_string_lossy().to_string();
            for a in &args {
                s.push(' ');
                if a.contains(' ') || a.contains('\t') || a.contains('\n') {
                    s.push('"');
                    s.push_str(&a.replace('"', "\\\""));
                    s.push('"');
                } else {
                    s.push_str(a);
                }
            }
            s
        };

        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail = stderr
            .lines()
            .rev()
            .take(60)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");

        bail!("ffmpeg conversion failed\ncmd: {cmdline}\nstderr (tail):\n{tail}");
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
