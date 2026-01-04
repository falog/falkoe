use std::path::{Path, PathBuf};

pub(crate) fn transcript_json_path(wav_path: &Path) -> PathBuf {
    wav_path.with_extension("json")
}
