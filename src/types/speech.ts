import type { Sentence, SentenceAttribution } from "../components/ExampleList";

export type SpeechSource =
  | {
      kind: "uploaded";
      file?: File;
      savedPath?: string; // persisted path of uploaded audio
      originalFilename?: string;
      sentenceHash?: string;
      text?: string;
      attribution?: SentenceAttribution;
      lang: string;
    }
  | {
      kind: "recorded";
      filePath: string;
      sentenceHash?: string;
      text?: string;
      attribution?: SentenceAttribution;
      lang: string;
    }
  | {
      kind: "tatoeba";
      sentence: Sentence;
    };

export type SourceKind = SpeechSource["kind"];
