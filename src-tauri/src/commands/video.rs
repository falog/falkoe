use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Manager;

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoSegmentReq {
    pub label: String,
    pub wav_path: String,
    pub transcript_json_path: Option<String>,
    pub pitch_json_path: String,
    pub chart_png_path: String,
    pub chart_width_px: u32,
    pub chart_height_px: u32,
    pub view_box_w: u32,
    pub view_box_h: u32,
    pub pad_x: f32,
    pub pad_y: f32,
    pub plot_w: f32,
    pub plot_h: f32,
}

#[derive(serde::Deserialize)]
struct TranscriptJson {
    segments: Vec<TranscriptSegment>,
}

#[derive(serde::Deserialize)]
struct TranscriptSegment {
    start: f32,
    end: f32,
    text: String,
}

#[derive(serde::Deserialize)]
struct PitchAnalysisJson {
    time_step: f32,
    f0_rel: Vec<Option<f32>>,
    words: Option<Vec<PitchWordJson>>,
    segments: Option<Vec<PitchWordJson>>,
}

#[derive(serde::Deserialize)]
struct PitchWordJson {
    start: f32,
    end: f32,
    #[allow(dead_code)]
    text: Option<String>,
}

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

fn run_ffmpeg(app: &AppHandle, args: &[String]) -> Result<()> {
    let cmd = resolve_bundled_tool(app, "ffmpeg").unwrap_or_else(|| PathBuf::from("ffmpeg"));

    // Reduce output volume so we don't lose the real error due to truncation.
    let mut full_args: Vec<String> = Vec::with_capacity(args.len() + 4);
    full_args.push("-hide_banner".into());
    full_args.push("-loglevel".into());
    full_args.push("error".into());
    full_args.extend_from_slice(args);

    let out = Command::new(&cmd)
        .args(&full_args)
        .output()
        .with_context(|| format!("failed to spawn ffmpeg: {:?}", cmd))?;
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

fn strip_whisper_special_tokens(mut s: String) -> String {
    // Remove occurrences like "[_TT_100]" or "[_BEG_]".
    loop {
        let Some(i) = s.find("[_") else { break };
        let Some(j) = s[i..].find(']') else { break };
        let end = i + j + 1;
        s.replace_range(i..end, "");
    }
    s
}

fn srt_ts(t: f32) -> String {
    let t = t.max(0.0);
    let total_ms = (t * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

fn escape_filter_path(p: &Path) -> String {
    // Use forward slashes and escape ':' for filter args.
    let s = p.to_string_lossy().replace('\\', "/");
    s.replace(':', "\\:")
}

fn sanitize_base_name(s: &str) -> String {
    let mut out = String::new();
    for ch in s.trim().chars() {
        if ch.is_control() {
            continue;
        }
        let repl = matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        out.push(if repl { '_' } else { ch });
    }
    let out = out.trim().trim_end_matches(['.', ' ']).to_string();
    let out = if out.is_empty() { "falkoe".to_string() } else { out };
    // Keep it short-ish for cross-platform compatibility.
    out.chars().take(80).collect::<String>().trim().to_string()
}

fn pick_unique_mp4_path(dir: &Path, base: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{base}.mp4"));
    if !candidate.exists() {
        return candidate;
    }
    for i in 2..1000 {
        candidate = dir.join(format!("{base} ({i}).mp4"));
        if !candidate.exists() {
            return candidate;
        }
    }
        dir.join(format!("{base}-{}.mp4", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)))
}

fn create_gap_clip_with_text(
    app: &AppHandle,
    out_path: &Path,
    w: u32,
    h: u32,
    dur_sec: f32,
    model_txt_path: &Path,
    label_txt_path: &Path,
) -> Result<()> {
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

    let args: Vec<String> = vec![
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
        "-movflags".into(),
        "+faststart".into(),
        "-crf".into(),
        "28".into(),
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
    ];
    run_ffmpeg(app, &args)
}

fn compute_window(pitch: &PitchAnalysisJson) -> (f32, f32, f32) {
    let n = pitch.f0_rel.len();
    let full_end = if n <= 1 {
        0.0
    } else {
        (n as f32 - 1.0) * pitch.time_step
    };

    let mut window_start = 0.0;
    let mut window_end = full_end;

    let overlay = pitch
        .words
        .as_ref()
        .filter(|v| !v.is_empty())
        .or_else(|| pitch.segments.as_ref().filter(|v| !v.is_empty()));

    if let Some(overlay) = overlay {
        window_start = overlay
            .iter()
            .map(|w| w.start)
            .fold(full_end, |a, b| a.min(b));
        window_end = overlay
            .iter()
            .map(|w| w.end)
            .fold(0.0, |a, b| a.max(b));
    } else {
        let mut first_voiced: Option<usize> = None;
        let mut last_voiced: Option<usize> = None;
        for (i, v) in pitch.f0_rel.iter().enumerate() {
            if v.is_some() {
                first_voiced = Some(i);
                break;
            }
        }
        for (i, v) in pitch.f0_rel.iter().enumerate().rev() {
            if v.is_some() {
                last_voiced = Some(i);
                break;
            }
        }
        if let (Some(f), Some(l)) = (first_voiced, last_voiced) {
            if l >= f {
                window_start = f as f32 * pitch.time_step;
                window_end = l as f32 * pitch.time_step;
            }
        }
    }

    let pad = (pitch.time_step * 3.0).max(0.05);
    window_start = (window_start - pad).max(0.0).min(full_end);
    window_end = (window_end + pad).max(0.0).min(full_end);
    if !(window_end > window_start) {
        window_start = 0.0;
        window_end = full_end;
    }
    let dur = (window_end - window_start).max(pitch.time_step.max(0.001));
    (window_start, window_end, dur)
}

fn generate_srt(transcript_path: &Path, srt_path: &Path) -> Result<()> {
    let txt = fs::read_to_string(transcript_path)
        .with_context(|| format!("failed to read transcript: {transcript_path:?}"))?;
    let t: TranscriptJson = serde_json::from_str(&txt)
        .with_context(|| format!("failed to parse transcript: {transcript_path:?}"))?;

    let mut out = String::new();
    for (idx, seg) in t.segments.iter().enumerate() {
        let text = strip_whisper_special_tokens(seg.text.trim().to_string());
        if text.trim().is_empty() {
            continue;
        }
        out.push_str(&(idx + 1).to_string());
        out.push('\n');
        out.push_str(&format!(
            "{} --> {}\n",
            srt_ts(seg.start),
            srt_ts(seg.end)
        ));
        out.push_str(text.trim());
        out.push_str("\n\n");
    }

    fs::write(srt_path, out)?;
    Ok(())
}

#[tauri::command]
pub fn export_practice_video(
    app: AppHandle,
    output_dir: String,
    output_base: String,
    model_text: String,
    segments: Vec<VideoSegmentReq>,
) -> Result<String, String> {
    (|| -> Result<String> {
        if segments.is_empty() {
            bail!("no segments");
        }

        let out_dir = PathBuf::from(&output_dir);
        fs::create_dir_all(&out_dir)
            .with_context(|| format!("failed to create output_dir: {out_dir:?}"))?;

        let base_from_req = if output_base.trim().is_empty() {
            model_text.clone()
        } else {
            output_base.clone()
        };
        let out_base = sanitize_base_name(&base_from_req);
        let out_path = pick_unique_mp4_path(&out_dir, &out_base);

        let run_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        // Keep Videos clean: temp artifacts go under Documents/falkoe/tmp/video/...
        let doc_dir = app
            .path()
            .document_dir()
            .with_context(|| "failed to resolve document_dir")?;
        let tmp_dir = doc_dir
            .join("falkoe")
            .join("tmp")
            .join("video")
            .join(format!("{out_base}-{run_id}"));
        fs::create_dir_all(&tmp_dir)
            .with_context(|| format!("failed to create tmp_dir: {tmp_dir:?}"))?;

        let model_txt_path = tmp_dir.join("model.txt");
        fs::write(&model_txt_path, model_text.replace('\n', " "))?;

        let gap_secs: f32 = 2.0;

        // Clips to concat: (gap-before-seg0 + seg0 + gap-before-seg1 + seg1 + ...)
        let mut clip_paths: Vec<PathBuf> = Vec::new();

        for (i, seg) in segments.iter().enumerate() {
            let wav = PathBuf::from(&seg.wav_path);
            let chart = PathBuf::from(&seg.chart_png_path);
            if !wav.exists() {
                bail!("missing wav: {:?}", wav);
            }
            if !chart.exists() {
                bail!("missing chart png: {:?}", chart);
            }

            let pitch_txt = fs::read_to_string(&seg.pitch_json_path)
                .with_context(|| format!("failed to read pitch: {}", seg.pitch_json_path))?;
            let pitch: PitchAnalysisJson = serde_json::from_str(&pitch_txt)
                .with_context(|| format!("failed to parse pitch: {}", seg.pitch_json_path))?;

            let (ws, we, wd) = compute_window(&pitch);

            let sx = seg.chart_width_px as f32 / seg.view_box_w.max(1) as f32;
            let sy = seg.chart_height_px as f32 / seg.view_box_h.max(1) as f32;

            let playhead_w = 3;
            let y = seg.pad_y * sy;
            let h = seg.plot_h * sy;
            let y_i: i32 = y.round().max(0.0) as i32;
            let h_i: u32 = h.round().max(1.0) as u32;
            let px = seg.pad_x;
            let pw = seg.plot_w;
            // ffmpeg expression syntax is picky; keep the expression simple.
            // Map time t in [ws,we] to chart-x in pixels.
            // Instead of x = sx*(padX + frac*plotW) (outer parentheses can be fragile on some builds),
            // distribute: x = sx*padX + sx*plotW*frac.
            let x_expr_raw = format!(
                "{sx:.6}*{px:.6}+{sx:.6}*{pw:.6}*((min(max(t,{ws:.4}),{we:.4})-{ws:.4})/{wd:.4})",
            );
            // Important: commas inside expressions must be escaped (\,) because
            // ffmpeg uses commas to separate filters in a filterchain.
            let x_expr = x_expr_raw.replace(',', "\\,");

            let label_txt_path = tmp_dir.join(format!("label_{i}.txt"));
            fs::write(&label_txt_path, seg.label.replace('\n', " "))?;

            // Black gap clip (with title/label) before this segment
            let gap_out = tmp_dir.join(format!("gap_{i}.mp4"));
            create_gap_clip_with_text(
                &app,
                &gap_out,
                seg.chart_width_px,
                seg.chart_height_px,
                gap_secs,
                &model_txt_path,
                &label_txt_path,
            )?;
            clip_paths.push(gap_out);

            // Animate playhead using overlay with a thin orange bar.
            // This avoids drawbox-eval issues on some ffmpeg builds.
            let base_chain = vec![
                format!(
                    "drawtext=textfile='{}':x=(w-text_w)/2:y=8:fontcolor=white:fontsize=26:box=1:boxcolor=black@0.35:boxborderw=8",
                    escape_filter_path(&model_txt_path)
                ),
                format!(
                    "drawtext=textfile='{}':x=12:y=8:fontcolor=white:fontsize=22:box=1:boxcolor=black@0.35:boxborderw=8",
                    escape_filter_path(&label_txt_path)
                ),
            ]
            .join(",");

            let mut subtitle_chain: Option<String> = None;
            if let Some(tpath) = seg.transcript_json_path.as_ref() {
                let tp = PathBuf::from(tpath);
                if tp.exists() {
                    let srt_path = tmp_dir.join(format!("sub_{i}.srt"));
                    generate_srt(&tp, &srt_path)?;
                    subtitle_chain = Some(format!(
                        "subtitles='{}':force_style='Alignment=2,Fontsize=28,Outline=1,Shadow=0,MarginV=40'",
                        escape_filter_path(&srt_path)
                    ));
                }
            }

            let mut filter_complex = String::new();
            filter_complex.push_str(&format!("[0:v]{base_chain}[v0];"));
            filter_complex.push_str("[2:v]format=rgba[ph];");
            // Note: no eval option here; most builds evaluate x/y each frame by default.
            filter_complex.push_str(&format!(
                "[v0][ph]overlay=x={}:y={}[v1]",
                x_expr, y_i
            ));

            let out_label = if let Some(sub) = subtitle_chain {
                filter_complex.push_str(&format!(";[v1]{sub}[vout]"));
                "vout"
            } else {
                "v1"
            };
            let seg_out = tmp_dir.join(format!("seg_{i}.mp4"));

            let args: Vec<String> = vec![
                "-y".into(),
                "-loop".into(),
                "1".into(),
                "-i".into(),
                chart.to_string_lossy().to_string(),
                "-i".into(),
                wav.to_string_lossy().to_string(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!(
                    "color=c=orange@0.9:s={}x{}:r=30:d=3600",
                    playhead_w, h_i
                ),
                "-r".into(),
                "30".into(),
                "-filter_complex".into(),
                filter_complex,
                "-map".into(),
                format!("[{out_label}]"),
                "-map".into(),
                "1:a".into(),
                "-shortest".into(),
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "veryfast".into(),
                "-movflags".into(),
                "+faststart".into(),
                "-crf".into(),
                "28".into(),
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
                seg_out.to_string_lossy().to_string(),
            ];

            run_ffmpeg(&app, &args)?;
            clip_paths.push(seg_out);
        }

        let concat_path = tmp_dir.join("concat.txt");
        let concat_txt = clip_paths
            .iter()
            .map(|p| {
                let s = p.to_string_lossy().replace('\\', "/");
                format!("file '{}'\n", s.replace('\'', "\\'"))
            })
            .collect::<String>();
        fs::write(&concat_path, concat_txt)?;

        // Try stream copy concat first; fall back to re-encode if needed.
        let args_copy: Vec<String> = vec![
            "-y".into(),
            "-f".into(),
            "concat".into(),
            "-safe".into(),
            "0".into(),
            "-i".into(),
            concat_path.to_string_lossy().to_string(),
            "-c".into(),
            "copy".into(),
            out_path.to_string_lossy().to_string(),
        ];

        if run_ffmpeg(&app, &args_copy).is_err() {
            let args_reenc: Vec<String> = vec![
                "-y".into(),
                "-f".into(),
                "concat".into(),
                "-safe".into(),
                "0".into(),
                "-i".into(),
                concat_path.to_string_lossy().to_string(),
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "veryfast".into(),
                "-movflags".into(),
                "+faststart".into(),
                "-crf".into(),
                "28".into(),
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
            ];
            run_ffmpeg(&app, &args_reenc)?;
        }

        Ok(out_path.to_string_lossy().to_string())
    })()
    .map_err(|e| e.to_string())
}
