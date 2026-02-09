use std::sync::Arc;

use tauri::AppHandle;

use super::{
    cmudict::{ensure_cmudict_loaded, CmuDict},
    types::{RenderChunk, RenderLinkingResult},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TokenKind {
    Word,
    Number,
    Punct,
}

#[derive(Clone, Debug)]
struct Token {
    // Raw token text as it appears in the input (preserve casing).
    raw: String,
    // Normalized key for dictionary lookup and rule matching.
    // For words: ASCII-lowercased. For numbers/punct: identical to raw.
    key: String,
    kind: TokenKind,
}

fn tokenize(text: &str) -> Vec<Token> {
    let mut out: Vec<Token> = Vec::new();
    let mut raw_buf = String::new();
    let mut key_buf = String::new();
    let mut buf_kind: Option<TokenKind> = None;

    let flush = |out: &mut Vec<Token>, raw_buf: &mut String, key_buf: &mut String, buf_kind: &mut Option<TokenKind>| {
        if let Some(kind) = *buf_kind {
            if !raw_buf.is_empty() {
                out.push(Token {
                    raw: std::mem::take(raw_buf),
                    key: std::mem::take(key_buf),
                    kind,
                });
            }
        }
        *buf_kind = None;
    };

    let mut it = text.chars().peekable();
    while let Some(ch) = it.next() {
        if ch.is_ascii_alphabetic() || ch == '\'' {
            if buf_kind != Some(TokenKind::Word) {
                flush(&mut out, &mut raw_buf, &mut key_buf, &mut buf_kind);
                buf_kind = Some(TokenKind::Word);
            }
            raw_buf.push(ch);
            key_buf.push(ch.to_ascii_lowercase());
            continue;
        }

        if ch.is_ascii_digit() {
            if buf_kind != Some(TokenKind::Number) {
                flush(&mut out, &mut raw_buf, &mut key_buf, &mut buf_kind);
                buf_kind = Some(TokenKind::Number);
            }
            raw_buf.push(ch);
            key_buf.push(ch);
            continue;
        }

        // Number group separators (e.g., 999,999,999 or 1_000_000).
        // Keep them in raw for display but drop from key so parsing works.
        if (ch == ',' || ch == '_') && buf_kind == Some(TokenKind::Number) {
            let next_is_digit = it.peek().is_some_and(|c| c.is_ascii_digit());
            let prev_is_digit = raw_buf.chars().last().is_some_and(|c| c.is_ascii_digit());
            if prev_is_digit && next_is_digit {
                raw_buf.push(ch);
                continue;
            }
        }

        flush(&mut out, &mut raw_buf, &mut key_buf, &mut buf_kind);

        // Preserve light punctuation as tokens so we can avoid linking across boundaries.
        // (e.g., "French, I also" should not merge into one chunk.)
        if matches!(ch, ',' | '.' | '?' | '!' | ';' | ':') {
            out.push(Token {
                raw: ch.to_string(),
                key: ch.to_string(),
                kind: TokenKind::Punct,
            });
        }
    }

    flush(&mut out, &mut raw_buf, &mut key_buf, &mut buf_kind);

    out
}

fn is_punct_token(s: &str) -> bool {
    matches!(s, "," | "." | "?" | "!" | ";" | ":")
}

fn is_number_token(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

fn is_month_word(s: &str) -> bool {
    matches!(
        s,
        "january"
            | "jan"
            | "february"
            | "feb"
            | "march"
            | "mar"
            | "april"
            | "apr"
            | "may"
            | "june"
            | "jun"
            | "july"
            | "jul"
            | "august"
            | "aug"
            | "september"
            | "sep"
            | "sept"
            | "october"
            | "oct"
            | "november"
            | "nov"
            | "december"
            | "dec"
            | "spring"
            | "summer"
            | "autumn"
            | "fall"
            | "winter"
    )
}

fn is_year_context(prev_key: Option<&str>, next_key: Option<&str>) -> bool {
    let prev = prev_key.unwrap_or("");
    let next = next_key.unwrap_or("");

    if is_month_word(prev) {
        return true;
    }

    if matches!(
        prev,
        "in" | "since" | "from" | "during" | "by" | "around" | "about" | "circa" | "ca" | "c" | "year" | "yr" | "years"
    ) {
        return true;
    }

    if matches!(next, "ad" | "bc" | "ce" | "bce") {
        return true;
    }

    false
}

fn builtin_word_phonemes(word: &str) -> Option<&'static [&'static str]> {
    // Minimal built-ins for number reading when CMUdict isn't available.
    Some(match word {
        "oh" => &["OW1"],
        "hundred" => &["HH", "AH1", "N", "D", "R", "AH0", "D"],
        "thousand" => &["TH", "AW1", "Z", "AH0", "N", "D"],
        "million" => &["M", "IH1", "L", "Y", "AH0", "N"],
        "billion" => &["B", "IH1", "L", "Y", "AH0", "N"],
        "trillion" => &["T", "R", "IH1", "L", "Y", "AH0", "N"],

        "zero" => &["Z", "IY1", "R", "OW0"],
        "one" => &["W", "AH1", "N"],
        "two" => &["T", "UW1"],
        "three" => &["TH", "R", "IY1"],
        "four" => &["F", "AO1", "R"],
        "five" => &["F", "AY1", "V"],
        "six" => &["S", "IH1", "K", "S"],
        "seven" => &["S", "EH1", "V", "AH0", "N"],
        "eight" => &["EY1", "T"],
        "nine" => &["N", "AY1", "N"],

        "ten" => &["T", "EH1", "N"],
        "eleven" => &["IH0", "L", "EH1", "V", "AH0", "N"],
        "twelve" => &["T", "W", "EH1", "L", "V"],
        "thirteen" => &["TH", "ER0", "T", "IY1", "N"],
        "fourteen" => &["F", "AO0", "R", "T", "IY1", "N"],
        "fifteen" => &["F", "IH0", "F", "T", "IY1", "N"],
        "sixteen" => &["S", "IH0", "K", "S", "T", "IY1", "N"],
        "seventeen" => &["S", "EH0", "V", "AH0", "N", "T", "IY1", "N"],
        "eighteen" => &["EY0", "T", "IY1", "N"],
        "nineteen" => &["N", "AY0", "N", "T", "IY1", "N"],

        "twenty" => &["T", "W", "EH1", "N", "T", "IY0"],
        "thirty" => &["TH", "ER1", "T", "IY0"],
        "forty" => &["F", "AO1", "R", "T", "IY0"],
        "fifty" => &["F", "IH1", "F", "T", "IY0"],
        "sixty" => &["S", "IH1", "K", "S", "T", "IY0"],
        "seventy" => &["S", "EH1", "V", "AH0", "N", "T", "IY0"],
        "eighty" => &["EY1", "T", "IY0"],
        "ninety" => &["N", "AY1", "N", "T", "IY0"],

        _ => return None,
    })
}

fn words_to_phonemes(words: &[&str], dict: Option<&CmuDict>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in words {
        if w.is_empty() {
            continue;
        }

        if let Some(dict) = dict {
            if let Some(p) = dict.map.get(*w) {
                out.extend(p.clone());
                continue;
            }
        }

        if let Some(list) = builtin_word_phonemes(w) {
            out.extend(list.iter().map(|p| (*p).to_string()));
            continue;
        }

        // Fallback: keep something visible.
        out.push(w.to_ascii_uppercase());
    }
    out
}

fn digit_to_word(d: u32) -> Option<&'static str> {
    Some(match d {
        0 => "zero",
        1 => "one",
        2 => "two",
        3 => "three",
        4 => "four",
        5 => "five",
        6 => "six",
        7 => "seven",
        8 => "eight",
        9 => "nine",
        _ => return None,
    })
}

