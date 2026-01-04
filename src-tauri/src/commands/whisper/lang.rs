pub(crate) fn whisper_language(lang: &str) -> Option<&'static str> {
    match lang {
        "eng" => Some("en"),
        "jpn" => Some("ja"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whisper_language_maps_known_langs() {
        assert_eq!(whisper_language("eng"), Some("en"));
        assert_eq!(whisper_language("jpn"), Some("ja"));
        assert_eq!(whisper_language("deu"), None);
    }
}
