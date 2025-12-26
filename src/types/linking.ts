export type DisplayMode = "phoneme" | "kana";

export type RenderChunk = {
  words: string[];
  phonemes: string[];
  rendered: string;
};

export type RenderLinkingResult = {
  legend: string;
  mode: DisplayMode;
  chunks: RenderChunk[];
  joined: string;
};
