use anyhow::{bail, Context, Result};
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

pub(crate) fn run_ffmpeg(app: &AppHandle, args: &[String]) -> Result<()> {
    let cmd = resolve_bundled_tool(app, "ffmpeg").unwrap_or_else(|| PathBuf::from("ffmpeg"));

    // Reduce output volume so we don't lose the real error due to truncation.
    let mut full_args: Vec<String> = Vec::with_capacity(args.len() + 4);
    full_args.push("-hide_banner".into());
    full_args.push("-loglevel".into());
    full_args.push("error".into());
    full_args.extend_from_slice(args);

    let out = match Command::new(&cmd).args(&full_args).output() {
        Ok(o) => o,
        Err(e) => {
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
            for a in &full_args {
                s.push(' ');
                // Minimal quoting for readability.
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
        // Keep only last ~80 lines to avoid huge error payloads.
        let tail = stderr
            .lines()
            .rev()
            .take(80)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");

        bail!("ffmpeg failed\ncmd: {cmdline}\nstderr (tail):\n{tail}");
    }
    Ok(())
}

pub(crate) fn escape_filter_path(p: &Path) -> String {
    // Use forward slashes and escape ':' and single quotes for filter args.
    let s = p.to_string_lossy().replace('\\', "/");
    s.replace(':', "\\:").replace('\'', "\\'")
}

fn build_gap_clip_args(
    out_path: &Path,
    w: u32,
    h: u32,
    dur_sec: f32,
    model_txt_path: &Path,
    label_txt_path: &Path,
) -> Vec<String> {
    let dur = dur_sec.max(0.1);
    let color = format!("color=c=black:s={}x{}:d={:.3}", w.max(1), h.max(1), dur);
    let vf = vec![
        format!(
            "drawtext=textfile='{}':x=(w-text_w)/2:y=8:fontcolor=white:fontsize=26:box=1:boxcolor=black@0.35:boxborderw=8",
            escape_filter_path(model_txt_path)
        ),
        format!(
            // Center label big on black screen.
            "drawtext=textfile='{}':x=(w-text_w)/2:y=(h-text_h)/2:fontcolor=white:fontsize=56:box=1:boxcolor=black@0.35:boxborderw=12",
            escape_filter_path(label_txt_path)
        ),
    ]
    .join(",");

    vec![
        "-y".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        color,
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        "anullsrc=channel_layout=stereo:sample_rate=48000".into(),
        "-r".into(),
        "30".into(),
        "-vf".into(),
        vf,
        "-shortest".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "28".into(),
        "-profile:v".into(),
        "baseline".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        out_path.to_string_lossy().to_string(),
    ]
}

pub(crate) fn create_gap_clip_with_text(
    app: &AppHandle,
    out_path: &Path,
    w: u32,
    h: u32,
    dur_sec: f32,
    model_txt_path: &Path,
    label_txt_path: &Path,
) -> Result<()> {
    let args = build_gap_clip_args(out_path, w, h, dur_sec, model_txt_path, label_txt_path);
    run_ffmpeg(app, &args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn escape_filter_path_escapes_colon_and_quote() {
        let p = PathBuf::from("/tmp/a:b'c.txt");
        assert_eq!(escape_filter_path(&p), "/tmp/a\\:b\\'c.txt");
    }

    #[test]
    fn build_gap_clip_args_contains_drawtext_and_output() {
        let out_path = Path::new("/tmp/out.mp4");
        let model_txt = Path::new("/tmp/model.txt");
        let label_txt = Path::new("/tmp/label.txt");
        let args = build_gap_clip_args(out_path, 640, 480, 2.0, model_txt, label_txt);

        assert!(args.iter().any(|a| a.contains("drawtext=textfile='")));
        assert_eq!(args.last().map(|s| s.as_str()), Some("/tmp/out.mp4"));
        assert!(args.iter().any(|a| a.starts_with("color=c=black:s=640x480")));
    }
}
