pub(crate) fn whisper_language(lang: &str) -> Option<&'static str> {
    match lang {
        // Accept both ISO 639-3 codes (Tatoeba) and ISO 639-1-ish codes (Whisper).
        "eng" | "en" => Some("en"),
        "jpn" | "ja" => Some("ja"),
        "spa" | "es" => Some("es"),
        "fra" | "fr" => Some("fr"),
        "deu" | "de" => Some("de"),
        "ita" | "it" => Some("it"),
        "por" | "pt" => Some("pt"),
        "rus" | "ru" => Some("ru"),
        "kor" | "ko" => Some("ko"),
        // Chinese: UI may use ISO 639-3-ish variants (Tatoeba) like cmn/yue.
        "zho" | "zh" | "cmn" | "yue" => Some("zh"),
        "ara" | "ar" => Some("ar"),
        "hin" | "hi" => Some("hi"),
        "tur" | "tr" => Some("tr"),
        "vie" | "vi" => Some("vi"),
        "tha" | "th" => Some("th"),
        "ind" | "id" => Some("id"),
        "ukr" | "uk" => Some("uk"),
        "pol" | "pl" => Some("pl"),
        "nld" | "nl" => Some("nl"),
        "swe" | "sv" => Some("sv"),
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
        assert_eq!(whisper_language("deu"), Some("de"));
        assert_eq!(whisper_language("es"), Some("es"));
        assert_eq!(whisper_language("zho"), Some("zh"));
        assert_eq!(whisper_language("cmn"), Some("zh"));
        assert_eq!(whisper_language("yue"), Some("zh"));
    }
}
