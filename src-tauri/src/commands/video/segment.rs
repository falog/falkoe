use std::path::Path;

use super::ffmpeg::{drawtext_fontfile_opt, escape_filter_path};

pub(crate) fn build_playhead_x_expr(
    sx: f32,
    pad_x: f32,
    plot_w: f32,
    ws: f32,
    we: f32,
    wd: f32,
) -> String {
    // ffmpeg expression syntax is picky; keep the expression simple.
    // Map time t in [ws,we] to chart-x in pixels.
    // Instead of x = sx*(padX + frac*plotW) (outer parentheses can be fragile on some builds),
    // distribute: x = sx*padX + sx*plotW*frac.
    let x_expr_raw = format!(
        "{sx:.6}*{pad_x:.6}+{sx:.6}*{plot_w:.6}*((min(max(t,{ws:.4}),{we:.4})-{ws:.4})/{wd:.4})",
    );

    // Important: commas inside expressions must be escaped (\\,) because
    // ffmpeg uses commas to separate filters in a filterchain.
    x_expr_raw.replace(',', "\\,")
}

#[allow(dead_code)]
pub(crate) fn build_pan_crop_and_playhead_expr(
    sx: f32,
    pad_x: f32,
    plot_w: f32,
    ws: f32,
    we: f32,
    wd: f32,
    chart_w: u32,
    out_w: u32,
) -> (String, String) {
    // Pan the background from left -> right across the full chart as time progresses.
    // This makes the chart visibly scroll, and the playhead will move across the screen.
    let max_x = chart_w.saturating_sub(out_w) as f32;

    // frac(t) in [0,1]
    let frac = format!(
        "((min(max(t,{ws:.4}),{we:.4})-{ws:.4})/{wd:.4})",
    );

    // Absolute playhead position in input pixels.
    let play_abs = format!(
        "{sx:.6}*{pad_x:.6}+{sx:.6}*{plot_w:.6}*{frac}",
    );

    // Crop x in input pixels: move window from 0 -> max_x.
    let crop_x_raw = format!("min(max({max_x:.3}*{frac},0),{max_x:.3})");

    // Overlay x is in the cropped coordinate system.
    let play_screen_raw = format!("({play_abs})-({crop_x_raw})");

    (
        crop_x_raw.replace(',', "\\,"),
        play_screen_raw.replace(',', "\\,"),
    )
}

pub(crate) fn build_paged_crop_and_playhead_expr(
    sx: f32,
    pad_x: f32,
    plot_w: f32,
    ws: f32,
    we: f32,
    wd: f32,
    chart_w: u32,
    out_w: u32,
) -> (String, String) {
    // Page-style scrolling: instead of continuous pan, jump the crop window in `out_w`
    // increments based on the playhead's absolute x position.
    // This tends to keep subtitles/text more readable.
    let max_x = chart_w.saturating_sub(out_w) as f32;

    // frac(t) in [0,1]
    let frac = format!(
        "((min(max(t,{ws:.4}),{we:.4})-{ws:.4})/{wd:.4})",
    );

    // Absolute playhead position in input pixels.
    let play_abs = format!(
        "{sx:.6}*{pad_x:.6}+{sx:.6}*{plot_w:.6}*{frac}",
    );

    // Crop x snaps to page boundaries: floor(play_abs/out_w)*out_w.
    // Clamp to [0, max_x] so we never go out of bounds.
    let out_w_f = out_w as f32;
    let crop_x_raw = format!(
        "min(max(floor(({play_abs})/{out_w_f:.3})*{out_w_f:.3},0),{max_x:.3})"
    );

    let play_screen_raw = format!("({play_abs})-({crop_x_raw})");

    (
        crop_x_raw.replace(',', "\\,"),
        play_screen_raw.replace(',', "\\,"),
    )
}

pub(crate) fn build_segment_filter_complex(
    model_txt_path: &Path,
    label_txt_path: &Path,
    subtitle_srt_path: Option<&Path>,
    x_expr: &str,
    y_i: i32,
    top_pad: u32,
    scale_w: Option<u32>,
) -> (String, String) {
    build_segment_filter_complex_ex(
        model_txt_path,
        label_txt_path,
        subtitle_srt_path,
        x_expr,
        y_i,
        top_pad,
        scale_w,
        None,
        None,
        None,
    )
}

