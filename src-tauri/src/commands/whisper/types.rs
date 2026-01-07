#[derive(serde::Serialize, Clone)]
pub struct PreviewResult {
    pub status: String, // "preview"
    pub text: String,
    pub score: f32,
}

#[derive(serde::Serialize, Clone)]
pub struct FinalResult {
    pub status: String,
    pub wav_path: String,
    pub segments: Vec<Segment>,
    pub score: f32,
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
pub struct Segment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Transcript {
    pub segments: Vec<Segment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Vec<TokenTimestamp>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<WordTimestamp>>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TokenTimestamp {
    pub start: f32,
    pub end: f32,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dtw: Option<f32>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct WordTimestamp {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PartialSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}
