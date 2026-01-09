use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn for_external_tool_path(p: &Path) -> PathBuf {
    // Some Windows CLI tools (notably MSYS2 builds) don't reliably accept verbatim paths (\\?\...).
    // Strip the prefix when present.
    #[cfg(target_os = "windows")]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}

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

fn env_mecab_path() -> Option<PathBuf> {
    std::env::var("FALKOE_MECAB_PATH")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn env_mecab_dicdir() -> Option<PathBuf> {
    std::env::var("FALKOE_MECAB_DICDIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn resolve_bundled_tool(app: &AppHandle, base_name: &str) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let exe_name = if cfg!(target_os = "windows") {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    };

    let candidates = [
        // bundle layout
        resource_dir.join("bin").join(&exe_name),
        resource_dir.join(&exe_name),
        // dev layout (resources synced under target/*/resources)
        resource_dir.join("resources").join("bin").join(&exe_name),
        resource_dir.join("resources").join(&exe_name),
    ];

    candidates.into_iter().find(|p| p.is_file())
}

fn resolve_bundled_dicdir(app: &AppHandle) -> Option<PathBuf> {
    // We treat a directory as a dictionary dir if it contains a dicrc file.
    // In production bundles, resource_dir typically points at the resources dir.
    // In dev, it can point at `target/debug` while resources are synced to `target/debug/resources`.
    let resource_dir = app.path().resource_dir().ok()?;

    let candidates = [
        // bundle layout
        resource_dir.join("mecab").join("ipadic"),
        resource_dir.join("mecab").join("ipadic-utf8"),
        resource_dir.join("mecab").join("dic").join("ipadic"),
        resource_dir.join("mecab").join("dic"),
        resource_dir.join("mecab"),
        // dev layout (resources synced under target/*/resources)
        resource_dir.join("resources").join("mecab").join("ipadic"),
        resource_dir
            .join("resources")
            .join("mecab")
            .join("ipadic-utf8"),
        resource_dir
            .join("resources")
            .join("mecab")
            .join("dic")
            .join("ipadic"),
        resource_dir.join("resources").join("mecab").join("dic"),
        resource_dir.join("resources").join("mecab"),
    ];

    for p in &candidates {
        if p.join("dicrc").is_file() {
            return Some(p.clone());
        }
    }

    // If not found, emit diagnostics to backend.log so users can see what paths were tried.
    let tried = candidates
        .iter()
        .map(|p| format!("{:?} (dicrc={})", p, p.join("dicrc").is_file()))
        .collect::<Vec<_>>()
        .join(", ");
    crate::logging::log_line(
        app,
        format!(
            "[mecab] bundled dicdir not found under resource_dir={:?}; tried: {}",
            resource_dir, tried
        ),
    );
    None
}

fn resolve_bundled_mecabrc(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let candidates = [
        // bundle layout
        resource_dir.join("mecab").join("mecabrc"),
        // dev layout (resources synced under target/*/resources)
        resource_dir.join("resources").join("mecab").join("mecabrc"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

#[derive(Debug, Clone)]
struct MecabRuntime {
    cmd: PathBuf,
    dicdir: Option<PathBuf>,
}

fn mecab_candidates() -> [&'static str; 3] {
    // Tauri packaged apps may not inherit a full PATH; try common locations.
    ["mecab", "/usr/bin/mecab", "/usr/local/bin/mecab"]
}

fn mecab_runtime_candidates(app: Option<&AppHandle>) -> Vec<MecabRuntime> {
    let env_dicdir = env_mecab_dicdir();
    let bundled_dicdir = app.and_then(resolve_bundled_dicdir);
    let dicdir = env_dicdir.clone().or_else(|| bundled_dicdir.clone());

    let mut out: Vec<MecabRuntime> = Vec::new();

    // 1) Explicit override path (highest priority)
    if let Some(p) = env_mecab_path() {
        out.push(MecabRuntime {
            cmd: p,
            dicdir: dicdir.clone(),
        });
    }

    // 2) Bundled binary under resource_dir (preferred for distribution builds)
    // BUT: skip bundled mecab.exe if we have no bundled dictionary.
    // This avoids Windows distributions that bundle mecab.exe but not ipadic,
    // which would fail trying to load a non-existent dicdir.
    if let Some(app) = app {
        if let Some(p) = resolve_bundled_tool(app, "mecab") {
            if bundled_dicdir.is_some() || env_dicdir.is_some() {
                out.push(MecabRuntime {
                    cmd: p,
                    dicdir: dicdir.clone(),
                });
            }
        }
    }

    // 3) System candidates
    for cmd in mecab_candidates() {
        out.push(MecabRuntime {
            cmd: PathBuf::from(cmd),
            dicdir: dicdir.clone(),
        });
    }

    out
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

fn log_mecab_failure(app: Option<&AppHandle>, msg: impl AsRef<str>) {
    let msg = msg.as_ref();
    if let Some(app) = app {
        crate::logging::log_line(app, msg);
    }
    if debug_enabled() {
        eprintln!("{msg}");
    }
}

fn log_mecab_failure_detail(app: Option<&AppHandle>, msg: impl AsRef<str>) {
    if debug_enabled() {
        log_mecab_failure(app, msg);
    }
}

fn run_mecab(text: &str, rt: &MecabRuntime, app: Option<&AppHandle>) -> Option<Vec<MecabToken>> {
    // First, try POS mode (more accurate exclude decisions).
    if let Some(tokens) = run_mecab_with_pos(text, rt, app) {
        return Some(tokens);
    }

    // Fallback: wakati surfaces only.
    let mut cmd = Command::new(&rt.cmd);

    // Avoid spawning a black console window on Windows.
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.arg("-O").arg("wakati");
    if let Some(dicdir) = &rt.dicdir {
        // Only override mecabrc when we also control the dictionary dir.
        // Otherwise we can break system installations by pointing dicdir to a non-existent bundled path.
        if let Some(app) = app {
            if let Some(rc) = resolve_bundled_mecabrc(app) {
                let rc = for_external_tool_path(&rc);
                // Some MeCab builds still consult MECABRC internally even if -r is passed.
                // Set both for maximum compatibility.
                cmd.env("MECABRC", &rc);
                cmd.arg("-r").arg(rc);
            }
        }
        cmd.arg("-d").arg(for_external_tool_path(dicdir));
    }
    let mut child = match cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let hint = if cfg!(target_os = "windows") && e.raw_os_error() == Some(126) {
                " (Windows error 126: missing DLL dependency; commonly libiconv-2.dll / libintl-8.dll)"
            } else {
                ""
            };
            log_mecab_failure(app, format!("[mecab] spawn failed: {e}{hint}"));
            log_mecab_failure_detail(
                app,
                format!("[mecab][debug] spawn failed cmd={:?} dicdir={:?}: {e}{hint}", rt.cmd, rt.dicdir),
            );
            return None;
        }
    };

    {
        let mut stdin = child.stdin.take()?;
        let _ = stdin.write_all(text.as_bytes());
        let _ = stdin.write_all(b"\n");
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            log_mecab_failure(app, "[mecab] non-zero exit");
            log_mecab_failure_detail(
                app,
                format!(
                    "[mecab][debug] non-zero exit cmd={:?}: status={:?} stderr={}",
                    rt.cmd,
                    output.status.code(),
                    crate::logging::truncate_for_log(stderr.trim(), 2000)
                ),
            );
        } else {
            log_mecab_failure(app, "[mecab] non-zero exit");
            log_mecab_failure_detail(
                app,
                format!(
                    "[mecab][debug] non-zero exit cmd={:?}: status={:?}",
                    rt.cmd,
                    output.status.code()
                ),
            );
        }
        return None;
    }
    let out = String::from_utf8(output.stdout).ok()?;

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

fn run_mecab_with_pos(text: &str, rt: &MecabRuntime, app: Option<&AppHandle>) -> Option<Vec<MecabToken>> {
    let mut cmd = Command::new(&rt.cmd);

    // Avoid spawning a black console window on Windows.
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Some(dicdir) = &rt.dicdir {
        // Only override mecabrc when we also control the dictionary dir.
        if let Some(app) = app {
            if let Some(rc) = resolve_bundled_mecabrc(app) {
                let rc = for_external_tool_path(&rc);
                cmd.env("MECABRC", &rc);
                cmd.arg("-r").arg(rc);
            }
        }
        cmd.arg("-d").arg(for_external_tool_path(dicdir));
    }
    let mut child = match cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let hint = if cfg!(target_os = "windows") && e.raw_os_error() == Some(126) {
                " (Windows error 126: missing DLL dependency; commonly libiconv-2.dll / libintl-8.dll)"
            } else {
                ""
            };
            log_mecab_failure(app, format!("[mecab] spawn failed: {e}{hint}"));
            log_mecab_failure_detail(
                app,
                format!("[mecab][debug] spawn failed cmd={:?} dicdir={:?}: {e}{hint}", rt.cmd, rt.dicdir),
            );
            return None;
        }
    };

    {
        let mut stdin = child.stdin.take()?;
        let _ = stdin.write_all(text.as_bytes());
        let _ = stdin.write_all(b"\n");
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            log_mecab_failure(app, "[mecab] non-zero exit");
            log_mecab_failure_detail(
                app,
                format!(
                    "[mecab][debug] non-zero exit cmd={:?}: status={:?} stderr={}",
                    rt.cmd,
                    output.status.code(),
                    crate::logging::truncate_for_log(stderr.trim(), 2000)
                ),
            );
        } else {
            log_mecab_failure(app, "[mecab] non-zero exit");
            log_mecab_failure_detail(
                app,
                format!(
                    "[mecab][debug] non-zero exit cmd={:?}: status={:?}",
                    rt.cmd,
                    output.status.code()
                ),
            );
        }
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

fn mecab_timed_tokens_inner(
    app: Option<&AppHandle>,
    text: &str,
    whisper_words: &[WordLike],
) -> Option<Vec<TimedToken>> {
    if debug_enabled() {
        if let Some(app) = app {
            let bundled_cmd = resolve_bundled_tool(app, "mecab");
            let bundled_dic = resolve_bundled_dicdir(app);
            let bundled_rc = resolve_bundled_mecabrc(app);
            let env_cmd = env_mecab_path();
            let env_dic = env_mecab_dicdir();
            crate::logging::log_line(
                app,
                format!(
                    "[mecab][debug] probe env_cmd={:?} env_dicdir={:?} bundled_cmd={:?} bundled_dicdir={:?} bundled_mecabrc={:?}",
                    env_cmd, env_dic, bundled_cmd, bundled_dic, bundled_rc
                ),
            );
        }
    }

    if debug_enabled() {
        println!("[mecab] mecab_timed_tokens called");
        println!("[mecab] text={:?}", text);
        println!("[mecab] whisper_words.len={}", whisper_words.len());
    }
    // Requires whisper word timestamps to assign times to MeCab tokens.
    if whisper_words.is_empty() {
        if let Some(app) = app {
            crate::logging::log_line(app, "[mecab] skip: no whisper word timestamps");
        }
        return None;
    }

    // 1) MeCab tokenize (try candidates in order)
    let mut mecab_raw: Option<Vec<MecabToken>> = None;
    for rt in mecab_runtime_candidates(app) {
        if debug_enabled() {
            println!("[mecab] trying cmd={:?} dicdir={:?}", rt.cmd, rt.dicdir);
        }
        if let Some(v) = run_mecab(text, &rt, app) {
            mecab_raw = Some(v);
            break;
        }
    }
    let mecab_raw = match mecab_raw {
        Some(v) => v,
        None => {
            if debug_enabled() {
                println!("[mecab] unavailable or failed");
            }
            log_mecab_failure(app, "[mecab] unavailable or failed (all candidates)");
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

        log_mecab_failure(
            app,
            format!(
                "[mecab] alignment mismatch mecab={} whisper={} mecab_n={} whisper_n={}",
                crate::logging::truncate_for_log(&mecab_concat, 200),
                crate::logging::truncate_for_log(&whisper_concat, 200),
                crate::logging::truncate_for_log(&normalize_for_alignment(&mecab_concat), 200),
                crate::logging::truncate_for_log(&normalize_for_alignment(&whisper_concat), 200)
            ),
        );
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

pub fn mecab_timed_tokens(text: &str, whisper_words: &[WordLike]) -> Option<Vec<TimedToken>> {
    mecab_timed_tokens_inner(None, text, whisper_words)
}

pub fn mecab_timed_tokens_with_app(
    app: &AppHandle,
    text: &str,
    whisper_words: &[WordLike],
) -> Option<Vec<TimedToken>> {
    mecab_timed_tokens_inner(Some(app), text, whisper_words)
}
