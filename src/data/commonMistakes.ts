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

export function mistakeFocusForIpa(ipa: string): MistakeFocus | null {
  // Only link from IPA list for tokens that actually appear on the
  // Developer’s mistakes page as “your mistakes” examples.
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
