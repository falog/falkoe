use anyhow::{bail, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn resolve_bundled_tool(app: &AppHandle, base_name: &str) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let exe_name = if cfg!(target_os = "windows") {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    };

    // In production bundles, resource_dir typically points at the resources dir.
    // In dev, it can point at `target/debug` while resources are synced to `target/debug/resources`.
    let candidates = [
        // bundle layout
        resource_dir.join("bin").join(&exe_name),
        resource_dir.join(&exe_name),
        // dev layout
        resource_dir.join("resources").join("bin").join(&exe_name),
        resource_dir.join("resources").join(&exe_name),
    ];

    // Important: avoid picking up directories (e.g. resources/praat is a folder of scripts).
    candidates.into_iter().find(|p| p.is_file())
}

fn resolve_praat_cmd_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();

    // Prefer bundled console build.
    if let Some(p) = resolve_bundled_tool(app, "praatcon") {
        out.push(p);
    }
    if let Some(p) = resolve_bundled_tool(app, "praat") {
        out.push(p);
    }

    // Then try PATH (console first).
    if cfg!(target_os = "windows") {
        out.push(PathBuf::from("praatcon.exe"));
        out.push(PathBuf::from("praat.exe"));
    } else {
        out.push(PathBuf::from("praatcon"));
        out.push(PathBuf::from("praat"));
    }

    out
}

fn resolve_praat_script(app: &AppHandle) -> Result<PathBuf> {
    let resource_dir = app.path().resource_dir()?;

    // In production bundles, resource_dir typically points at the resources dir.
    // In dev, it can point at `target/debug` while resources are synced to `target/debug/resources`.
    let candidates = [
        // bundle layout
        resource_dir.join("praat").join("extract_pitch_to_tsv.praat"),
        // dev layout (synced by wrapper)
        resource_dir
            .join("resources")
            .join("praat")
            .join("extract_pitch_to_tsv.praat"),
        // repo layout (fallback)
        resource_dir
            .join("resources")
            .join("praat")
            .join("extract_pitch_to_tsv.praat"),
    ];

    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!(
            "praat script not found; tried: {} | {} | {}",
            candidates[0].display(),
            candidates[1].display(),
            candidates[2].display(),
        ))
}

pub(crate) fn extract_f0_with_praat(
    app: &AppHandle,
    wav_path: &Path,
    time_step: f32,
    pitch_floor: f32,
    pitch_ceiling: f32,
) -> Result<Vec<Option<f32>>> {
    let script = resolve_praat_script(app)?;

    if !script.exists() {
        bail!("praat script not found: {}", script.display());
    }

    // Keep Praat artifacts under app-owned storage (avoid /tmp).
    // app_cache_dir is preferred; fall back to app_data_dir.
    let base_dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())?;

    let tmp_dir = base_dir.join("praat_tmp");
    fs::create_dir_all(&tmp_dir)?;

    // Pick an output TSV path that is guaranteed to be a file path (not a directory).
    // Do NOT pre-create the file: the Praat script will delete/recreate it.
    let mut out_path: Option<PathBuf> = None;
    for attempt in 0..64 {
        let candidate = tmp_dir.join(format!(
            "pitch_{}_{}_{}.tsv",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            attempt
        ));

        if candidate.exists() {
            if candidate.is_dir() {
                // Don't try to delete arbitrary directories; just pick another name.
                continue;
            }
            let _ = fs::remove_file(&candidate);
        }

        out_path = Some(candidate);
        break;
    }

    let out_path = out_path.ok_or_else(|| {
        anyhow::anyhow!(
            "failed to allocate a temp TSV output path under {}",
            tmp_dir.display()
        )
    })?;

    let script_s = script
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid praat script path"))?
        .to_string();
    let wav_s = wav_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid wav path"))?
        .to_string();
    let out_s = out_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid out path"))?
        .to_string();

    // Praat scripts with a `form` can be called by passing arguments in order.
    // Try multiple candidates because some installs only provide GUI praat (or it fails in headless).
    let mut errors: Vec<String> = Vec::new();
    let mut ok = false;
    for praat in resolve_praat_cmd_candidates(app) {
        let mut cmd = Command::new(&praat);
        cmd.args([
            "--run",
            &script_s,
            &wav_s,
            &out_s,
            &format!("{time_step}"),
            &format!("{pitch_floor}"),
            &format!("{pitch_ceiling}"),
        ])
        // Praat sometimes prints errors like "script command ... not completed".
        // We handle errors ourselves (and fall back), so keep this quiet.
        .stdout(Stdio::null())
        .stderr(Stdio::null());

        // Avoid spawning a black console window on Windows.
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!("- cmd={:?}\n  error={}", praat, e));
                continue;
            }
        };

        // Guard against GUI/hanging praat builds: timeout and fall back to YIN.
        let timeout = std::time::Duration::from_secs(10);
        let start = std::time::Instant::now();
        let mut timed_out = false;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if status.success() {
                        ok = true;
                    } else {
                        #[cfg_attr(target_os = "windows", allow(unused_mut))]
                        let mut line = format!("- cmd={:?}\n  status={}", praat, status);
                        #[cfg(not(target_os = "windows"))]
                        {
                            if status.code() == Some(255) {
                                line.push_str("\n  hint=Praat may be a GUI build failing in headless mode. Install a console/headless Praat (praatcon) or ensure a graphical session is available.");
                            }
                        }
                        errors.push(line);
                    }
                    break;
                }
                Ok(None) => {
                    if start.elapsed() >= timeout {
                        timed_out = true;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(e) => {
                    errors.push(format!("- cmd={:?}\n  error={}", praat, e));
                    break;
                }
            }
        }

        if timed_out {
            let _ = child.kill();
            let _ = child.wait();
            errors.push(format!("- cmd={:?}\n  error=timeout", praat));
        }

        if ok {
            break;
        }
    }

    if !ok {
        // Best-effort cleanup of the reserved output path.
        if out_path.exists() {
            if out_path.is_dir() {
                let _ = fs::remove_dir_all(&out_path);
            } else {
                let _ = fs::remove_file(&out_path);
            }
        }

        let combined = if errors.is_empty() {
            "(no candidates tried)".to_string()
        } else {
            errors.join("\n")
        };
        bail!(
            "praat failed (script={}, wav={})\n{}",
            script.display(),
            wav_path.display(),
            combined
        );
    }

    let tsv = fs::read_to_string(&out_path)?;
    let _ = fs::remove_file(&out_path);

    let mut out = Vec::new();
    for (i, line) in tsv.lines().enumerate() {
        if i == 0 {
            // header
            continue;
        }
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        let mut it = l.split('\t');
        let _t = it.next();
        let f0s = it.next().unwrap_or("");
        let f0s = f0s.trim();
        if f0s.is_empty() || f0s.eq_ignore_ascii_case("nan") {
            out.push(None);
            continue;
        }
        let v: f32 = f0s.parse()?;
        if v.is_finite() {
            out.push(Some(v));
        } else {
            out.push(None);
        }
    }

    if out.is_empty() {
        bail!("praat returned empty pitch");
    }
    Ok(out)
}
