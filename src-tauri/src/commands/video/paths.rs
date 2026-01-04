use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn sanitize_base_name(s: &str) -> String {
    let mut out = String::new();
    for ch in s.trim().chars() {
        if ch.is_control() {
            continue;
        }
        let repl = matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\'');
        out.push(if repl { '_' } else { ch });
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
        assert_eq!(sanitize_base_name("a/b:c"), "a_b_c");
        assert_eq!(sanitize_base_name(""), "falkoe");
        assert_eq!(sanitize_base_name("....   "), "falkoe");
    }

    #[test]
    fn sanitize_base_name_trims_trailing_dot_space() {
        assert_eq!(sanitize_base_name("name. "), "name");
    }
}