pub(crate) fn build_segment_filter_complex_ex(
    model_txt_path: &Path,
    label_txt_path: &Path,
    subtitle_srt_path: Option<&Path>,
    x_expr: &str,
    y_i: i32,
    top_pad: u32,
    scale_w: Option<u32>,
    crop_w: Option<u32>,
    crop_x_expr: Option<&str>,
    playhead_x_const: Option<i32>,
) -> (String, String) {
    // Animate playhead using overlay with a thin orange bar.
    // This avoids drawbox-eval issues on some ffmpeg builds.
    let font_opt = drawtext_fontfile_opt();
    let base_chain = vec![
        format!(
            "drawtext=textfile='{}'{}:x=(w-text_w)/2:y=8:fontcolor=white:fontsize=24:line_spacing=4:box=1:boxcolor=black@0.35:boxborderw=8",
            escape_filter_path(model_txt_path),
            font_opt
        ),
        format!(
            "drawtext=textfile='{}'{}:x=12:y=52:fontcolor=white:fontsize=20:line_spacing=4:box=1:boxcolor=black@0.35:boxborderw=8",
            escape_filter_path(label_txt_path),
            font_opt
        ),
    ]
    .join(",");

    let subtitle_chain: Option<String> = subtitle_srt_path.map(|srt_path| {
        let mut s = format!("subtitles='{}'", escape_filter_path(srt_path));
        if cfg!(target_os = "windows") {
            s.push_str(":charenc=UTF-8");
            s.push_str(&format!(
                ":fontsdir='{}'",
                escape_filter_path(Path::new(r"C:\\Windows\\Fonts"))
            ));
        }
        // Add side margins to avoid truncation and keep size modest for 750px wide videos.
        // iPhone/Photos playback can feel like subtitles sit "too high"; keep them lower by
        // reducing the bottom margin (MarginV) and shrinking the font.
        // Note: libass uses its own units; Fontsize=15 is roughly ~12px feel at our output size.
        s.push_str(":force_style='Alignment=2,Fontsize=15,Outline=1,Shadow=0,MarginV=18,MarginL=24,MarginR=24,WrapStyle=0'");
        s
    });

    let mut filter_complex = String::new();

    // Optionally scale the chart horizontally to a fixed width (e.g. 750px) to avoid
    // triggering panning for slightly-wide charts.
    let mut v_in = "0:v".to_string();
    if let Some(sw) = scale_w {
        filter_complex.push_str(&format!("[0:v]scale=w={sw}:h=ih[s0];"));
        v_in = "s0".to_string();
    }

    if let (Some(w), Some(xe)) = (crop_w, crop_x_expr) {
        // Note: some ffmpeg builds don't support crop's eval option.
        // Using an x-expression that references `t` is usually enough for animation.
        filter_complex.push_str(&format!("[{v_in}]crop=w={w}:h=ih:x={xe}:y=0[c0];"));
        // Move the chart down by top_pad pixels, and draw header text into the padded area.
        filter_complex.push_str(&format!("[c0]pad=w=iw:h=ih+{top_pad}:x=0:y={top_pad}:color=black[p0];"));
        filter_complex.push_str(&format!("[p0]{base_chain}[v0];"));
    } else {
        filter_complex.push_str(&format!("[{v_in}]pad=w=iw:h=ih+{top_pad}:x=0:y={top_pad}:color=black[p0];"));
        filter_complex.push_str(&format!("[p0]{base_chain}[v0];"));
    }
    filter_complex.push_str("[2:v]format=rgba[ph];");
    // Note: no eval option here; most builds evaluate x/y each frame by default.
    let px = if let Some(v) = playhead_x_const {
        v.to_string()
    } else {
        x_expr.to_string()
    };
    filter_complex.push_str(&format!("[v0][ph]overlay=x={}:y={}[v1]", px, y_i));

    let out_label = if let Some(sub) = subtitle_chain {
        filter_complex.push_str(&format!(";[v1]{sub}[vout]"));
        "vout".to_string()
    } else {
        "v1".to_string()
    };

    (filter_complex, out_label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_playhead_x_expr_escapes_commas() {
        let expr = build_playhead_x_expr(1.0, 10.0, 100.0, 0.0, 1.0, 1.0);
        assert!(expr.contains("\\,"));
        assert!(expr.contains("min(max(t"));
    }

    #[test]
    fn build_segment_filter_complex_selects_vout_when_subtitles_present() {
        let (fc, out_label) = build_segment_filter_complex(
            Path::new("/tmp/model.txt"),
            Path::new("/tmp/label.txt"),
            Some(Path::new("/tmp/sub.srt")),
            "1.0",
            12,
        );
        assert_eq!(out_label, "vout");
        assert!(fc.contains("subtitles='"));
        assert!(fc.contains("[vout]"));
    }

    #[test]
    fn build_segment_filter_complex_selects_v1_without_subtitles() {
        let (fc, out_label) = build_segment_filter_complex(
            Path::new("/tmp/model.txt"),
            Path::new("/tmp/label.txt"),
            None,
            "1.0",
            12,
        );
        assert_eq!(out_label, "v1");
        assert!(!fc.contains("subtitles='"));
        assert!(fc.contains("[v1]"));
    }
}