fn two_digit_words(n: u32) -> Option<Vec<&'static str>> {
    if n == 0 {
        return Some(Vec::new());
    }
    if n < 10 {
        return Some(vec![digit_to_word(n)?]);
    }
    if n < 20 {
        return Some(vec![match n {
            10 => "ten",
            11 => "eleven",
            12 => "twelve",
            13 => "thirteen",
            14 => "fourteen",
            15 => "fifteen",
            16 => "sixteen",
            17 => "seventeen",
            18 => "eighteen",
            19 => "nineteen",
            _ => return None,
        }]);
    }

    let tens = n / 10;
    let ones = n % 10;
    let tens_word = match tens {
        2 => "twenty",
        3 => "thirty",
        4 => "forty",
        5 => "fifty",
        6 => "sixty",
        7 => "seventy",
        8 => "eighty",
        9 => "ninety",
        _ => return None,
    };

    if ones == 0 {
        return Some(vec![tens_word]);
    }

    Some(vec![tens_word, digit_to_word(ones)?])
}

fn year_style_words_20xx(n: u32) -> Option<Vec<&'static str>> {
    // 2000-2099 only.
    if n < 2000 || n > 2099 {
        return None;
    }

    let last_two = n % 100;
    let mut out: Vec<&'static str> = vec!["twenty"];

    if last_two == 0 {
        // 2000 -> "twenty" (not great), so let caller fall back to cardinal.
        return None;
    }

    if last_two < 10 {
        out.push("oh");
        out.push(digit_to_word(last_two)?);
        return Some(out);
    }

    out.extend(two_digit_words(last_two)?);
    Some(out)
}

fn cardinal_3digit_words(n: u32) -> Option<Vec<&'static str>> {
    if n < 100 || n > 999 {
        return None;
    }

    let hundreds = n / 100;
    let rem = n % 100;

    let mut out: Vec<&'static str> = vec![digit_to_word(hundreds)?, "hundred"];
    if rem == 0 {
        return Some(out);
    }
    out.extend(two_digit_words(rem)?);
    Some(out)
}

fn cardinal_4digit_words(n: u32) -> Option<Vec<&'static str>> {
    if n < 1000 || n > 2099 {
        return None;
    }

    let thousands = n / 1000;
    let mut rem = n % 1000;
    let mut out: Vec<&'static str> = Vec::new();

    out.push(digit_to_word(thousands)?);
    out.push("thousand");

    if rem == 0 {
        return Some(out);
    }

    if rem >= 100 {
        let hundreds = rem / 100;
        rem %= 100;
        out.push(digit_to_word(hundreds)?);
        out.push("hundred");
        if rem == 0 {
            return Some(out);
        }
    }

    out.extend(two_digit_words(rem)?);
    Some(out)
}

