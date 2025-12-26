export type DisplayMode = "phoneme" | "kana";

export type LinkingOptions = {
  linkingMode?: boolean;
  displayMode?: DisplayMode;
};

// =============================
// 固定リンキング（1語扱い・先頭強勢）
// =============================
export const FIXED_LINKING: Record<string, string[]> = {
  "have to": ["HH", "AE1", "F", "T", "AH0"],
  "has to": ["HH", "AE1", "S", "T", "AH0"],
  "had to": ["HH", "AE1", "D", "AH0"],
  "used to": ["Y", "UW1", "S", "T", "AH0"],
};

// =============================
// 弱形（function words）
// =============================
export const WEAK_FORMS: Record<string, string[]> = {
  to: ["T", "AH0"],
  a: ["AH0"],
  the: ["DH", "AH0"],
  of: ["AH0", "V"],
  for: ["F", "ER0"],
  and: ["AH0", "N"],
  that: ["DH", "AH0"],
  it: ["IH0", "T"],
};

// =============================
// カタカナ（使うなら）
// =============================
const VOWELS: Record<string, string> = {
  AA: "アー",
  AE: "ア",
  AH: "ア",
  AO: "オー",
  AW: "アウ",
  AY: "アイ",
  EH: "エ",
  ER: "アー",
  EY: "エイ",
  IH: "イ",
  IY: "イー",
  OW: "オウ",
  OY: "オイ",
  UH: "ウ",
  UW: "ウー",
};

const CONSONANTS: Record<string, string> = {
  B: "ブ",
  CH: "チ",
  D: "ド",
  DH: "ザ",
  F: "フ",
  G: "グ",
  HH: "ハ",
  JH: "ジ",
  K: "ク",
  L: "ル",
  M: "ム",
  N: "ン",
  NG: "ング",
  P: "プ",
  R: "ル",
  S: "ス",
  SH: "シ",
  T: "ト",
  TH: "ス",
  V: "ヴ",
  W: "ウ",
  Y: "イ",
  Z: "ズ",
};

// =============================
// 弱母音
// =============================
const WEAK_VOWELS = new Set(["AH0", "ER0", "IH0", "UH0", "EH0", "AO0"]);

// CMUdictっぽい入力を受けられるようにする
export type CmuDictLike =
  | Record<string, string>
  | Record<string, string[]>
  | Record<string, string[][]>;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-zA-Z']+/g) ?? []).map((s) => s);
}

function isVowelPhoneme(p: string): boolean {
  return /[0-2]$/.test(p);
}

function stressMark(stress: number): string {
  if (stress === 1) return "▲";
  if (stress === 2) return "△";
  return "▽";
}

function phonemeToDisplay(
  p: string,
  stress: number,
  mode: DisplayMode
): string {
  const base = p.replace(/[0-2]$/, "");

  // 弱母音は曖昧音として残す
  if (WEAK_VOWELS.has(p) && stress === 0) {
    return mode === "phoneme" ? "ə" : "";
  }

  if (mode === "phoneme") {
    return base.toLowerCase();
  }

  if (VOWELS[base]) return VOWELS[base];
  if (CONSONANTS[base]) return CONSONANTS[base];
  return "";
}

type Syllable = {
  phonemes: string[];
  stress: number;
};

function syllabify(phonemes: string[]): Syllable[] {
  const syllables: Syllable[] = [];
  let buf: string[] = [];
  let stress = 0;

  for (const p of phonemes) {
    if (isVowelPhoneme(p)) {
      if (buf.length > 0) {
        syllables.push({ phonemes: buf, stress });
        buf = [];
      }
      stress = Number(p.slice(-1));
    }
    buf.push(p);
  }

  if (buf.length > 0) {
    syllables.push({ phonemes: buf, stress });
  }

  return syllables;
}

function normalizeCmuEntry(entry: unknown): string[] | null {
  if (typeof entry === "string") {
    const parts = entry.trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts : null;
  }

  if (Array.isArray(entry)) {
    // string[] or string[][]
    if (entry.length === 0) return null;

    if (typeof entry[0] === "string") {
      return (entry as string[]).slice();
    }

    if (Array.isArray(entry[0])) {
      const first = (entry as string[][])[0];
      return Array.isArray(first) ? first.slice() : null;
    }
  }

  return null;
}

function getPhonemes(word: string, dict?: CmuDictLike): string[] {
  if (WEAK_FORMS[word]) return WEAK_FORMS[word];

  if (dict && Object.prototype.hasOwnProperty.call(dict, word)) {
    const entry = (dict as any)[word];
    const normalized = normalizeCmuEntry(entry);
    if (normalized) return normalized;
  }

  return [word.toUpperCase()];
}

export type RenderChunk = {
  words: string[];
  phonemes: string[];
  rendered: string; // e.g. "have to(▲hhae... )" 相当
};

export function renderLinking(
  sentence: string,
  options: LinkingOptions = {},
  cmuDict?: CmuDictLike
): {
  legend: string;
  mode: DisplayMode;
  chunks: RenderChunk[];
  joined: string;
} {
  const linkingMode = options.linkingMode ?? true;
  const displayMode = options.displayMode ?? "phoneme";

  const words = tokenize(sentence);
  const chunks: RenderChunk[] = [];

  let i = 0;
  while (i < words.length) {
    const w = words[i];

    // 固定リンキング
    if (linkingMode && i + 1 < words.length) {
      const key = `${w} ${words[i + 1]}`;
      const fixed = FIXED_LINKING[key];
      if (fixed) {
        const sylls = syllabify(fixed);

        const parts: string[] = [];
        for (const syl of sylls) {
          if (!syl.phonemes.some(isVowelPhoneme)) continue;
          const disp = syl.phonemes
            .map((p) => phonemeToDisplay(p, syl.stress, displayMode))
            .join("");
          if (disp) parts.push(`${stressMark(syl.stress)}${disp}`);
        }

        const rendered = `${w} ${words[i + 1]}(${parts.join("")})`;
        chunks.push({ words: [w, words[i + 1]], phonemes: fixed, rendered });
        i += 2;
        continue;
      }
    }

    // 通常単語
    const ph = getPhonemes(w, cmuDict);
    const sylls = syllabify(ph);

    const parts: string[] = [];
    for (const syl of sylls) {
      if (!syl.phonemes.some(isVowelPhoneme)) continue;
      const disp = syl.phonemes
        .map((p) => phonemeToDisplay(p, syl.stress, displayMode))
        .join("");
      if (disp) parts.push(`${stressMark(syl.stress)}${disp}`);
    }

    const rendered = `${w}(${parts.join("")})`;
    chunks.push({ words: [w], phonemes: ph, rendered });
    i += 1;
  }

  return {
    legend: "▲ 強く読む / △ 少しだけ強く / ▽ 流す",
    mode: displayMode,
    chunks,
    joined: chunks.map((c) => c.rendered).join(" | "),
  };
}
