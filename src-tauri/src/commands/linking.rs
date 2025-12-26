use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

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

#[derive(Clone, Copy, Debug)]
enum DisplayMode {
    Phoneme,
    Kana,
}

fn display_mode_from_str(s: Option<String>) -> Result<DisplayMode, String> {
    match s.as_deref() {
        None | Some("") | Some("phoneme") => Ok(DisplayMode::Phoneme),
        Some("kana") => Ok(DisplayMode::Kana),
        Some(other) => Err(format!("invalid displayMode: {other}")),
    }
}

fn tokenize(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();

    for ch in text.chars() {
        if ch.is_ascii_alphabetic() || ch == '\'' {
            buf.push(ch.to_ascii_lowercase());
        } else if !buf.is_empty() {
            out.push(std::mem::take(&mut buf));
        }
    }

    if !buf.is_empty() {
        out.push(buf);
    }

    out
}

// =============================
// CMUdict (download + cache)
// =============================

const CMUDICT_URLS: [&str; 2] = [
    "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict",
    "https://raw.githubusercontent.com/Alexir/CMUdict/master/cmudict-0.7b",
];

#[derive(Clone, Debug)]
pub(crate) struct CmuDict {
    map: HashMap<String, Vec<String>>,
}

static CMUDICT_CACHE: OnceLock<Mutex<Option<Arc<CmuDict>>>> = OnceLock::new();

fn cmudict_cache() -> &'static Mutex<Option<Arc<CmuDict>>> {
    CMUDICT_CACHE.get_or_init(|| Mutex::new(None))
}

fn cmudict_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cmudict"))
}

fn cmudict_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cmudict_dir(app)?.join("cmudict.dict"))
}

fn parse_cmudict(text: &str) -> CmuDict {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with(";;;") {
            continue;
        }

        let mut it = line.split_whitespace();
        let Some(raw_key) = it.next() else {
            continue;
        };

        // e.g. WORD(1) -> WORD
        let key = if raw_key.ends_with(')') {
            match raw_key.find('(') {
                Some(idx) => &raw_key[..idx],
                None => raw_key,
            }
        } else {
            raw_key
        }
        .to_ascii_lowercase();

        if key.is_empty() {
            continue;
        }

        // already have a primary entry
        if map.contains_key(&key) {
            continue;
        }

        let phonemes: Vec<String> = it.map(|s| s.to_string()).collect();
        if phonemes.is_empty() {
            continue;
        }

        map.insert(key, phonemes);
    }

    CmuDict { map }
}

fn download_cmudict() -> Result<String, String> {
    let mut last_error: Option<String> = None;

    for url in CMUDICT_URLS {
        match reqwest::blocking::get(url) {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_error = Some(format!("HTTP {} from {url}", resp.status()));
                    continue;
                }

                match resp.text() {
                    Ok(t) => return Ok(t),
                    Err(e) => {
                        last_error = Some(format!("read body failed from {url}: {e}"));
                        continue;
                    }
                }
            }
            Err(e) => {
                last_error = Some(format!("request failed to {url}: {e}"));
                continue;
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "failed to download cmudict".to_string()))
}

fn load_cmudict_from_disk(path: &Path) -> Result<Option<CmuDict>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(Some(parse_cmudict(&text)))
}

pub(crate) fn ensure_cmudict_loaded(app: &AppHandle) -> Result<Arc<CmuDict>, String> {
    // Fast path: already loaded
    if let Some(existing) = cmudict_cache().lock().unwrap().clone() {
        return Ok(existing);
    }

    let path = cmudict_path(app)?;

    // Try disk
    if let Some(dict) = load_cmudict_from_disk(&path)? {
        let arc = Arc::new(dict);
        *cmudict_cache().lock().unwrap() = Some(arc.clone());
        return Ok(arc);
    }

    // Download then save
    let text = download_cmudict()?;
    let dir = cmudict_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    {
        let mut f = fs::File::create(&path).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
    }

    let dict = parse_cmudict(&text);
    let arc = Arc::new(dict);
    *cmudict_cache().lock().unwrap() = Some(arc.clone());
    Ok(arc)
}

/// 起動時などに呼んで、初回のrender_linkingを軽くする。
pub(crate) fn warmup_cmudict(app: &AppHandle) -> Result<(), String> {
    let _ = ensure_cmudict_loaded(app)?;
    Ok(())
}

fn is_vowel_phoneme(p: &str) -> bool {
    p.chars().last().is_some_and(|c| c.is_ascii_digit())
}

fn stress_mark(stress: u8) -> &'static str {
    match stress {
        1 => "▲",
        2 => "△",
        _ => "▽",
    }
}