fn cardinal_large_words(n: u64) -> Option<Vec<&'static str>> {
    // Up to 999,999,999,999,999 (quadrillion-1)
    if n > 999_999_999_999_999 {
        return None;
    }

    if n < 100 {
        return two_digit_words(n as u32);
    }
    if n <= 999 {
        return cardinal_3digit_words(n as u32);
    }
    if n <= 2099 {
        return cardinal_4digit_words(n as u32);
    }

    let mut out: Vec<&'static str> = Vec::new();
    let mut rem = n;

    let scales: &[(u64, &str)] = &[
        (1_000_000_000_000, "trillion"),
        (1_000_000_000, "billion"),
        (1_000_000, "million"),
        (1_000, "thousand"),
    ];

    for (scale, name) in scales {
        if rem >= *scale {
            let group = (rem / *scale) as u32;
            rem %= *scale;
            let mut group_words = if group >= 100 {
                cardinal_3digit_words(group)?
            } else {
                two_digit_words(group)?
            };
            out.append(&mut group_words);
            out.push(*name);
        }
    }

    if rem > 0 {
        let tail = rem as u32;
        let mut tail_words = if tail >= 100 {
            cardinal_3digit_words(tail)?
        } else {
            two_digit_words(tail)?
        };
        out.append(&mut tail_words);
    }

    Some(out)
}

fn digit_phonemes(d: char) -> Option<&'static [&'static str]> {
    // Basic CMUdict-style pronunciations.
    // Note: We intentionally keep this simple (digit-by-digit) to avoid
    // locale/format ambiguities (e.g., 1,234 / 3.14).
    Some(match d {
        '0' => &["Z", "IY1", "R", "OW0"],
        '1' => &["W", "AH1", "N"],
        '2' => &["T", "UW1"],
        '3' => &["TH", "R", "IY1"],
        '4' => &["F", "AO1", "R"],
        '5' => &["F", "AY1", "V"],
        '6' => &["S", "IH1", "K", "S"],
        '7' => &["S", "EH1", "V", "AH0", "N"],
        '8' => &["EY1", "T"],
        '9' => &["N", "AY1", "N"],
        _ => return None,
    })
}

fn number_to_phonemes(s: &str) -> Option<Vec<String>> {
    if !is_number_token(s) {
        return None;
    }

    let mut out: Vec<String> = Vec::new();
    for ch in s.chars() {
        let list = digit_phonemes(ch)?;
        out.extend(list.iter().map(|p| (*p).to_string()));
    }
    Some(out)
}

fn is_vowel_phoneme(p: &str) -> bool {
    p.chars().last().is_some_and(|c| c.is_ascii_digit())
}

fn phoneme_base(p: &str) -> &str {
    p.strip_suffix(['0', '1', '2']).unwrap_or(p)
}

fn starts_with_vowel(phonemes: &[String]) -> bool {
    phonemes
        .first()
        .is_some_and(|p| is_vowel_phoneme(p.as_str()))
}

fn ends_with_vowel(phonemes: &[String]) -> bool {
    phonemes
        .last()
        .is_some_and(|p| is_vowel_phoneme(p.as_str()))
}

fn ends_with_consonant(phonemes: &[String]) -> bool {
    phonemes
        .last()
        .is_some_and(|p| !is_vowel_phoneme(p.as_str()))
}

fn stress_mark(stress: u8) -> &'static str {
    match stress {
        1 => "▲",
        2 => "△",
        _ => "▽",
    }
}

fn maybe_insert_glide(prev: &mut Vec<String>, next: &[String]) -> bool {
    // V + V を「繋いで聞こえる」感じに寄せる（go on / I am など）
    if !ends_with_vowel(prev) || !starts_with_vowel(next) {
        return false;
    }

    let Some(last) = prev.last() else {
        return false;
    };
    let base = phoneme_base(last);

    // 簡易ルール: 前の母音に応じて Y/W を挿入
    let glide = match base {
        // 前が /i/ 系 → y
        "IY" | "IH" | "EY" | "AY" => Some("Y"),
        // 前が /u,o/ 系 → w
        "UW" | "UH" | "OW" | "AW" => Some("W"),
        _ => None,
    };

    if let Some(g) = glide {
        prev.push(g.to_string());
        return true;
    }

    false
}

