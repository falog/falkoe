mod ffmpeg;
mod paths;
mod segment;
mod srt;
mod window;

use anyhow::{bail, Context, Result};
use std::fs;
use std::path::PathBuf;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Manager;

use ffmpeg::{create_gap_clip_with_text, run_ffmpeg};
use paths::{pick_unique_mp4_path, sanitize_base_name};
use segment::{build_playhead_x_expr, build_segment_filter_complex};
use srt::generate_srt;
use window::{compute_window, PitchAnalysisJson};

fn remove_dir_all_best_effort(dir: &PathBuf) {
    // Best-effort cleanup: on Windows especially, files can be briefly locked.
    // We retry a couple of times and then give up silently.
    for i in 0..3 {
        match fs::remove_dir_all(dir) {
            Ok(_) => return,
            Err(e) => {
                // Not found is fine.
                if e.kind() == std::io::ErrorKind::NotFound {
                    return;
                }
                // Backoff a bit and retry.
                if i < 2 {
                    std::thread::sleep(Duration::from_millis(60 * (i as u64 + 1)));
                    continue;
                }
            }
        }
    }
}

struct TmpDirCleanup {
    dir: PathBuf,
}

impl Drop for TmpDirCleanup {
    fn drop(&mut self) {
        remove_dir_all_best_effort(&self.dir);
    }
}

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

#[tauri::command]
pub fn export_practice_video(
    app: AppHandle,
    output_dir: String,
    output_base: String,
    model_text: String,
    segments: Vec<VideoSegmentReq>,
) -> Result<String, String> {
    let res = catch_unwind(AssertUnwindSafe(|| (|| -> Result<String> {
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

        // Ensure temp artifacts under Documents/falkoe/tmp/video/... are removed when this
        // command finishes (success or error).
        let _tmp_cleanup = TmpDirCleanup { dir: tmp_dir.clone() };

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
            let x_expr = build_playhead_x_expr(sx, px, pw, ws, we, wd);

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

            let mut subtitle_srt_path: Option<PathBuf> = None;
            if let Some(tpath) = seg.transcript_json_path.as_ref() {
                let tp = PathBuf::from(tpath);
                if tp.exists() {
                    let srt_path = tmp_dir.join(format!("sub_{i}.srt"));
                    generate_srt(&tp, &srt_path)?;
                    subtitle_srt_path = Some(srt_path);
                }
            }

            let (filter_complex, out_label) = build_segment_filter_complex(
                &model_txt_path,
                &label_txt_path,
                subtitle_srt_path.as_deref(),
                &x_expr,
                y_i,
            );
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
            ];
            run_ffmpeg(&app, &args_reenc)?;
        }

        Ok(out_path.to_string_lossy().to_string())
    })()));

    match res {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(payload) => {
            let msg = crate::logging::panic_payload_to_string(&*payload);
            crate::logging::log_line(&app, format!("[video] panic in export_practice_video (caught): {msg}"));
            Err("panic in export_practice_video (caught)".to_string())
        }
    }
}