fn is_weak_vowel(p: &str) -> bool {
    matches!(p, "AH0" | "ER0" | "IH0" | "UH0" | "EH0" | "AO0")
}

fn phoneme_to_display(p: &str, stress: u8, mode: DisplayMode) -> String {
    let base = p.strip_suffix(['0', '1', '2']).unwrap_or(p);

    // 弱母音は曖昧音として残す
    if is_weak_vowel(p) && stress == 0 {
        return match mode {
            DisplayMode::Phoneme => "ə".to_string(),
            // Kanaで空にするとシラブルが欠けるので、最小でも母音を出す
            DisplayMode::Kana => "ア".to_string(),
        };
    }

    match mode {
        DisplayMode::Phoneme => base.to_ascii_lowercase(),
        DisplayMode::Kana => {
            // 最小実装: Python/TS版のカタカナ表と同じ
            let v = match base {
                "AA" => "アー",
                "AE" => "ア",
                "AH" => "ア",
                "AO" => "オー",
                "AW" => "アウ",
                "AY" => "アイ",
                "EH" => "エ",
                "ER" => "アー",
                "EY" => "エイ",
                "IH" => "イ",
                "IY" => "イー",
                "OW" => "オウ",
                "OY" => "オイ",
                "UH" => "ウ",
                "UW" => "ウー",
                _ => "",
            };

            if !v.is_empty() {
                return v.to_string();
            }

            let c = match base {
                "B" => "ブ",
                "CH" => "チ",
                "D" => "ド",
                "DH" => "ザ",
                "F" => "フ",
                "G" => "グ",
                "HH" => "ハ",
                "JH" => "ジ",
                "K" => "ク",
                "L" => "ル",
                "M" => "ム",
                "N" => "ン",
                "NG" => "ング",
                "P" => "プ",
                "R" => "ル",
                "S" => "ス",
                "SH" => "シ",
                "T" => "ト",
                "TH" => "ス",
                "V" => "ヴ",
                "W" => "ウ",
                "Y" => "イ",
                "Z" => "ズ",
                _ => "",
            };

            c.to_string()
        }
    }
}

#[derive(Clone, Debug)]
struct Syllable {
    phonemes: Vec<String>,
    stress: u8,
}

fn syllabify(phonemes: &[String]) -> Vec<Syllable> {
    // Python版の単純分割だと「母音の前の子音」が前シラブルに行って落ちるので、
    // ここでは「次に来る母音のオンセット」として保持する。
    let mut syllables: Vec<Syllable> = Vec::new();
    let mut onset: Vec<String> = Vec::new();

    for p in phonemes {
        if is_vowel_phoneme(p) {
            let stress = p
                .chars()
                .last()
                .and_then(|c| c.to_digit(10))
                .unwrap_or(0) as u8;

            let mut phs = std::mem::take(&mut onset);
            phs.push(p.clone());

            syllables.push(Syllable { phonemes: phs, stress });
        } else {
            onset.push(p.clone());
        }
    }

    // trailing consonants → last syllable coda
    if !onset.is_empty() {
        if let Some(last) = syllables.last_mut() {
            last.phonemes.extend(onset);
        } else {
            syllables.push(Syllable {
                phonemes: onset,
                stress: 0,
            });
        }
    }

    syllables
}

fn kana_vowel(base: &str) -> (&'static str, bool) {
    // returns (kana, is_long)
    match base {
        "AA" | "AE" | "AH" => ("ア", false),
        "AO" => ("オ", false),
        "EH" => ("エ", false),
        "IH" => ("イ", false),
        "UH" => ("ウ", false),
        "ER" => ("ア", true),
        "IY" => ("イ", true),
        "UW" => ("ウ", true),
        // /oʊ/ はカタカナだと「オー」寄りが自然
        "OW" => ("オ", true),
        // /eɪ/ は「エイ」
        "EY" => ("エイ", false),
        "AY" => ("アイ", false),
        "AW" => ("アウ", false),
        "OY" => ("オイ", false),
        _ => ("", false),
    }
}

fn kana_weak_vowel(base: &str) -> (&'static str, bool) {
    // stress=0 のときの曖昧母音を小書き寄りにする
    match base {
        "AA" | "AE" | "AH" => ("ァ", false),
        "AO" => ("ォ", false),
        "EH" => ("ェ", false),
        "IH" => ("ィ", false),
        "UH" => ("ゥ", false),
        "ER" => ("ァ", true),
        "IY" => ("ィ", true),
        "UW" => ("ゥ", true),
        // 弱形では長母音扱いにしない（ただしOWは雰囲気維持で少し伸ばしても良い）
        "OW" => ("ォ", false),
        "EY" => ("ェ", false),
        _ => ("", false),
    }
}

