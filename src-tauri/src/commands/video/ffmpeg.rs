use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::io::ErrorKind;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn resolve_bundled_tool(app: &AppHandle, base_name: &str) -> Option<PathBuf> {
    // On Android, binaries are bundled as lib<name>.so in the native library directory.
    #[cfg(target_os = "android")]
    {
        if let Some(p) = resolve_android_native_lib(base_name) {
            return Some(p);
        }
    }

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

/// On Android, native libraries from jniLibs are extracted to a directory
/// like `/data/app/.../lib/arm64/`.  We find that directory by parsing
/// /proc/self/maps for our own library (`libfalkoe_lib.so`), then look for
/// `lib<base_name>.so` next to it.
#[cfg(target_os = "android")]
fn resolve_android_native_lib(base_name: &str) -> Option<PathBuf> {
    let so_name = format!("lib{base_name}.so");

    // Fast path: derive from the directory of our own shared library.
    if let Ok(maps) = std::fs::read_to_string("/proc/self/maps") {
        for line in maps.lines() {
            if line.contains("libfalkoe_lib.so") {
                // line format: "addr-addr perms offset dev inode  /path/to/lib.so"
                if let Some(path_start) = line.rfind('/') {
                    let dir = &line[line.find('/').unwrap_or(0)..path_start];
                    let candidate = PathBuf::from(dir).join(&so_name);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }

    // Fallback: check well-known locations.
    let pkg = "com.fal.falkoe";
    for abi_dir in ["arm64", "arm", "x86_64", "x86"] {
        let candidate = PathBuf::from(format!("/data/data/{pkg}/lib/{abi_dir}/{so_name}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

/// Return video encoding arguments appropriate for the current platform.
///
/// The bundled ffmpeg is built with libx264 on all platforms.
/// On Android we use `ultrafast` preset to favour encoding speed;
/// on desktop we use `veryfast` for a better size/speed balance.
pub(crate) fn h264_encoding_args() -> Vec<String> {
    #[cfg(target_os = "android")]
    let preset = "ultrafast";
    #[cfg(not(target_os = "android"))]
    let preset = "veryfast";

    vec![
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        preset.into(),
        "-crf".into(),
        "28".into(),
        "-profile:v".into(),
        "baseline".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ]
}

pub(crate) fn run_ffmpeg(app: &AppHandle, args: &[String]) -> Result<()> {
    let cmd = resolve_bundled_tool(app, "ffmpeg").unwrap_or_else(|| PathBuf::from("ffmpeg"));

    // Reduce output volume so we don't lose the real error due to truncation.
    let mut full_args: Vec<String> = Vec::with_capacity(args.len() + 4);
    full_args.push("-hide_banner".into());
    full_args.push("-loglevel".into());
    full_args.push("error".into());
    full_args.extend_from_slice(args);

    let out = match {
        let mut c = Command::new(&cmd);
        c.args(&full_args);
        #[cfg(target_os = "windows")]
        {
            // Avoid flashing a console window on Windows.
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            c.creation_flags(CREATE_NO_WINDOW);
        }
        c.output()
    } {
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

    crate::logging::log_line(app, format!("[ffmpeg] run: cmd={:?} args={:?}", cmd, full_args));
    crate::logging::log_bytes(app, "[ffmpeg][stdout] ", &out.stdout);
    crate::logging::log_bytes(app, "[ffmpeg][stderr] ", &out.stderr);

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
    // Use forward slashes and escape characters that can break ffmpeg filter args.
    // Note: ffmpeg filtergraph parsing can be sensitive even when values are quoted.
    let s = p.to_string_lossy().replace('\\', "/");
    s.replace(':', "\\:")
        .replace('\'', "\\'")
        .replace(',', "\\,")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

/// Return a `:fontfile='...'` fragment for the drawtext filter on platforms
/// where fontconfig is unavailable (Windows, Android).  Returns an empty
/// string on Linux/macOS where fontconfig handles font discovery.
pub(crate) fn drawtext_fontfile_opt() -> String {
    #[cfg(target_os = "windows")]
    {
        // Prefer fonts that usually exist on Windows and support Japanese.
        let candidates = [
            r"C:\\Windows\\Fonts\\meiryo.ttc",
            r"C:\\Windows\\Fonts\\YuGothR.ttc",
            r"C:\\Windows\\Fonts\\msgothic.ttc",
        ];
        for c in candidates {
            let p = Path::new(c);
            if p.is_file() {
                return format!(":fontfile='{}'", escape_filter_path(p));
            }
        }
    }

    #[cfg(target_os = "android")]
    {
        // Android system fonts that support Japanese / CJK.
        let candidates = [
            "/system/fonts/NotoSansCJK-Regular.ttc",
            "/system/fonts/NotoSansJP-Regular.otf",
            "/system/fonts/DroidSansFallback.ttf",
            "/system/fonts/Roboto-Regular.ttf",
        ];
        for c in candidates {
            let p = Path::new(c);
            if p.is_file() {
                return format!(":fontfile='{}'", escape_filter_path(p));
            }
        }
    }

    String::new()
}

fn build_gap_clip_args(
    out_path: &Path,
    w: u32,
    h: u32,
    dur_sec: f32,
    model_txt_path: &Path,
    label_txt_path: &Path,
    credit_txt_path: Option<&Path>,
) -> Vec<String> {
    let dur = dur_sec.max(0.1);
    let color = format!("color=c=black:s={}x{}:d={:.3}", w.max(1), h.max(1), dur);

    let font_opt = drawtext_fontfile_opt();
    let mut vf_parts: Vec<String> = vec![
        format!(
            "drawtext=textfile='{}'{}:x=(w-text_w)/2:y=8:fontcolor=white:fontsize=26:box=1:boxcolor=black@0.35:boxborderw=8",
            escape_filter_path(model_txt_path),
            font_opt
        ),
        format!(
            // Center label big on black screen.
            "drawtext=textfile='{}'{}:x=(w-text_w)/2:y=(h-text_h)/2:fontcolor=white:fontsize=56:box=1:boxcolor=black@0.35:boxborderw=12",
            escape_filter_path(label_txt_path),
            font_opt
        ),
    ];

    if let Some(credit_path) = credit_txt_path {
        // Credits (small, bottom). Keep it subtle but readable.
        vf_parts.push(format!(
            "drawtext=textfile='{}'{}:x=(w-text_w)/2:y=h-text_h-14:fontcolor=white:fontsize=18:line_spacing=4:box=1:boxcolor=black@0.35:boxborderw=8",
            escape_filter_path(credit_path),
            font_opt
        ));
    }

    let vf = vf_parts.join(",");

    let mut args = vec![
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
    ];
    args.extend(h264_encoding_args());
    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        out_path.to_string_lossy().to_string(),
    ]);
    args
}

pub(crate) fn create_gap_clip_with_text(
    app: &AppHandle,
    out_path: &Path,
    w: u32,
    h: u32,
    dur_sec: f32,
    model_txt_path: &Path,
    label_txt_path: &Path,
    credit_txt_path: Option<&Path>,
) -> Result<()> {
    let args = build_gap_clip_args(
        out_path,
        w,
        h,
        dur_sec,
        model_txt_path,
        label_txt_path,
        credit_txt_path,
    );
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
        let args = build_gap_clip_args(out_path, 640, 480, 2.0, model_txt, label_txt, None);

        assert!(args.iter().any(|a| a.contains("drawtext=textfile='")));
        assert_eq!(args.last().map(|s| s.as_str()), Some("/tmp/out.mp4"));
        assert!(args.iter().any(|a| a.starts_with("color=c=black:s=640x480")));
    }
}
