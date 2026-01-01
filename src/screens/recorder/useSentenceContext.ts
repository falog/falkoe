import { useEffect, useMemo, useState } from "react";
import type { Sentence } from "../../components/ExampleList";
import { sha256 } from "../../utils/hash";
import type { SourceKind, SpeechSource } from "../../types/speech";
import { useUploadedAudio } from "./useUploadedAudio";

function hashText(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

type UseSentenceContextResult = {
  sourceKind: SourceKind;
  sentenceHash: string;
  sentence: Sentence;
  uploadedAudioPath: string | null;
  uploadedFileAudioUrl: string;
  hasUploadedFile: boolean;
};

export function useSentenceContext(
  source: SpeechSource
): UseSentenceContextResult {
  const sourceKind: SourceKind = source.kind;

  const sentenceTextForHash: string = useMemo(() => {
    switch (source.kind) {
      case "tatoeba":
        return source.sentence?.text ?? "";
      case "uploaded":
      case "recorded":
        return source.text ?? "";
      default:
        return "";
    }
  }, [source]);

  const sentenceLangForHash: string = useMemo(() => {
    switch (source.kind) {
      case "tatoeba":
        return source.sentence?.lang ?? "";
      case "uploaded":
      case "recorded":
        return source.lang ?? "";
      default:
        return "";
    }
  }, [source]);

  const [sentenceHash, setSentenceHash] = useState<string>("");

  useEffect(() => {
    if (source.kind === "uploaded" && source.sentenceHash) {
      setSentenceHash(source.sentenceHash);
      return;
    }
    sha256(sentenceTextForHash, sentenceLangForHash).then(setSentenceHash);
  }, [source, sentenceTextForHash, sentenceLangForHash]);

  const { uploadedFileAudioUrl, uploadedAudioPath } = useUploadedAudio({
    source,
    sentenceHash,
    sentenceText: sentenceTextForHash,
    lang: sentenceLangForHash,
  });

  const sentence: Sentence = useMemo(() => {
    switch (source.kind) {
      case "tatoeba":
        return source.sentence;
      case "uploaded":
        return {
          id: hashText(source.text ?? "uploaded"),
          text: source.text ?? "",
          audioUrl: source.file ? uploadedFileAudioUrl : "",
          lang: source.lang,
        };
      case "recorded":
        return {
          id: hashText(source.text ?? "recorded"),
          text: source.text ?? "",
          audioUrl: source.filePath,
          lang: source.lang,
        };
    }
  }, [source, uploadedFileAudioUrl]);

  const hasUploadedFile = source.kind === "uploaded" && Boolean(source.file);

  return {
    sourceKind,
    sentenceHash,
    sentence,
    uploadedAudioPath,
    uploadedFileAudioUrl,
    hasUploadedFile,
  };
}