fn apply_connected_speech_rules(
    prev_word: &str,
    prev_phonemes: &mut Vec<String>,
    next_word: &str,
    next_phonemes: &mut Vec<String>,
) -> bool {
    // ルール適用後、「ひとかたまりチャンクにまとめるべきか」を返す。
    // ここでは発音が繋がりやすいケース（C-V / V-V / よくある同化）を対象にする。

    let mut should_join = false;

    // (0) the -> /ði/ before vowels (the apples)
    if prev_word == "the" && starts_with_vowel(next_phonemes) {
        let n = prev_phonemes.len();
        if n >= 2 && prev_phonemes[n - 2] == "DH" && phoneme_base(&prev_phonemes[n - 1]) == "AH" {
            // Keep it unstressed by default
            prev_phonemes[n - 1] = "IY0".to_string();
            should_join = true;
        }
    }

    // (1) H-dropping for common pronouns: meet him -> meet'im
    // HH + vowel の場合に HH を落として母音開始にする
    if matches!(next_word, "him" | "her" | "his" | "he") {
        if next_phonemes.first().is_some_and(|p| p == "HH")
            && next_phonemes
                .get(1)
                .is_some_and(|p| is_vowel_phoneme(p.as_str()))
        {
            next_phonemes.remove(0);
        }
    }

    // (2) T/D + Y -> CH/JH (did you / meet you)
    if let (Some(last), Some(first)) = (prev_phonemes.last_mut(), next_phonemes.first()) {
        if first == "Y" {
            match last.as_str() {
                "T" => {
                    *last = "CH".to_string();
                    next_phonemes.remove(0);
                    should_join = true;
                }
                "D" => {
                    *last = "JH".to_string();
                    next_phonemes.remove(0);
                    should_join = true;
                }
                _ => {}
            }
        }
    }

    // (3) V + V glide insertion
    if maybe_insert_glide(prev_phonemes, next_phonemes) {
        should_join = true;
    }

    // (4) General C-V (and V-V) linking: have an / an appointment / him at
    // ルール適用後の状態で判断する
    if ends_with_consonant(prev_phonemes) && starts_with_vowel(next_phonemes) {
        return true;
    }
    if ends_with_vowel(prev_phonemes) && starts_with_vowel(next_phonemes) {
        return true;
    }

    // (4.5) C + H + vowel (what happened / at home):
    // h は子音だが、知覚的にまとまりやすいのでチャンクを結合する。
    // ここでは音素自体は変更しない（表示上のリンキング目的）。
    if ends_with_consonant(prev_phonemes)
        && next_phonemes.first().is_some_and(|p| p == "HH")
        && next_phonemes
            .get(1)
            .is_some_and(|p| is_vowel_phoneme(p.as_str()))
    {
        return true;
    }

    // (5) Even if not C-V, we may want to join when we applied a special rule.
    if should_join {
        return true;
    }

    // Optional: if previous is a known weak form + next begins with vowel,
    // it tends to be perceived as connected. Keep it conservative.
    if matches!(prev_word, "to" | "a" | "the" | "of" | "for" | "and") && starts_with_vowel(next_phonemes) {
        return true;
    }

    false
}

fn is_weak_vowel(p: &str) -> bool {
    // CMUdictの reduced vowel は色々あるが、IPA表示で過剰にəに寄せすぎないため
    // ここでは代表的な schwa / r-colored schwa に限定する。
    matches!(p, "AH0" | "ER0")
}

fn arpabet_to_ipa(base: &str, stress: u8) -> Option<&'static str> {
    // General American-ish, learner-friendly mapping.
    // base は末尾の stress digit を落としたもの。
    Some(match base {
        // vowels
        "IY" => "i",
        "IH" => "ɪ",
        "EY" => "eɪ",
        "EH" => "ɛ",
        "AE" => "æ",
        "AA" => "ɑ",
        "AH" => {
            if stress == 0 {
                "ə"
            } else {
                "ʌ"
            }
        }
        "AO" => "ɔ",
        "OW" => "oʊ",
        "UH" => "ʊ",
        "UW" => "u",
        "AY" => "aɪ",
        "AW" => "aʊ",
        "OY" => "ɔɪ",
        "ER" => {
            if stress == 0 {
                "ɚ"
            } else {
                "ɝ"
            }
        }

        // consonants
        "P" => "p",
        "B" => "b",
        "T" => "t",
        "D" => "d",
        "K" => "k",
        "G" => "ɡ",
        "F" => "f",
        "V" => "v",
        "TH" => "θ",
        "DH" => "ð",
        "S" => "s",
        "Z" => "z",
        "SH" => "ʃ",
        "ZH" => "ʒ",
        "HH" | "H" => "h",
        "CH" => "tʃ",
        "JH" => "dʒ",
        "M" => "m",
        "N" => "n",
        "NG" => "ŋ",
        "L" => "l",
        "R" => "ɹ",
        "W" => "w",
        "Y" => "j",

        // common affix / symbols
        _ => return None,
    })
}