fn split_vowel_kana(vowel: &str) -> (&str, &str) {
    // 二重母音などをCV表に当てるため、先頭の基底母音と残りに分ける
    if vowel.starts_with('ァ') {
        return ("ア", &vowel["ァ".len()..]);
    }
    if vowel.starts_with('ィ') {
        return ("イ", &vowel["ィ".len()..]);
    }
    if vowel.starts_with('ゥ') {
        return ("ウ", &vowel["ゥ".len()..]);
    }
    if vowel.starts_with('ェ') {
        return ("エ", &vowel["ェ".len()..]);
    }
    if vowel.starts_with('ォ') {
        return ("オ", &vowel["ォ".len()..]);
    }

    if vowel.starts_with('ア') {
        return ("ア", &vowel["ア".len()..]);
    }
    if vowel.starts_with('イ') {
        return ("イ", &vowel["イ".len()..]);
    }
    if vowel.starts_with('ウ') {
        return ("ウ", &vowel["ウ".len()..]);
    }
    if vowel.starts_with('エ') {
        return ("エ", &vowel["エ".len()..]);
    }
    if vowel.starts_with('オ') {
        return ("オ", &vowel["オ".len()..]);
    }

    (vowel, "")
}

fn kana_cv(cons: &str, vowel: &str, long: bool) -> String {
    // Very lightweight CV mapping for readability.
    let (v0, v_rest) = split_vowel_kana(vowel);

    let base = match cons {
        "" => vowel.to_string(),

        "K" => match v0 {
            "ア" => "カ",
            "イ" => "キ",
            "ウ" => "ク",
            "エ" => "ケ",
            "オ" => "コ",
            _ => "ク",
        }
        .to_string(),
        "G" => match v0 {
            "ア" => "ガ",
            "イ" => "ギ",
            "ウ" => "グ",
            "エ" => "ゲ",
            "オ" => "ゴ",
            _ => "グ",
        }
        .to_string(),
        "S" => match v0 {
            "ア" => "サ",
            "イ" => "シ",
            "ウ" => "ス",
            "エ" => "セ",
            "オ" => "ソ",
            _ => "ス",
        }
        .to_string(),
        "Z" => match v0 {
            "ア" => "ザ",
            "イ" => "ジ",
            "ウ" => "ズ",
            "エ" => "ゼ",
            "オ" => "ゾ",
            _ => "ズ",
        }
        .to_string(),
        "T" => match v0 {
            "ア" => "タ",
            "イ" => "チ",
            "ウ" => "ツ",
            "エ" => "テ",
            "オ" => "ト",
            _ => "ツ",
        }
        .to_string(),
        "D" => match v0 {
            "ア" => "ダ",
            "イ" => "ヂ",
            "ウ" => "ヅ",
            "エ" => "デ",
            "オ" => "ド",
            _ => "ド",
        }
        .to_string(),
        "N" => match v0 {
            "ア" => "ナ",
            "イ" => "ニ",
            "ウ" => "ヌ",
            "エ" => "ネ",
            "オ" => "ノ",
            _ => "ン",
        }
        .to_string(),
        "H" | "HH" => match v0 {
            "ア" => "ハ",
            "イ" => "ヒ",
            "ウ" => "フ",
            "エ" => "ヘ",
            "オ" => "ホ",
            _ => "ハ",
        }
        .to_string(),
        "B" => match v0 {
            "ア" => "バ",
            "イ" => "ビ",
            "ウ" => "ブ",
            "エ" => "ベ",
            "オ" => "ボ",
            _ => "ブ",
        }
        .to_string(),
        "P" => match v0 {
            "ア" => "パ",
            "イ" => "ピ",
            "ウ" => "プ",
            "エ" => "ペ",
            "オ" => "ポ",
            _ => "プ",
        }
        .to_string(),
        "M" => match v0 {
            "ア" => "マ",
            "イ" => "ミ",
            "ウ" => "ム",
            "エ" => "メ",
            "オ" => "モ",
            _ => "ム",
        }
        .to_string(),
        "R" | "L" => match v0 {
            "ア" => "ラ",
            "イ" => "リ",
            "ウ" => "ル",
            "エ" => "レ",
            "オ" => "ロ",
            _ => "ル",
        }
        .to_string(),

        // special consonants
        "Y" => match v0 {
            "ア" => "ヤ",
            "イ" => "イ",
            "ウ" => "ユ",
            "エ" => "イェ",
            "オ" => "ヨ",
            _ => "ユ",
        }
        .to_string(),
        "W" => match v0 {
            "ア" => "ワ",
            "イ" => "ウィ",
            "ウ" => "ウ",
            "エ" => "ウェ",
            "オ" => "ウォ",
            _ => "ウ",
        }
        .to_string(),
        "F" => match v0 {
            "ア" => "ファ",
            "イ" => "フィ",
            "ウ" => "フ",
            "エ" => "フェ",
            "オ" => "フォ",
            _ => "フ",
        }
        .to_string(),
        "V" => match v0 {
            "ア" => "ヴァ",
            "イ" => "ヴィ",
            "ウ" => "ヴ",
            "エ" => "ヴェ",
            "オ" => "ヴォ",
            _ => "ヴ",
        }
        .to_string(),
        "SH" => match v0 {
            "ア" => "シャ",
            "イ" => "シ",
            "ウ" => "シュ",
            "エ" => "シェ",
            "オ" => "ショ",
            _ => "シュ",
        }
        .to_string(),
        "CH" => match v0 {
            "ア" => "チャ",
            "イ" => "チ",
            "ウ" => "チュ",
            "エ" => "チェ",
            "オ" => "チョ",
            _ => "チ",
        }
        .to_string(),
        "JH" => match v0 {
            "ア" => "ジャ",
            "イ" => "ジ",
            "ウ" => "ジュ",
            "エ" => "ジェ",
            "オ" => "ジョ",
            _ => "ジ",
        }
        .to_string(),
        // the/this のDHは「ザ行」で十分読みやすい
        "TH" => match v0 {
            "ア" => "サ",
            "イ" => "シ",
            "ウ" => "ス",
            "エ" => "セ",
            "オ" => "ソ",
            _ => "ス",
        }
        .to_string(),
        "DH" => match v0 {
            "ア" => "ザ",
            "イ" => "ジ",
            "ウ" => "ズ",
            "エ" => "ゼ",
            "オ" => "ゾ",
            _ => "ズ",
        }
        .to_string(),

        // fallback: keep old single-phoneme mapping
        _ => cons.to_string() + vowel,
    };

    if long && (base == "ア" || base == "イ" || base == "ウ" || base == "エ" || base == "オ") {
        return base + "ー";
    }

    let mut out = base;
    out.push_str(v_rest);
    if long {
        out.push('ー');
    }
    out
}

