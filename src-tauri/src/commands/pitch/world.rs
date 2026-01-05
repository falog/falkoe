use anyhow::{bail, Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
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
        // dev layout
        resource_dir.join("resources").join("bin").join(&exe_name),
        resource_dir.join("resources").join(&exe_name),
    ];

    candidates.into_iter().find(|p| p.is_file())
}

fn resolve_world_cmd_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();

    // Prefer bundled tool.
    if let Some(p) = resolve_bundled_tool(app, "world_pitch") {
        out.push(p);
    }

    // Then PATH.
    if cfg!(target_os = "windows") {
        out.push(PathBuf::from("world_pitch.exe"));
    } else {
        out.push(PathBuf::from("world_pitch"));
    }

    out
}

fn parse_tsv_two_cols(path: &Path, expected_len: usize) -> Result<Vec<Option<f32>>> {
    let s = fs::read_to_string(path)
        .with_context(|| format!("failed to read WORLD TSV: {}", path.display()))?;

    let mut out: Vec<Option<f32>> = Vec::new();
    for line in s.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // allow comments
        if line.starts_with('#') {
            continue;
        }

        let mut it = line.split('\t');
        let _t = it.next();
        let f0 = it.next();
        let f0 = match f0 {
            Some(v) => v.trim(),
            None => continue,
        };

        let v = f0.parse::<f32>().ok();
        let v = match v {
            Some(v) if v.is_finite() && v > 0.0 => Some(v),
            _ => None,
        };
        out.push(v);
    }

    // If the tool outputs fewer frames than expected, pad to keep downstream alignment stable.
    if out.len() < expected_len {
        out.resize(expected_len, None);
    }

    Ok(out)
}

/// Extract F0 using an external WORLD-based helper binary.
///
/// Expected helper:
/// - name: world_pitch(.exe)
/// - invocation: world_pitch <wav_path> <out_tsv_path> <time_step> <pitch_floor> <pitch_ceiling>
/// - output TSV: "time<TAB>f0_hz" lines (no header required)
pub(crate) fn extract_f0_with_world(
    app: &AppHandle,
    wav_path: &Path,
    time_step: f32,
    pitch_floor: f32,
    pitch_ceiling: f32,
) -> Result<Vec<Option<f32>>> {
    let cmd_candidates = resolve_world_cmd_candidates(app);

    // Keep artifacts under app-owned storage (avoid /tmp).
    let base_dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())?;

    let tmp_dir = base_dir.join("world_tmp");
    fs::create_dir_all(&tmp_dir)?;

    // We want a stable number of frames for downstream alignment.
    // Use expected_len based on time_step and wav duration isn't available here cheaply,
    // so we will accept whatever length we get and let downstream handle it.
    let expected_len = 0usize;

    let out_path = tmp_dir.join(format!(
        "pitch_world_{}_{}.tsv",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));

    let mut last_err: Option<anyhow::Error> = None;
    for cmd in cmd_candidates {
        let out = Command::new(&cmd)
            .args([
                wav_path
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid wav path"))?,
                out_path
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid out path"))?,
                &format!("{time_step}"),
                &format!("{pitch_floor}"),
                &format!("{pitch_ceiling}"),
            ])
            .output();

        match out {
            Ok(out) => {
                if out.status.success() {
                    return parse_tsv_two_cols(&out_path, expected_len);
                }
                let stderr = String::from_utf8_lossy(&out.stderr);
                last_err = Some(anyhow::anyhow!(
                    "WORLD helper failed (cmd={:?}) stderr: {}",
                    cmd,
                    stderr.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
                ));
                continue;
            }
            Err(e) => {
                last_err = Some(anyhow::Error::new(e).context(format!(
                    "failed to spawn WORLD helper: {:?}",
                    cmd
                )));
                continue;
            }
        }
    }

    if let Some(e) = last_err {
        return Err(e);
    }

    bail!("WORLD helper not found (world_pitch). Place it at resources/bin/world_pitch(.exe) or install it on PATH.")
}