fn phoneme_to_display(p: &str, stress: u8, mode: DisplayMode) -> String {
    let base = phoneme_base(p);

    // 弱母音は曖昧音として残す
    if is_weak_vowel(p) && stress == 0 {
        return match mode {
            DisplayMode::Phoneme => "ə".to_string(),
            // Kanaで空にするとシラブルが欠けるので、最小でも母音を出す
            DisplayMode::Kana => "ア".to_string(),
        };
    }

    match mode {
        DisplayMode::Phoneme => arpabet_to_ipa(base, stress)
            .unwrap_or_else(|| base)
            .to_string(),
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
            let stress = p.chars().last().and_then(|c| c.to_digit(10)).unwrap_or(0) as u8;

            let mut phs = std::mem::take(&mut onset);

            // Heuristic for readability (esp. katakana):
            // If the next syllable onset looks like S + (CH/SH/JH), treat the leading S as
            // previous syllable coda instead of current onset. (question: /kwɛs.tʃən/)
            if phs.len() >= 2 {
                let a = phs[0].as_str();
                let b = phs[1].as_str();
                if a == "S" && matches!(b, "CH" | "SH" | "JH") {
                    if let Some(prev) = syllables.last_mut() {
                        prev.phonemes.push(phs.remove(0));
                    }
                }

                // Similar: keep leading N with the previous syllable when the onset is N + (CH/SH/JH).
                // This helps cases like "french or" -> /frɛn(t)ʃər/ feel like 「フレンチャー」.
                let a2 = phs[0].as_str();
                let b2 = phs.get(1).map(|s| s.as_str()).unwrap_or("");
                if a2 == "N" && matches!(b2, "CH" | "SH" | "JH") {
                    if let Some(prev) = syllables.last_mut() {
                        prev.phonemes.push(phs.remove(0));
                    }
                }
            }
            phs.push(p.clone());

            syllables.push(Syllable {
                phonemes: phs,
                stress,
            });
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
        // /ɔ/ はカタカナだと「オー」寄りが自然（all/call/talk 等）
        "AO" => ("オ", true),
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
        "AO" => ("ォ", true),
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
        // 母音のみ（二重母音は v0 + v_rest で表現）
        "" => v0.to_string(),

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
            "イ" => "ティ",
            "ウ" => "ツ",
            "エ" => "テ",
            "オ" => "ト",
            _ => "ツ",
        }
        .to_string(),
        "D" => match v0 {
            "ア" => "ダ",
            "イ" => "ディ",
            "ウ" => "ドゥ",
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

        // onset cluster: KW (question, quick)
        "KW" => match v0 {
            "ア" => "クァ",
            "イ" => "クィ",
            "ウ" => "ク",
            "エ" => "クェ",
            "オ" => "クォ",
            _ => "ク",
        }
        .to_string(),
        // onset cluster: PR (problem, practice)
        "PR" => match v0 {
            "ア" => "プラ",
            "イ" => "プリ",
            "ウ" => "プル",
            "エ" => "プレ",
            "オ" => "プロ",
            _ => "プロ",
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
        // onset cluster: FR (french, from)
        "FR" => match v0 {
            "ア" => "フラ",
            "イ" => "フリ",
            "ウ" => "フル",
            "エ" => "フレ",
            "オ" => "フロ",
            _ => "フレ",
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

        // consonant clusters (very small set)
        "ST" => match v0 {
            "ア" => "スタ",
            "イ" => "スティ",
            "ウ" => "ストゥ",
            "エ" => "ステ",
            "オ" => "スト",
            _ => "スト",
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

        // fallback: keep old single-phoneme mapping (use v0 + v_rest)
        _ => cons.to_string() + v0,
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
    let consonants: Vec<&str> = phonemes
        .iter()
        .filter(|p| !is_vowel_phoneme(p.as_str()))
        .map(|s| s.as_str())
        .collect();

    if consonants.is_empty() {
        return String::new();
    }

    // common endings like -nd, -nt
    if consonants.len() >= 2 {
        let a = consonants[consonants.len() - 2];
        let b = consonants[consonants.len() - 1];
        match (a, b) {
            ("N", "D") => return "ンド".to_string(),
            ("N", "T") => return "ント".to_string(),
            ("N", "K") => return "ンク".to_string(),
            ("N", "P") => return "ンプ".to_string(),
            ("N", "CH") => return "ンチ".to_string(),
            ("N", "SH") => return "ンシュ".to_string(),
            ("N", "JH") => return "ンジ".to_string(),
            ("M", "Z") => return "ムズ".to_string(),
            ("M", "S") => return "ムス".to_string(),
            _ => {}
        }
    }

    let last = consonants[consonants.len() - 1];

    match last {
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

    let (mut v_kana, mut is_long) = if vowel_stress == 0 {
        let (k, long) = kana_weak_vowel(vowel_base);
        if k.is_empty() {
            kana_vowel(vowel_base)
        } else {
            (k, long)
        }
    } else {
        kana_vowel(vowel_base)
    };

    // Special-case: /tʃən/ (question) is more readable as 「チョン」 than 「チャン」.
    // Detect CH + AH0 + N coda.
    let coda_cons: Vec<&str> = coda
        .iter()
        .filter(|p| !is_vowel_phoneme(p.as_str()))
        .map(|s| s.as_str())
        .collect();
    if vowel_stress == 0
        && vowel_base == "AH"
        && onset.iter().any(|p| p.as_str() == "CH")
        && coda_cons.last().is_some_and(|p| *p == "N")
    {
        v_kana = "オ";
        is_long = false;
    }

    // pick onset with minimal cluster handling
    let onset_cons: Vec<&str> = onset.iter().map(|s| s.as_str()).collect();
    let (prefix, cons) = if onset_cons.len() >= 2 {
        let a = onset_cons[onset_cons.len() - 2];
        let b = onset_cons[onset_cons.len() - 1];

        // N + (D/T) -> ン + D/T (understand: N D ER -> ンダー)
        if a == "N" && (b == "D" || b == "T") {
            ("ン", b)
        } else if a == "S" && b == "P" {
            // speak/sport -> ス + P...
            ("ス", "P")
        } else if a == "S" && b == "T" {
            ("", "ST")
        } else if a == "K" && b == "W" {
            ("", "KW")
        } else if a == "P" && b == "R" {
            ("", "PR")
        } else if a == "F" && b == "R" {
            ("", "FR")
        } else {
            ("", b)
        }
    } else if onset_cons.len() == 1 {
        ("", onset_cons[0])
    } else {
        ("", "")
    };

    // Special-case: don't (D OW N) is often written without a long mark: 「ドン」
    // Keep it narrow to avoid changing zone/known/phone, etc.
    if vowel_base == "OW" && cons == "D" && coda_cons.as_slice() == ["N"] {
        is_long = false;
    }

    let v = if v_kana.is_empty() { "ア" } else { v_kana };

    let mut out = String::new();
    out.push_str(prefix);
    out.push_str(&kana_cv(cons, v, is_long));

    // Long vowel + single stop coda is usually written without a small tsu in loanwords
    // (peak/speak/keep/need -> ピーク/スピーク/キープ/ニード).
    if is_long && coda_cons.len() == 1 {
        let stop = coda_cons[0];
        let tail = match stop {
            "K" => "ク",
            "T" => "ト",
            "D" => "ド",
            "P" => "プ",
            _ => "",
        };
        if !tail.is_empty() {
            out.push_str(tail);
            return out;
        }
    }

    out.push_str(&kana_coda(coda));
    out
}

fn syllable_to_ascii(phonemes: &[String]) -> String {
    // Learner-friendly ASCII-ish approximation (not strict IPA).
    // Intended as a fallback when katakana mapping gets awkward.
    fn base(p: &str) -> &str {
        phoneme_base(p)
    }

    fn c_to_ascii(p: &str) -> &'static str {
        match p {
            "CH" => "ch",
            "SH" => "sh",
            "ZH" => "zh",
            "TH" => "th",
            "DH" => "th",
            "JH" => "j",
            "NG" => "ng",
            "Y" => "y",
            "W" => "w",
            "R" => "r",
            "L" => "l",
            "HH" | "H" => "h",
            "P" => "p",
            "B" => "b",
            "T" => "t",
            "D" => "d",
            "K" => "k",
            "G" => "g",
            "F" => "f",
            "V" => "v",
            "S" => "s",
            "Z" => "z",
            "M" => "m",
            "N" => "n",
            _ => "",
        }
    }

    fn v_to_ascii(p: &str) -> &'static str {
        match p {
            "IY" => "ee",
            "IH" => "i",
            "EY" => "ay",
            "EH" => "e",
            "AE" => "a",
            "AA" => "ah",
            "AH" => "uh",
            "AO" => "aw",
            "OW" => "oh",
            "UH" => "oo",
            "UW" => "oo",
            "AY" => "ai",
            "AW" => "au",
            "OY" => "oy",
            "ER" => "er",
            _ => "",
        }
    }

    let mut out = String::new();
    for p in phonemes {
        let b = base(p);
        if is_vowel_phoneme(p) {
            out.push_str(v_to_ascii(b));
        } else {
            out.push_str(c_to_ascii(b));
        }
    }
    if out.is_empty() {
        // Last resort: show raw bases joined
        return phonemes
            .iter()
            .map(|p| base(p).to_ascii_lowercase())
            .collect::<Vec<_>>()
            .join("");
    }
    out
}

fn should_fallback_to_ascii(phonemes: &[String]) -> bool {
    // Heuristic: if a syllable has a complex consonant cluster that katakana tends to mangle,
    // prefer an ASCII approximation.
    let Some(vowel_idx) = phonemes.iter().position(|p| is_vowel_phoneme(p)) else {
        return false;
    };

    let onset_cons: Vec<&str> = phonemes[..vowel_idx]
        .iter()
        .filter(|p| !is_vowel_phoneme(p.as_str()))
        .map(|s| s.as_str())
        .collect();
    let coda_cons: Vec<&str> = phonemes[(vowel_idx + 1)..]
        .iter()
        .filter(|p| !is_vowel_phoneme(p.as_str()))
        .map(|s| s.as_str())
        .collect();

    // Too many consonants in onset/coda -> ASCII.
    if onset_cons.len() >= 3 || coda_cons.len() >= 3 {
        return true;
    }

    // Onset with 2 consonants: allow only the small set we explicitly support.
    if onset_cons.len() == 2 {
        let a = onset_cons[0];
        let b = onset_cons[1];
        let allowed = matches!(
            (a, b),
            ("S", "T")
                | ("K", "W")
                | ("P", "R")
                | ("F", "R")
                | ("S", "P")
                | ("N", "D")
                | ("N", "T")
        );
        if !allowed {
            return true;
        }
    }

    // Coda with 2 consonants: allow common ones we map; otherwise ASCII.
    if coda_cons.len() == 2 {
        let a = coda_cons[0];
        let b = coda_cons[1];
        let allowed = matches!(
            (a, b),
            ("N", "D")
                | ("N", "T")
                | ("N", "K")
                | ("N", "P")
                | ("M", "Z")
                | ("M", "S")
                | ("N", "CH")
                | ("N", "SH")
                | ("N", "JH")
        );
        if !allowed {
            return true;
        }
    }

    false
}

fn syllable_to_kana_or_ascii(phonemes: &[String]) -> String {
    if should_fallback_to_ascii(phonemes) {
        return syllable_to_ascii(phonemes);
    }

    let kana = syllable_to_kana(phonemes);

    // If kana mapping leaked ASCII (unknown consonant fallback) or produced nothing,
    // fall back to an ASCII approximation.
    let has_ascii = kana.chars().any(|c| c.is_ascii_alphabetic());
    if kana.is_empty() || has_ascii {
        return syllable_to_ascii(phonemes);
    }

    kana
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
        // contractions: often pronounced without a clear final /t/ in fast speech
        "don't" | "dont" => Some(&["D", "OW1", "N"]),
        "to" => Some(&["T", "AH0"]),
        "an" => Some(&["AH0", "N"]),
        "a" => Some(&["AH0"]),
        "the" => Some(&["DH", "AH0"]),
        "of" => Some(&["AH0", "V"]),
        "for" => Some(&["F", "ER0"]),
        // Often reduced to /ər/ in connected speech (French or German)
        "or" => Some(&["ER0"]),
        "and" => Some(&["AH0", "N"]),
        "that" => Some(&["DH", "AH0"]),
        "it" => Some(&["IH0", "T"]),
        _ => None,
    }
}

fn kana_override(word: &str) -> Option<&'static [&'static str]> {
    match word {
        // Japanese-friendly approximations (kana mode only)
        // problem -> プロブレム (approx: PR+OW0 / B+UH0 / R+EH0+M)
        "problem" => Some(&["P", "R", "OW0", "B", "UH0", "R", "EH0", "M"]),
        "problems" => Some(&["P", "R", "OW0", "B", "UH0", "R", "EH0", "M", "Z"]),
        _ => None,
    }
}

fn prev_non_punct_key<'a>(tokens: &'a [Token], idx: usize) -> Option<&'a str> {
    if idx == 0 {
        return None;
    }
    for j in (0..idx).rev() {
        if tokens[j].kind != TokenKind::Punct {
            return Some(tokens[j].key.as_str());
        }
    }
    None
}

