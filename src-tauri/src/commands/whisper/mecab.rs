use std::io::Write;
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
pub struct WordLike {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct TimedToken {
    pub text: String,
    pub start: f32,
    pub end: f32,
    pub is_excluded: bool,
}

#[derive(Debug, Clone)]
struct MecabToken {
    surface: String,
    pos: String,
}

fn char_len(s: &str) -> usize {
    s.chars().count().max(1)
}

fn debug_enabled() -> bool {
    std::env::var("FALKOE_DEBUG_MECAB")
        .ok()
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

fn mecab_candidates() -> [&'static str; 3] {
    // Tauri packaged apps may not inherit a full PATH; try common locations.
    ["mecab", "/usr/bin/mecab", "/usr/local/bin/mecab"]
}

fn is_punct_char(c: char) -> bool {
    c.is_ascii_punctuation()
        || matches!(
            c,
            '。' | '、' | '！' | '？' | '…' | '・' | '「' | '」' | '『' | '』' | '（' | '）' | '【'
                | '】' | '［' | '］' | '〔' | '〕' | '〈' | '〉' | '《' | '》' | '“' | '”' | '‘'
                | '’' | '：' | '；'
        )
}

fn is_punct_word(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    t.chars().all(is_punct_char)
}

fn should_exclude_by_pos(pos: &str) -> bool {
    // Minimal, stable rule: exclude function tokens.
    // (MeCab dictionaries vary; relying on POS prefix is more robust than exact surfaces.)
    pos.starts_with("助詞") || pos.starts_with("助動詞") || pos.starts_with("記号")
}

fn should_exclude_by_surface(surface: &str) -> bool {
    // Fallback for environments where POS output isn't available.
    // Keep this aligned with the label-exclusion sets used elsewhere.
    matches!(
        surface.trim(),
        "は"
            | "が"
            | "を"
            | "に"
            | "で"
            | "と"
            | "も"
            | "へ"
            | "から"
            | "まで"
            | "より"
            | "の"
            | "や"
            | "よ"
            | "ね"
            | "な"
            | "さ"
            | "ぞ"
            | "わ"
            | "か"
            | "だ"
            | "です"
            | "でした"
            | "でしたら"
    )
}

fn run_mecab(text: &str) -> Option<Vec<MecabToken>> {
    let mut child = None;
    for cmd in mecab_candidates() {
        match Command::new(cmd)
            .arg("-O")
            .arg("wakati")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => {
                child = Some(c);
                break;
            }
            Err(e) => {
                if debug_enabled() {
                    println!("[mecab] spawn failed for {cmd}: {e}");
                }
            }
        }
    }
    let mut child = child?;

    {
        let mut stdin = child.stdin.take()?;
        let _ = stdin.write_all(text.as_bytes());
        let _ = stdin.write_all(b"\n");
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let out = String::from_utf8(output.stdout).ok()?;

    // wakati output loses POS. Try a second pass with default output for POS.
    // If that fails, fall back to wakati surfaces only.
    if let Some(tokens) = run_mecab_with_pos(text) {
        return Some(tokens);
    }

    let mut toks = Vec::new();
    for s in out.split_whitespace() {
        let t = s.trim();
        if t.is_empty() {
            continue;
        }
        toks.push(MecabToken {
            surface: t.to_string(),
            pos: "".to_string(),
        });
    }
    Some(toks)
}

fn run_mecab_with_pos(text: &str) -> Option<Vec<MecabToken>> {
    let mut child = None;
    for cmd in mecab_candidates() {
        match Command::new(cmd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => {
                child = Some(c);
                break;
            }
            Err(e) => {
                if debug_enabled() {
                    println!("[mecab] spawn failed for {cmd}: {e}");
                }
            }
        }
    }
    let mut child = child?;

    {
        let mut stdin = child.stdin.take()?;
        let _ = stdin.write_all(text.as_bytes());
        let _ = stdin.write_all(b"\n");
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }

    let out = String::from_utf8(output.stdout).ok()?;
    let mut toks = Vec::new();
    for line in out.lines() {
        let line = line.trim_end();
        if line == "EOS" || line.is_empty() {
            continue;
        }
        let mut it = line.split('\t');
        let surface = it.next()?.trim();
        let feat = it.next().unwrap_or("");
        let pos = feat.split(',').next().unwrap_or("").to_string();
        toks.push(MecabToken {
            surface: surface.to_string(),
            pos,
        });
    }
    Some(toks)
}

fn merge_polite_masu(mut toks: Vec<MecabToken>) -> Vec<MecabToken> {
    // UX rule: keep verbs like "行きます" as one token (do not split "ます").
    // Many dictionaries split: 行き(動詞) + ます(助動詞)
    let mut out: Vec<MecabToken> = Vec::new();
    for t in toks.drain(..) {
        if t.surface == "ます" {
            if let Some(prev) = out.last_mut() {
                if prev.pos.starts_with("動詞") {
                    prev.surface.push_str("ます");
                    continue;
                }
            }
        }
        out.push(t);
    }
    out
}

fn strip_spaces(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn normalize_for_alignment(s: &str) -> String {
    // Normalize across pipelines (Whisper vs MeCab) by removing whitespace and punctuation.
    s.chars()
        .filter(|c| !c.is_whitespace() && !is_punct_char(*c))
        .collect()
}

pub fn mecab_timed_tokens(text: &str, whisper_words: &[WordLike]) -> Option<Vec<TimedToken>> {
    if debug_enabled() {
        println!("[mecab] mecab_timed_tokens called");
        println!("[mecab] text={:?}", text);
        println!("[mecab] whisper_words.len={}", whisper_words.len());
    }
    // Requires whisper word timestamps to assign times to MeCab tokens.
    if whisper_words.is_empty() {
        return None;
    }

    // 1) MeCab tokenize (if mecab missing, returns None)
    let mecab_raw = match run_mecab(text) {
        Some(v) => v,
        None => {
            if debug_enabled() {
                println!("[mecab] unavailable or failed");
            }
            return None;
        }
    };
    let mecab_raw = merge_polite_masu(mecab_raw);

    // 2) Build concat strings (no spaces) and validate they match
    let mecab_concat = mecab_raw
        .iter()
        .map(|t| t.surface.as_str())
        .collect::<Vec<_>>()
        .join("");

    let whisper_concat = whisper_words
        .iter()
        .map(|w| strip_spaces(&w.text))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("");

    // Be tolerant to punctuation differences (e.g. Whisper may omit "。" while MeCab emits it).
    if normalize_for_alignment(&mecab_concat) != normalize_for_alignment(&whisper_concat) {
        // Mismatch (normalization/dictionary differences). Fall back to existing logic.
        if debug_enabled() {
            println!("[mecab] alignment mismatch");
            println!("  mecab   = {:?}", mecab_concat);
            println!("  whisper = {:?}", whisper_concat);
            println!("  mecab_n   = {:?}", normalize_for_alignment(&mecab_concat));
            println!("  whisper_n = {:?}", normalize_for_alignment(&whisper_concat));
        }
        return None;
    }

    if debug_enabled() {
        println!("[mecab] alignment ok");
        println!("[mecab] mecab_concat={:?}", mecab_concat);
        println!("[mecab] whisper_concat={:?}", whisper_concat);
    }

    // 3) Build whisper char spans
    #[derive(Clone)]
    struct Span {
        si: usize,
        ei: usize,
        start: f32,
        end: f32,
    }

    let mut spans: Vec<Span> = Vec::new();
    let mut offset = 0usize;
    for w in whisper_words {
        let s = strip_spaces(&w.text);
        if s.is_empty() {
            continue;
        }
        let len = s.chars().count();
        if len == 0 {
            continue;
        }
        let si = offset;
        let ei = offset + len;
        spans.push(Span {
            si,
            ei,
            start: w.start,
            end: w.end,
        });
        offset = ei;
    }
    if spans.is_empty() {
        return None;
    }

    fn time_at(spans: &[Span], idx: usize) -> f32 {
        // idx is in [0, total_chars]
        for sp in spans {
            if idx <= sp.si {
                return sp.start;
            }
            if idx >= sp.ei {
                continue;
            }
            let len = (sp.ei - sp.si).max(1) as f32;
            let rel = (idx - sp.si) as f32 / len;
            return sp.start + rel * (sp.end - sp.start);
        }
        spans.last().map(|s| s.end).unwrap_or(0.0)
    }

    // 4) Convert MeCab tokens into timed tokens
    let mut out: Vec<TimedToken> = Vec::new();
    let mut cur = 0usize;
    for t in mecab_raw {
        let surface = t.surface.trim();
        if surface.is_empty() {
            continue;
        }
        let len = char_len(surface);
        let si = cur;
        let ei = cur + len;
        cur = ei;

        let start = time_at(&spans, si);
        let end = time_at(&spans, ei);
        let is_excluded = is_punct_word(surface)
            || (!t.pos.is_empty() && should_exclude_by_pos(&t.pos))
            || should_exclude_by_surface(surface);
        out.push(TimedToken {
            text: surface.to_string(),
            start,
            end,
            is_excluded,
        });
    }

    Some(out)
}