fn kana_coda(phonemes: &[String]) -> String {
    // coda handling: Japanese-like endings
    let Some(last) = phonemes
        .iter()
        .rev()
        .find(|p| !is_vowel_phoneme(p.as_str()))
    else {
        return String::new();
    };

    match last.as_str() {
        "N" => "ン".to_string(),
        "M" => "ム".to_string(),
        "NG" => "ング".to_string(),

        // stop consonants -> small tsu + consonant
        "D" => "ッド".to_string(),
        "T" => "ット".to_string(),
        "K" => "ック".to_string(),
        "P" => "ップ".to_string(),

        "S" => "ス".to_string(),
        "Z" => "ズ".to_string(),
        "SH" => "シュ".to_string(),
        "CH" => "チ".to_string(),
        "JH" => "ジ".to_string(),

        "R" | "L" => "ル".to_string(),
        "F" => "フ".to_string(),
        "V" => "ヴ".to_string(),
        _ => String::new(),
    }
}

fn syllable_to_kana(phonemes: &[String]) -> String {
    let Some(vowel_idx) = phonemes.iter().position(|p| is_vowel_phoneme(p)) else {
        return String::new();
    };

    let onset = &phonemes[..vowel_idx];
    let vowel = &phonemes[vowel_idx];
    let coda = &phonemes[(vowel_idx + 1)..];

    let vowel_stress = vowel
        .chars()
        .last()
        .and_then(|c| c.to_digit(10))
        .unwrap_or(0) as u8;

    let vowel_base = vowel.strip_suffix(['0', '1', '2']).unwrap_or(vowel);

    let (v_kana, is_long) = if vowel_stress == 0 {
        let (k, long) = kana_weak_vowel(vowel_base);
        if k.is_empty() {
            kana_vowel(vowel_base)
        } else {
            (k, long)
        }
    } else {
        kana_vowel(vowel_base)
    };

    let v = if v_kana.is_empty() { "ア" } else { v_kana };

    // pick the most important onset phoneme (simple)
    let cons = onset
        .iter()
        .find(|p| !p.is_empty())
        .map(|s| s.as_str())
        .unwrap_or("");

    let mut out = kana_cv(cons, v, is_long);
    out.push_str(&kana_coda(coda));
    out
}

