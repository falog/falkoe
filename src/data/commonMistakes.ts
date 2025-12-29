export type MistakeFocus = "j" | "r" | "oo";
export type MistakePlayKind = "audio" | "explain";
export type SampleSpeaker = "falkoe" | "failed" | "advised-by-native";

export type MistakeInline = {
  kind: "text" | "code";
  value: string;
};

export type MistakeParagraph = MistakeInline[];

export type MistakeButton = {
  label: string;
  tok: string;
  kind: MistakePlayKind;
};

export type CommonMistake = {
  key: MistakeFocus;
  title: string;
  paragraphs: MistakeParagraph[];
  buttons: MistakeButton[];
};

export type CommonPitfall = {
  key: string;
  title: string;
  body: string;
  ipa?: string[];
};

export const COMMON_MISTAKES: CommonMistake[] = [
  {
    key: "j",
    title: "J: 文字のJとIPAの j を混同",
    paragraphs: [
      [
        { kind: "text", value: "英語の " },
        { kind: "code", value: "jump" },
        { kind: "text", value: " の“J”は" },
        { kind: "code", value: "j" },
        { kind: "text", value: "（yes の y）ではなく" },
        { kind: "code", value: "dʒ" },
        { kind: "text", value: "。" },
      ],
    ],
    buttons: [
      { label: "j (like yes)", tok: "j", kind: "audio" },
      { label: "j Explain", tok: "j", kind: "explain" },
      { label: "dʒ (like jump)", tok: "dʒ", kind: "audio" },
    ],
  },
  {
    key: "r",
    title: "R: run の r が 'zombie sound' っぽい",
    paragraphs: [
      [
        { kind: "text", value: "“唸り”を入れすぎてしまって、" },
        { kind: "code", value: "ɹ" },
        { kind: "text", value: "というより うなり声っぽく聞こえたらしい。" },
      ],
    ],
    buttons: [
      { label: "ɹ Pronounce", tok: "ɹ", kind: "audio" },
      { label: "ɹ Explain", tok: "ɹ", kind: "explain" },
    ],
  },
  {
    key: "oo",
    title: "oo: goose の uː が ʊ（book/look）寄りに聞こえる",
    paragraphs: [
      [
        { kind: "code", value: "uː" },
        { kind: "text", value: "（goose/too）を" },
        { kind: "code", value: "ʊ" },
        {
          kind: "text",
          value: "（book/look）みたいに短く・ゆるくしてしまった。",
        },
      ],
    ],
    buttons: [
      { label: "uː (goose/too)", tok: "uː", kind: "audio" },
      { label: "uː Explain", tok: "uː", kind: "explain" },
      { label: "ʊ (book/look)", tok: "ʊ", kind: "audio" },
    ],
  },
];

