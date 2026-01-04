use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct PitchAnalysisJson {
    pub(crate) time_step: f32,
    pub(crate) f0_rel: Vec<Option<f32>>,
    pub(crate) words: Option<Vec<PitchWordJson>>,
    pub(crate) segments: Option<Vec<PitchWordJson>>,
}

#[derive(Deserialize)]
pub(crate) struct PitchWordJson {
    pub(crate) start: f32,
    pub(crate) end: f32,
    #[allow(dead_code)]
    pub(crate) text: Option<String>,
}

pub(crate) fn compute_window(pitch: &PitchAnalysisJson) -> (f32, f32, f32) {
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
