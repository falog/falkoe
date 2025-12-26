import type { Sentence } from "../components/ExampleList";

export type SpeechSource =
  | {
      kind: "uploaded";
      file?: File;
      savedPath?: string; // persisted path of uploaded audio
      originalFilename?: string;
      sentenceHash?: string;
      text?: string;
      lang: string;
    }
  | {
      kind: "recorded";
      filePath: string;
      text?: string;
      lang: string;
    }
  | {
      kind: "tatoeba";
      sentence: Sentence;
    };
