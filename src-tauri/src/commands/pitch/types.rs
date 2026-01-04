use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct SegmentPitch {
    pub start: f32,
    pub end: f32,
    pub text: String,
    pub label: Option<String>,
    pub peak_pos: Option<f32>,
    pub pitch_range: Option<f32>,
    pub slope: Option<f32>,
}

#[derive(Serialize)]
pub struct WordPitch {
    pub start: f32,
    pub end: f32,
    // Backward/UX: some consumers want an explicit "word" key.
    // Keep both `word` and `text` (same value).
    pub word: String,
    pub text: String,
    pub label: Option<String>,
    pub peak_pos: Option<f32>,
    pub pitch_range: Option<f32>,
    pub slope: Option<f32>,
}

#[derive(Serialize)]
pub struct PitchAnalysis {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extractor: Option<String>,
    pub time_step: f32,
    pub sample_rate: u32,
    pub f0_hz: Vec<Option<f32>>,  // Hz
    pub f0_rel: Vec<Option<f32>>, // log2-normalized (mean=0,std=1) over voiced frames
    pub segments: Option<Vec<SegmentPitch>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<WordPitch>>,
}

#[derive(Deserialize)]
pub(crate) struct Transcript {
    pub segments: Vec<TranscriptSegment>,
    #[serde(default)]
    pub words: Vec<TranscriptWord>,
}

#[derive(Deserialize)]
pub(crate) struct TranscriptSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(Deserialize)]
pub(crate) struct TranscriptWord {
    pub start: f32,
    pub end: f32,
    pub text: String,
}