// Text-only notes (no audio yet). Add recordings later.
export const COMMON_PITFALLS: CommonPitfall[] = [
  {
    key: "example-j",
    title: "J: 文字のJとIPAの j を混同",
    body: "実例あり。jump の J は IPA の j（yesのy）ではなく dʒ。文字とIPAの見た目が似ていて混乱しやすい。",
    ipa: ["dʒ", "j"],
  },
  {
    key: "example-r",
    title: "R: /ɹ/ が唸り（zombie sound）っぽくなる",
    body: "実例あり。Rは頑張りすぎると唸りや濁りが乗りやすい。舌先をどこにも付けず、力を抜いて形だけ作る意識。",
    ipa: ["ɹ"],
  },
  {
    key: "example-oo",
    title: "oo: uː が ʊ（book/look）寄りに短くなる",
    body: "実例あり。goose/too の uː を短くゆるくすると book/look の ʊ に寄りやすい。長さ＋口の緊張の差を意識。",
    ipa: ["uː", "ʊ"],
  },
  {
    key: "th",
    title: "th: /θ/ と /ð/ を /s/ や /z/ に寄せてしまう",
    body: "舌先を歯に軽く当てて息を漏らす。/θ/ は無声音（think）、/ð/ は有声音（this）。日本語話者は /s/ や /z/ に置き換えがち。",
    ipa: ["θ", "ð", "s", "z"],
  },
  {
    key: "l-r",
    title: "L/R: /l/ と /ɹ/ を混同する",
    body: "/l/ は舌先が上の歯茎に触れる（light）。/ɹ/ は舌先を付けず、前寄りで丸める（right）。どっちも“rっぽい/ら行っぽい”でまとめない。",
    ipa: ["l", "ɹ"],
  },
  {
    key: "v-b",
    title: "V/B: /v/ を /b/ にしてしまう",
    body: "/v/ は下唇＋上の歯で摩擦（very）。/b/ は唇を閉じて破裂（berry）。摩擦が入っているかが差。",
    ipa: ["v", "b"],
  },
  {
    key: "f-h",
    title: "F/H: /f/ を /h/ にしてしまう",
    body: "/f/ は唇＋歯の摩擦（fine）。/h/ は喉側の息（high）。口元の形が違う。",
    ipa: ["f", "h"],
  },
  {
    key: "i-ih",
    title: "iː/ɪ: 長母音と短母音の差が消える",
    body: "beat の /iː/ は長く張る、bit の /ɪ/ は短くゆるい。長さだけでなく“口の緊張”も変わる。",
    ipa: ["iː", "ɪ"],
  },
  {
    key: "ae-e",
    title: "æ: /æ/ を /e/ に寄せる",
    body: "cat の /æ/ は口を横に大きく開ける。/e/（bed）より開きが強い。",
    ipa: ["æ", "e"],
  },
  {
    key: "uh-schwa",
    title: "ə: シュワ（弱母音）を全部はっきり読んでしまう",
    body: "about の最初の母音は /ə/ で弱く短い。英語は強勢のある母音だけが“はっきり”する。",
    ipa: ["ə"],
  },
  {
    key: "stress",
    title: "アクセント: 強勢位置がずれる",
    body: "母音の長さ・明瞭さが変わるので、子音よりも通じやすさに直結しやすい。まず強勢のある音節を決める。",
  },
  {
    key: "flap",
    title: "t/d: アメリカ英語のフラップ /ɾ/ を知らずに聞き取れない",
    body: "water/ladder などで t/d が [ɾ] に寄る。発音というより“同じ音に聞こえる現象”として知っておくと楽。",
    ipa: ["ɾ"],
  },
  {
    key: "ng",
    title: "ng: /ŋ/ を /nɡ/ と言ってしまう",
    body: "sing の語末は基本 /ŋ/（n + g ではない）。tongue のように g を発音する単語もあるので混ざりやすい。",
    ipa: ["ŋ"],
  },
];

export function mistakeFocusForIpa(ipa: string): MistakeFocus | null {
  // Only link from IPA list for tokens that actually appear on the
  // Developer’s mistakes page as “your mistakes” examples.
  if (ipa === "dʒ") return "j";
  if (ipa === "ɹ") return "r";
  if (ipa === "ʊ") return "oo";
  return null;
}

export type IpaSampleCategory = "consonants" | "vowels" | "others";

export function sampleCategoryForTok(tok: string): IpaSampleCategory {
  if (tok === "j" || tok === "dʒ" || tok === "ɹ") return "consonants";
  if (tok === "uː" || tok === "ʊ") return "vowels";
  return "others";
}

export function sampleFileStemForTok(tok: string): string {
  // Keep filenames ASCII + stable, since some IPA symbols are not filesystem-friendly.
  switch (tok) {
    case "dʒ":
      return "dzh";
    case "uː":
      return "oo";
    case "ʊ":
      return "foot";
    case "ɹ":
      return "r";
    case "j":
      return "j";
    default:
      // Fallback: user can rename or add explicit mapping later.
      return tok;
  }
}

export function sampleResourcePath(
  speaker: SampleSpeaker,
  tok: string,
  ext: "wav" = "wav"
): string {
  const cat = sampleCategoryForTok(tok);
  const stem = sampleFileStemForTok(tok);
  return `ipa/audio/${speaker}/${cat}/${stem}.${ext}`;
}

export function sampleResourceCandidates(
  speaker: SampleSpeaker,
  tok: string,
  ext: "wav" = "wav"
): string[] {
  const cat = sampleCategoryForTok(tok);
  const stem = sampleFileStemForTok(tok);

  // "falkoe" is special: it must always be clearly "fal's voice".
  // "failed" is also special: it must always be clearly the "failed take".
  // Therefore, do NOT fall back to the default bundled IPA audio.
  if (speaker === "falkoe" || speaker === "failed") {
    return [`ipa/audio/${speaker}/${cat}/${stem}.${ext}`];
  }

  return [`ipa/audio/${speaker}/${cat}/${stem}.${ext}`];
}