fn next_non_punct_key<'a>(tokens: &'a [Token], idx: usize) -> Option<&'a str> {
    for j in (idx + 1)..tokens.len() {
        if tokens[j].kind != TokenKind::Punct {
            return Some(tokens[j].key.as_str());
        }
    }
    None
}

fn get_phonemes(word: &str, dict: Option<&CmuDict>, prev_key: Option<&str>, next_key: Option<&str>) -> Vec<String> {
    if is_punct_token(word) {
        return Vec::new();
    }

    if is_number_token(word) {
        // If it has leading zeros (e.g. 02), keep digit-by-digit to avoid ambiguity.
        if word.len() > 1 && word.starts_with('0') {
            if let Some(p) = number_to_phonemes(word) {
                return p;
            }
        }

        // Prefer structured cardinal reading when possible.
        // (We still handle 4-digit years with special context below.)
        if let Ok(n64) = word.parse::<u64>() {
            if word.len() != 4 {
                if let Some(words) = cardinal_large_words(n64) {
                    return words_to_phonemes(&words, dict);
                }
            }

            // 0-99: cardinal (30 -> thirty)
            if n64 < 100 {
                if let Some(words) = two_digit_words(n64 as u32) {
                    return words_to_phonemes(&words, dict);
                }
            }

            // 100-999: cardinal (305 -> three hundred five)
            if (100..=999).contains(&(n64 as u32)) {
                if let Some(words) = cardinal_3digit_words(n64 as u32) {
                    return words_to_phonemes(&words, dict);
                }
            }
        }

        // Special-case 4-digit years.
        if word.len() == 4 {
            if let Ok(n) = word.parse::<u32>() {
                if n >= 1000 && n <= 2099 {
                    let use_year_style = is_year_context(prev_key, next_key);
                    if use_year_style {
                        if let Some(words) = year_style_words_20xx(n) {
                            return words_to_phonemes(&words, dict);
                        }
                        // Fall through to cardinal if year-style isn't supported.
                    }

                    if let Some(words) = cardinal_4digit_words(n) {
                        return words_to_phonemes(&words, dict);
                    }
                }
            }
        }

        // Fallback: digit-by-digit.
        if let Some(p) = number_to_phonemes(word) {
            return p;
        }
    }

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

pub(crate) fn render_linking_impl(
    app: AppHandle,
    text: String,
    linking_mode: Option<bool>,
    display_mode: Option<String>,
    use_dict: Option<bool>,
) -> Result<RenderLinkingResult, String> {
    let mode = display_mode_from_str(display_mode)?;
    let linking_mode = linking_mode.unwrap_or(true);
    let use_dict = use_dict.unwrap_or(true);

    let dict: Option<Arc<CmuDict>> = if use_dict {
        Some(ensure_cmudict_loaded(&app)?)
    } else {
        None
    };

    let words = tokenize(&text);
    let mut chunks: Vec<RenderChunk> = Vec::new();

    let mut i = 0usize;
    while i < words.len() {
        let w = &words[i];
        let w_prev_key = prev_non_punct_key(&words, i);
        let w_next_key = next_non_punct_key(&words, i);

        // Punctuation is its own chunk and always breaks linking.
        if w.kind == TokenKind::Punct {
            chunks.push(RenderChunk {
                words: vec![w.raw.clone()],
                phonemes: Vec::new(),
                rendered: w.raw.clone(),
            });
            i += 1;
            continue;
        }

        let mut group_words_raw: Vec<String> = Vec::new();
        let mut group_words_key: Vec<String> = Vec::new();
        let mut group_phonemes: Vec<String>;
        let mut word_phoneme_lens: Vec<usize> = Vec::new();

        // 固定リンキング（have to / used to など）
        // Kana側は聞こえ方重視の固定句も少しだけ許容する（IPA側は壊さない）。
        if linking_mode && mode == DisplayMode::Kana && i + 1 < words.len() {
            let next = &words[i + 1];

            // at all -> 「アロー」寄り（flapでRっぽく聞こえる）
            if w.key == "at" && next.key == "all" {
                group_words_raw.push(w.raw.clone());
                group_words_raw.push(next.raw.clone());
                group_words_key.push(w.key.clone());
                group_words_key.push(next.key.clone());
                group_phonemes = ["AH0", "R", "AO1"]
                    .iter()
                    .map(|s| (*s).to_string())
                    .collect();
                // AH0 | R AO1
                word_phoneme_lens.push(1);
                word_phoneme_lens.push(2);
                i += 2;
            } else if let Some(fixed) = fixed_linking(&w.key, &next.key) {
                group_words_raw.push(w.raw.clone());
                group_words_raw.push(next.raw.clone());
                group_words_key.push(w.key.clone());
                group_words_key.push(next.key.clone());
                group_phonemes = fixed.iter().map(|s| (*s).to_string()).collect();
                word_phoneme_lens.push(group_phonemes.len());
                i += 2;
            } else {
                group_words_raw.push(w.raw.clone());
                group_words_key.push(w.key.clone());
                if let Some(list) = kana_override(&w.key) {
                    group_phonemes = list.iter().map(|s| (*s).to_string()).collect();
                } else {
                    group_phonemes = get_phonemes(&w.key, dict.as_deref(), w_prev_key, w_next_key);
                }
                word_phoneme_lens.push(group_phonemes.len());
                i += 1;
            }
        } else if linking_mode && i + 1 < words.len() {
            let next = &words[i + 1];
            if let Some(fixed) = fixed_linking(&w.key, &next.key) {
                group_words_raw.push(w.raw.clone());
                group_words_raw.push(next.raw.clone());
                group_words_key.push(w.key.clone());
                group_words_key.push(next.key.clone());
                group_phonemes = fixed.iter().map(|s| (*s).to_string()).collect();
                word_phoneme_lens.push(group_phonemes.len());
                i += 2;
            } else {
                group_words_raw.push(w.raw.clone());
                group_words_key.push(w.key.clone());
                group_phonemes = get_phonemes(&w.key, dict.as_deref(), w_prev_key, w_next_key);
                word_phoneme_lens.push(group_phonemes.len());
                i += 1;
            }
        } else {
            group_words_raw.push(w.raw.clone());
            group_words_key.push(w.key.clone());
            if mode == DisplayMode::Kana {
                if let Some(list) = kana_override(&w.key) {
                    group_phonemes = list.iter().map(|s| (*s).to_string()).collect();
                } else {
                    group_phonemes = get_phonemes(&w.key, dict.as_deref(), w_prev_key, w_next_key);
                }
            } else {
                group_phonemes = get_phonemes(&w.key, dict.as_deref(), w_prev_key, w_next_key);
            }
            word_phoneme_lens.push(group_phonemes.len());
            i += 1;
        }

        // 一般リンキング: ネイティブっぽく繋がりやすい境界は同一チャンクへ
        while linking_mode && i < words.len() {
            let next = &words[i];
            let next_word_raw = next.raw.clone();
            let next_word_key = next.key.clone();
            let next_next_key = next_non_punct_key(&words, i);

            // Never link across punctuation.
            if next.kind == TokenKind::Punct {
                break;
            }
            let prev_word_key = group_words_key.last().map(|s| s.as_str()).unwrap_or("");

            if is_punct_token(prev_word_key) {
                break;
            }

            // Kana: handle phrase tail "at all" even when it's inside a larger chunk
            // by replacing the previous word's phonemes (at) and the next word (all)
            // with a compact /əɾɔ/ approximation.
            if mode == DisplayMode::Kana && prev_word_key == "at" && next_word_key == "all" {
                let at_len = word_phoneme_lens.last().copied().unwrap_or(0);
                if at_len > 0 && at_len <= group_phonemes.len() {
                    group_phonemes.truncate(group_phonemes.len() - at_len);
                }
                group_phonemes.extend(["AH0", "R", "AO1"].iter().map(|s| (*s).to_string()));

                // Update lens: at -> AH0, all -> R AO1
                if let Some(last) = word_phoneme_lens.last_mut() {
                    *last = 1;
                }
                group_words_raw.push(next_word_raw);
                group_words_key.push(next_word_key);
                word_phoneme_lens.push(2);
                i += 1;
                continue;
            }

            let prev_for_next = group_words_key.last().map(|s| s.as_str());
            let mut next_phonemes = get_phonemes(&next_word_key, dict.as_deref(), prev_for_next, next_next_key);

            let prev_len_before = group_phonemes.len();
            let join = apply_connected_speech_rules(
                prev_word_key,
                &mut group_phonemes,
                &next_word_key,
                &mut next_phonemes,
            );

            // If prev phonemes were extended (e.g., glide insertion), attribute it to the last word.
            if let Some(last) = word_phoneme_lens.last_mut() {
                let delta = group_phonemes.len().saturating_sub(prev_len_before);
                *last = last.saturating_add(delta);
            }

            if !join {
                break;
            }

            group_words_raw.push(next_word_raw);
            group_words_key.push(next_word_key);
            let next_len = next_phonemes.len();
            group_phonemes.extend(next_phonemes);
            word_phoneme_lens.push(next_len);
            i += 1;
        }

        let sylls = syllabify(&group_phonemes);
        let mut parts: Vec<String> = Vec::new();
        for syl in sylls {
            if !syl.phonemes.iter().any(|p| is_vowel_phoneme(p)) {
                continue;
            }

            let disp = match mode {
                DisplayMode::Kana => syllable_to_kana_or_ascii(&syl.phonemes),
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

        let rendered = format!("{}({})", group_words_raw.join(" "), parts.join(""));
        chunks.push(RenderChunk {
            words: group_words_raw,
            phonemes: group_phonemes,
            rendered,
        });
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