fn fixed_linking(w: &str, next: &str) -> Option<&'static [&'static str]> {
    match (w, next) {
        ("have", "to") => Some(&["HH", "AE1", "F", "T", "AH0"]),
        ("has", "to") => Some(&["HH", "AE1", "S", "T", "AH0"]),
        ("had", "to") => Some(&["HH", "AE1", "D", "AH0"]),
        ("used", "to") => Some(&["Y", "UW1", "S", "T", "AH0"]),
        _ => None,
    }
}

fn weak_form(word: &str) -> Option<&'static [&'static str]> {
    match word {
        "to" => Some(&["T", "AH0"]),
        "a" => Some(&["AH0"]),
        "the" => Some(&["DH", "AH0"]),
        "of" => Some(&["AH0", "V"]),
        "for" => Some(&["F", "ER0"]),
        "and" => Some(&["AH0", "N"]),
        "that" => Some(&["DH", "AH0"]),
        "it" => Some(&["IH0", "T"]),
        _ => None,
    }
}

fn get_phonemes(word: &str, dict: Option<&CmuDict>) -> Vec<String> {
    if let Some(list) = weak_form(word) {
        return list.iter().map(|s| (*s).to_string()).collect();
    }

    if let Some(dict) = dict {
        if let Some(p) = dict.map.get(word) {
            return p.clone();
        }
    }

    vec![word.to_ascii_uppercase()]
}

#[tauri::command]
pub fn render_linking(
    app: AppHandle,
    text: String,
    linking_mode: Option<bool>,
    display_mode: Option<String>,
    use_dict: Option<bool>,
) -> Result<RenderLinkingResult, String> {
    let mode = display_mode_from_str(display_mode)?;
    let linking_mode = linking_mode.unwrap_or(true);
    let use_dict = use_dict.unwrap_or(true);

    let dict = if use_dict {
        Some(ensure_cmudict_loaded(&app)?)
    } else {
        None
    };

    let words = tokenize(&text);
    let mut chunks: Vec<RenderChunk> = Vec::new();

    let mut i = 0usize;
    while i < words.len() {
        let w = &words[i];

        // 固定リンキング
        if linking_mode && i + 1 < words.len() {
            let next = &words[i + 1];
            if let Some(fixed) = fixed_linking(w, next) {
                let phonemes: Vec<String> = fixed.iter().map(|s| (*s).to_string()).collect();
                let sylls = syllabify(&phonemes);

                let mut parts: Vec<String> = Vec::new();
                for syl in sylls {
                    if !syl.phonemes.iter().any(|p| is_vowel_phoneme(p)) {
                        continue;
                    }

                    let disp = match mode {
                        DisplayMode::Kana => syllable_to_kana(&syl.phonemes),
                        _ => syl
                            .phonemes
                            .iter()
                            .map(|p| phoneme_to_display(p, syl.stress, mode))
                            .collect::<Vec<_>>()
                            .join(""),
                    };
                    if !disp.is_empty() {
                        parts.push(format!("{}{}", stress_mark(syl.stress), disp));
                    }
                }

                let rendered = format!("{} {}({})", w, next, parts.join(""));
                chunks.push(RenderChunk {
                    words: vec![w.clone(), next.clone()],
                    phonemes,
                    rendered,
                });
                i += 2;
                continue;
            }
        }

        // 通常単語
        let phonemes = get_phonemes(w, dict.as_deref());
        let sylls = syllabify(&phonemes);

        let mut parts: Vec<String> = Vec::new();
        for syl in sylls {
            if !syl.phonemes.iter().any(|p| is_vowel_phoneme(p)) {
                continue;
            }

            let disp = match mode {
                DisplayMode::Kana => syllable_to_kana(&syl.phonemes),
                _ => syl
                    .phonemes
                    .iter()
                    .map(|p| phoneme_to_display(p, syl.stress, mode))
                    .collect::<Vec<_>>()
                    .join(""),
            };
            if !disp.is_empty() {
                parts.push(format!("{}{}", stress_mark(syl.stress), disp));
            }
        }

        let rendered = format!("{}({})", w, parts.join(""));
        chunks.push(RenderChunk {
            words: vec![w.clone()],
            phonemes,
            rendered,
        });
        i += 1;
    }

    let joined = chunks
        .iter()
        .map(|c| c.rendered.as_str())
        .collect::<Vec<_>>()
        .join(" | ");

    Ok(RenderLinkingResult {
        legend: "▲ 強 / △ 中 / ▽ 弱".to_string(),
        mode: match mode {
            DisplayMode::Phoneme => "phoneme".to_string(),
            DisplayMode::Kana => "kana".to_string(),
        },
        chunks,
        joined,
    })
}
