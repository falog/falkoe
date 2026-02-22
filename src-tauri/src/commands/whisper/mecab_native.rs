//! Pure-Rust Japanese tokenizer using lindera (embedded ipadic).
//!
//! This replaces the external `mecab` CLI for environments where the binary is
//! not available (e.g. Android).  The output is translated to the same
//! `MecabToken` type used by the rest of the MeCab alignment pipeline.

use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use lindera::tokenizer::Tokenizer;
use once_cell::sync::Lazy;
use std::sync::Mutex;

use super::mecab::MecabToken;

/// Lazily initialized lindera tokenizer. The dictionary is embedded at compile
/// time via the `embed-ipadic` feature, so no external files are needed.
static TOKENIZER: Lazy<Mutex<Option<Tokenizer>>> = Lazy::new(|| {
    let tok = (|| -> Option<Tokenizer> {
        let dictionary = load_dictionary("embedded://ipadic").ok()?;
        let segmenter = Segmenter::new(Mode::Normal, dictionary, None);
        Some(Tokenizer::new(segmenter))
    })();
    Mutex::new(tok)
});

/// Tokenize `text` using the embedded ipadic dictionary.
/// Returns `None` if initialization failed or tokenization errors.
pub(crate) fn tokenize_native(text: &str) -> Option<Vec<MecabToken>> {
    let mut guard = TOKENIZER.lock().ok()?;
    let tokenizer = guard.as_mut()?;

    let mut tokens = tokenizer.tokenize(text).ok()?;

    let mut out = Vec::with_capacity(tokens.len());
    for token in tokens.iter_mut() {
        let surface = token.surface.as_ref().to_string();
        if surface.trim().is_empty() {
            continue;
        }

        // ipadic detail layout: [pos, subpos1, subpos2, subpos3, conj_type, conj_form, base, reading, pronunciation]
        // We need pos (index 0) for the same exclude logic as external MeCab.
        let details = token.details();
        let pos = details.first().copied().unwrap_or("").to_string();

        out.push(MecabToken { surface, pos });
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_basic_japanese() {
        let tokens = tokenize_native("明日からやる").expect("should tokenize");
        let surfaces: Vec<&str> = tokens.iter().map(|t| t.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["明日", "から", "やる"]);
    }

    #[test]
    fn tokenize_with_pos() {
        let tokens = tokenize_native("東京タワー").expect("should tokenize");
        assert!(!tokens.is_empty());
        // Both should be nouns (名詞)
        for t in &tokens {
            assert!(t.pos.starts_with("名詞"), "expected 名詞, got: {}", t.pos);
        }
    }
}
