use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn sanitize_base_name(s: &str) -> String {
    let mut out = String::new();
    for ch in s.trim().chars() {
        if ch.is_control() {
            continue;
        }
        // Keep filenames portable across platforms.
        // Windows forbids: \\ / : * ? " < > |
        // For video exports, we preserve readability by converting those into their
        // fullwidth equivalents instead of replacing with '_'.
        let mapped = match ch {
            '\\' => '＼',
            '/' => '／',
            ':' => '：',
            '*' => '＊',
            '?' => '？',
            '"' => '＂',
            '<' => '＜',
            '>' => '＞',
            '|' => '｜',
            // ASCII apostrophe is technically allowed, but it commonly causes quoting/escaping
            // issues in downstream tools. Use a typographic apostrophe instead.
            '\'' => '’',
            _ => ch,
        };
        out.push(mapped);
    }
    let out = out.trim().trim_end_matches(['.', ' ']).to_string();
    let out = if out.is_empty() { "falkoe".to_string() } else { out };
    // Keep it short-ish for cross-platform compatibility.
    out.chars().take(80).collect::<String>().trim().to_string()
}

pub(crate) fn pick_unique_mp4_path(dir: &Path, base: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{base}.mp4"));
    if !candidate.exists() {
        return candidate;
    }
    for i in 2..1000 {
        candidate = dir.join(format!("{base} ({i}).mp4"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!(
        "{base}-{}.mp4",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_base_name_basic() {
        assert_eq!(sanitize_base_name("  hello world  "), "hello world");
        assert_eq!(sanitize_base_name("a/b:c"), "a／b：c");
        assert_eq!(sanitize_base_name(""), "falkoe");
        assert_eq!(sanitize_base_name("....   "), "falkoe");
    }

    #[test]
    fn sanitize_base_name_rewrites_apostrophe() {
        assert_eq!(sanitize_base_name("it's fine"), "it’s fine");
        assert_eq!(sanitize_base_name("rock'n'roll"), "rock’n’roll");
    }

    #[test]
    fn sanitize_base_name_fullwidth_forbidden_chars() {
        assert_eq!(sanitize_base_name("a\\b"), "a＼b");
        assert_eq!(sanitize_base_name("a/b"), "a／b");
        assert_eq!(sanitize_base_name("a:b"), "a：b");
        assert_eq!(sanitize_base_name("a*b"), "a＊b");
        assert_eq!(sanitize_base_name("a?b"), "a？b");
        assert_eq!(sanitize_base_name("a\"b"), "a＂b");
        assert_eq!(sanitize_base_name("a<b"), "a＜b");
        assert_eq!(sanitize_base_name("a>b"), "a＞b");
        assert_eq!(sanitize_base_name("a|b"), "a｜b");
    }

    #[test]
    fn sanitize_base_name_trims_trailing_dot_space() {
        assert_eq!(sanitize_base_name("name. "), "name");
    }
}
