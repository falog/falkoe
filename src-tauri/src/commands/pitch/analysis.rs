use anyhow::Result;
use std::{fs, path::Path};

use super::{
    features::{
        adjust_span_to_voiced, estimate_accent_label, segment_features, time_to_index_ceil,
        time_to_index_floor,
    },
    paths::transcript_json_path,
    types::{SegmentPitch, Transcript, WordPitch},
};

pub(crate) fn build_segments_words(
    wav_path: &Path,
    time_step: f32,
    f0_rel: &[Option<f32>],
    include_segments: bool,
) -> Result<(Option<Vec<SegmentPitch>>, Option<Vec<WordPitch>>)> {
    if !include_segments {
        return Ok((None, None));
    }

    let tj = transcript_json_path(wav_path);
    if !tj.exists() {
        return Ok((None, None));
    }

    let s = fs::read_to_string(&tj)?;
    let t: Transcript = serde_json::from_str(&s)?;

    let mut segments_out = Vec::with_capacity(t.segments.len());
    for seg in &t.segments {
        let si = time_to_index_floor(seg.start, time_step);
        let ei = time_to_index_ceil(seg.end, time_step);

        if si >= f0_rel.len() || ei <= si {
            segments_out.push(SegmentPitch {
                start: seg.start,
                end: seg.end,
                text: seg.text.clone(),
                label: None,
                peak_pos: None,
                pitch_range: None,
                slope: None,
            });
            continue;
        }

        let base_ei = ei.min(f0_rel.len());
        let base_slice = if si < base_ei { &f0_rel[si..base_ei] } else { &[] };
        let mut voiced: Vec<f32> = base_slice.iter().copied().flatten().collect();

        // If there are no voiced frames inside the original segment span, expand and snap.
        if voiced.is_empty() {
            let adj = adjust_span_to_voiced(si, base_ei, f0_rel, 8);
            let Some((adj_si, adj_ei)) = adj else {
                segments_out.push(SegmentPitch {
                    start: seg.start,
                    end: seg.end,
                    text: seg.text.clone(),
                    label: None,
                    peak_pos: None,
                    pitch_range: None,
                    slope: None,
                });
                continue;
            };

            let slice = &f0_rel[adj_si..adj_ei];
            voiced = slice.iter().copied().flatten().collect();
        }

        let (peak_pos, pitch_range, slope) = segment_features(&voiced);
        let label = estimate_accent_label(peak_pos, pitch_range);

        segments_out.push(SegmentPitch {
            start: seg.start,
            end: seg.end,
            text: seg.text.clone(),
            label: Some(label),
            peak_pos: Some(peak_pos),
            pitch_range: Some(pitch_range),
            slope: Some(slope),
        });
    }

    let words_out = if t.words.is_empty() {
        None
    } else {
        let mut out = Vec::with_capacity(t.words.len());

        for w in &t.words {
            let si = time_to_index_floor(w.start, time_step);
            let ei = time_to_index_ceil(w.end, time_step);

            if si >= f0_rel.len() || ei <= si {
                out.push(WordPitch {
                    start: w.start,
                    end: w.end,
                    word: w.text.clone(),
                    text: w.text.clone(),
                    label: None,
                    peak_pos: None,
                    pitch_range: None,
                    slope: None,
                });
                continue;
            }

            let base_ei = ei.min(f0_rel.len());
            let base_slice = if si < base_ei { &f0_rel[si..base_ei] } else { &[] };
            let mut voiced: Vec<f32> = base_slice.iter().copied().flatten().collect();

            // If there are no voiced frames inside the original word span, expand and snap.
            if voiced.is_empty() {
                let adj = adjust_span_to_voiced(si, base_ei, f0_rel, 8);
                let Some((adj_si, adj_ei)) = adj else {
                    out.push(WordPitch {
                        start: w.start,
                        end: w.end,
                        word: w.text.clone(),
                        text: w.text.clone(),
                        label: None,
                        peak_pos: None,
                        pitch_range: None,
                        slope: None,
                    });
                    continue;
                };

                let slice = &f0_rel[adj_si..adj_ei];
                voiced = slice.iter().copied().flatten().collect();
            }

            let (peak_pos, pitch_range, slope) = segment_features(&voiced);
            let label = estimate_accent_label(peak_pos, pitch_range);

            out.push(WordPitch {
                start: w.start,
                end: w.end,
                word: w.text.clone(),
                text: w.text.clone(),
                label: Some(label),
                peak_pos: Some(peak_pos),
                pitch_range: Some(pitch_range),
                slope: Some(slope),
            });
        }

        Some(out)
    };

    Ok((Some(segments_out), words_out))
}
