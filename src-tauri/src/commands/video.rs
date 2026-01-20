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
use std::io::Write;

fn truncate_chars_with_ellipsis(s: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return "…".to_string();
    }
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max_chars {
            out.push('…');
            return out;
        }
        out.push(ch);
    }
    out
}

fn wrap_text_for_drawtext(text: &str, max_chars_per_line: usize, max_lines: usize) -> String {
    let mut rest = text.trim().to_string();
    if rest.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = Vec::new();
    while !rest.is_empty() {
        let n = rest.chars().count();
        if n <= max_chars_per_line {
            lines.push(rest.clone());
            break;
        }
        // Take the first max_chars_per_line chars, then backtrack to a break char.
        let mut split_pos = max_chars_per_line;
        let head: String = rest.chars().take(max_chars_per_line).collect();
        for (i, ch) in head.chars().enumerate() {
            if (ch == ' '
                || ch == '、'
                || ch == '。'
                || ch == ','
                || ch == '，'
                || ch == '．'
                || ch == '.'
                || ch == '!'
                || ch == '！'
                || ch == '?'
                || ch == '？')
                && i > 0
            {
                split_pos = i + 1;
            }
        }
        let a: String = rest.chars().take(split_pos).collect();
        let b: String = rest.chars().skip(split_pos).collect();
        if !a.trim().is_empty() {
            lines.push(a.trim().to_string());
        }
        rest = b.trim_start().to_string();
        if lines.len() >= max_lines {
            if !rest.is_empty() {
                if let Some(last) = lines.last_mut() {
                    if !last.ends_with(' ') {
                        last.push(' ');
                    }
                    last.push_str(&rest);
                }
            }
            break;
        }
    }
    // Important: write real newlines. ("\\n" would render as "n" in drawtext.)
    lines.join("\n")
}
use segment::{
    build_paged_crop_and_playhead_expr, build_playhead_x_expr,
    build_segment_filter_complex, build_segment_filter_complex_ex,
};
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
    credit_text: Option<String>,
    segments: Vec<VideoSegmentReq>,
) -> Result<String, String> {
    let res = catch_unwind(AssertUnwindSafe(|| {
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
        // Temp artifacts live under OS temp dir to avoid path/encoding issues
        // with ffmpeg/libass (subtitles filter), and to keep paths short.
        let tmp_root = app
            .path()
            .temp_dir()
            .or_else(|_| app.path().cache_dir())
            .unwrap_or_else(|_| std::env::temp_dir());
        let tmp_dir = tmp_root
            .join("falkoe")
            .join("video")
            .join(format!("run-{run_id}"));
        fs::create_dir_all(&tmp_dir)
            .with_context(|| format!("failed to create tmp_dir: {tmp_dir:?}"))?;

        // Ensure temp artifacts under Documents/falkoe/tmp/video/... are removed when this
        // command finishes (success or error).
        let _tmp_cleanup = TmpDirCleanup { dir: tmp_dir.clone() };

        let model_txt_path = tmp_dir.join("model.txt");
        fs::write(&model_txt_path, model_text.replace('\n', " "))?;

        let credit_txt_path: Option<PathBuf> = credit_text
            .as_deref()
            .map(|s| s.replace('\r', ""))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(|s| {
                let p = tmp_dir.join("credit.txt");

                // Prefer exactly two lines (sentence / audio). Avoid auto-wrapping at odd places.
                let mut lines: Vec<String> = s
                    .split('\n')
                    .map(|l| l.trim())
                    .filter(|l| !l.is_empty())
                    .map(|l| l.to_string())
                    .collect();

                if lines.len() == 1 {
                    // Fallback: split the common delimiter if the caller didn't provide newlines.
                    if let Some((a, b)) = lines[0].split_once(" / ") {
                        lines = vec![a.trim().to_string(), b.trim().to_string()];
                    }
                }

                if lines.len() > 2 {
                    lines.truncate(2);
                }

                // Clamp each line to a reasonable width so it won't run off-screen.
                // (drawtext doesn't auto-wrap; long lines would just overflow.)
                let max_chars_per_line = 80;
                for l in &mut lines {
                    *l = truncate_chars_with_ellipsis(l, max_chars_per_line);
                }

                fs::write(&p, lines.join("\n"))?;
                Ok::<_, anyhow::Error>(p)
            })
            .transpose()?;

        let gap_secs: f32 = 2.0;
        let out_w: u32 = 750;

        // Clips to concat: (gap-before-seg0 + seg0 + gap-before-seg1 + seg1 + ...)
        let mut clip_paths: Vec<PathBuf> = Vec::new();

        for (i, seg) in segments.iter().enumerate() {
            let wav_in = PathBuf::from(&seg.wav_path);
            let chart_in = PathBuf::from(&seg.chart_png_path);
            if !wav_in.exists() {
                bail!("missing wav: {:?}", wav_in);
            }
            if !chart_in.exists() {
                bail!("missing chart png: {:?}", chart_in);
            }

            // Copy inputs under tmp_dir to avoid potential path/encoding issues in ffmpeg/libass.
            let wav = tmp_dir.join(format!("audio_{i}.wav"));
            let chart = tmp_dir.join(format!("chart_{i}.png"));
            fs::copy(&wav_in, &wav).with_context(|| {
                format!("failed to copy wav into tmp_dir: {wav_in:?} -> {wav:?}")
            })?;
            fs::copy(&chart_in, &chart).with_context(|| {
                format!("failed to copy chart png into tmp_dir: {chart_in:?} -> {chart:?}")
            })?;

            let pitch_txt = fs::read_to_string(&seg.pitch_json_path)
                .with_context(|| format!("failed to read pitch: {}", seg.pitch_json_path))?;
            let pitch: PitchAnalysisJson = serde_json::from_str(&pitch_txt)
                .with_context(|| format!("failed to parse pitch: {}", seg.pitch_json_path))?;

            let (ws, we, wd) = compute_window(&pitch);

            // If the chart is only slightly wider than the output, scale it down instead of
            // triggering panning/cropping.
            let scale_down = seg.chart_width_px > out_w + 1 && seg.chart_width_px <= out_w + 320;
            let eff_chart_w: u32 = if scale_down { out_w } else { seg.chart_width_px };

            let sx = eff_chart_w as f32 / seg.view_box_w.max(1) as f32;
            let sy = seg.chart_height_px as f32 / seg.view_box_h.max(1) as f32;

            let playhead_w: u32 = 3;
            let y = seg.pad_y * sy;
            let h = seg.plot_h * sy;
            let y_i: i32 = y.round().max(0.0) as i32;
            let h_i: u32 = h.round().max(1.0) as u32;
            let px = seg.pad_x;
            let pw = seg.plot_w;
            let x_expr_abs = build_playhead_x_expr(sx, px, pw, ws, we, wd);

            // If the chart is wider than the output, auto-pan the video to the right
            // as playback progresses (i.e. simulate horizontal scrolling).
            let pan = !scale_down && seg.chart_width_px > out_w + 1;
            let (crop_x_expr, x_expr) = if pan {
                // Prefer page-style cropping for readability (screen 1 -> screen 2 ...).
                // (Keep the continuous helper around for future tuning.)
                let (cx, px_on_screen) = build_paged_crop_and_playhead_expr(
                    sx,
                    px,
                    pw,
                    ws,
                    we,
                    wd,
                    seg.chart_width_px,
                    out_w,
                );
                (Some(cx), px_on_screen)
            } else {
                (None, x_expr_abs)
            };

            let label_txt_path = tmp_dir.join(format!("label_{i}.txt"));
            let model_txt_path = tmp_dir.join("model.txt");

            // Add a header area so title/label won't cover the chart.
            let top_pad: u32 = 96;
            let out_h: u32 = seg.chart_height_px + top_pad;
            let y_i_with_pad: i32 = y_i + top_pad as i32;

            // Avoid aggressive wrapping: prefer fewer line breaks for the sentence title.
            let wrapped_model = wrap_text_for_drawtext(&model_text.replace('\n', " "), 34, 2);
            let wrapped_label = wrap_text_for_drawtext(&seg.label, 18, 3);
            let mut f = std::fs::File::create(&model_txt_path)?;
            f.write_all(wrapped_model.as_bytes())?;
            let mut f2 = std::fs::File::create(&label_txt_path)?;
            f2.write_all(wrapped_label.as_bytes())?;

            // Black gap clip (with title/label) before this segment
            let gap_out = tmp_dir.join(format!("gap_{i}.mp4"));

            // Only show credits on the reference "Model" screen.
            // (The UI creates segments with Model as the first segment.)
            let credit_for_gap = if i == 0 { credit_txt_path.as_deref() } else { None };
            create_gap_clip_with_text(
                &app,
                &gap_out,
                out_w,
                out_h,
                gap_secs,
                &model_txt_path,
                &label_txt_path,
                credit_for_gap,
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

            let (filter_complex, out_label) = if pan {
                build_segment_filter_complex_ex(
                    &model_txt_path,
                    &label_txt_path,
                    subtitle_srt_path.as_deref(),
                    &x_expr,
                    y_i_with_pad,
                    top_pad,
                    None,
                    Some(out_w),
                    crop_x_expr.as_deref(),
                    None,
                )
            } else {
                build_segment_filter_complex(
                    &model_txt_path,
                    &label_txt_path,
                    subtitle_srt_path.as_deref(),
                    &x_expr,
                    y_i_with_pad,
                    top_pad,
                    if scale_down { Some(out_w) } else { None },
                )
            };
            let seg_out = tmp_dir.join(format!("seg_{i}.mp4"));

            let playhead_src = format!(
                "color=c=orange:s={}x{}:r=30:d={:.3}",
                playhead_w, h_i, wd
            );
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
                playhead_src,
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

            run_ffmpeg(&app, &args).with_context(|| {
                if let Some(ref srt) = subtitle_srt_path {
                    let meta = fs::metadata(srt).ok();
                    let readable = fs::File::open(srt).is_ok();
                    format!(
                        "segment {i}: ffmpeg failed (subtitle_srt={:?}, exists={}, readable={}, size={})",
                        srt,
                        meta.is_some(),
                        readable,
                        meta.map(|m| m.len()).unwrap_or(0)
                    )
                } else {
                    format!("segment {i}: ffmpeg failed")
                }
            })?;

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
        })()
    }));

    match res {
        Ok(r) => r.map_err(|e| {
            // Ant Design message/toast does not render newlines well.
            // Keep the user-facing string single-line, but log details.
            let pretty = format!("{:#}", e);
            crate::logging::log_line(
                &app,
                format!(
                    "[video] export_practice_video error: {}",
                    crate::logging::truncate_for_log(&pretty, 16000)
                ),
            );

            // Prefer showing ffmpeg stderr tail (the actionable part) over the full cmd.
            let stderr_tail = pretty
                .split("stderr (tail):")
                .nth(1)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty());

            let msg = if let Some(tail) = stderr_tail {
                format!("ffmpeg failed | {}", tail.replace('\n', " | "))
            } else {
                pretty.replace('\n', " | ")
            };

            crate::logging::truncate_for_log(&msg, 1400)
        }),
        Err(payload) => {
            let msg = crate::logging::panic_payload_to_string(&*payload);
            crate::logging::log_line(&app, format!("[video] panic in export_practice_video (caught): {msg}"));
            Err("panic in export_practice_video (caught)".to_string())
        }
    }
}
