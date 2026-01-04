use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderChunk {
    pub words: Vec<String>,
    pub phonemes: Vec<String>,
    pub rendered: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderLinkingResult {
    pub legend: String,
    pub mode: String, // "phoneme" | "kana"
    pub chunks: Vec<RenderChunk>,
    pub joined: String,
}
