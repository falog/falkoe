use std::path::Path;

use super::ffmpeg::escape_filter_path;

fn windows_drawtext_fontfile_opt() -> String {
    if !cfg!(target_os = "windows") {
        return String::new();
    }

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

    String::new()
}

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

pub(crate) fn build_segment_filter_complex(
    model_txt_path: &Path,
    label_txt_path: &Path,
    subtitle_srt_path: Option<&Path>,
    x_expr: &str,
    y_i: i32,
) -> (String, String) {
    // Animate playhead using overlay with a thin orange bar.
    // This avoids drawbox-eval issues on some ffmpeg builds.
    let font_opt = windows_drawtext_fontfile_opt();
    let base_chain = vec![
        format!(
            "drawtext=textfile='{}'{}:x=(w-text_w)/2:y=8:fontcolor=white:fontsize=26:box=1:boxcolor=black@0.35:boxborderw=8",
            escape_filter_path(model_txt_path),
            font_opt
        ),
        format!(
            "drawtext=textfile='{}'{}:x=12:y=8:fontcolor=white:fontsize=22:box=1:boxcolor=black@0.35:boxborderw=8",
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
        s.push_str(":force_style='Alignment=2,Fontsize=28,Outline=1,Shadow=0,MarginV=40'");
        s
    });

    let mut filter_complex = String::new();
    filter_complex.push_str(&format!("[0:v]{base_chain}[v0];"));
    filter_complex.push_str("[2:v]format=rgba[ph];");
    // Note: no eval option here; most builds evaluate x/y each frame by default.
    filter_complex.push_str(&format!("[v0][ph]overlay=x={}:y={}[v1]", x_expr, y_i));

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
