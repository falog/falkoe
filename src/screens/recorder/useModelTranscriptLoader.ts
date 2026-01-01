import { useEffect } from "react";
import { loadModelTranscript, loadUploadedTranscript } from "./transcriptUtils";
import type { SourceKind } from "../../types/speech";

type Args = {
  sentenceHash: string;
  sourceKind: SourceKind;
  uploadedAudioPath: string | null;
  waitingModel: boolean;
  setModelText: (value: string | null) => void;
};

export function useModelTranscriptLoader({
  sentenceHash,
  sourceKind,
  uploadedAudioPath,
  waitingModel,
  setModelText,
}: Args) {
  useEffect(() => {
    if (!sentenceHash) return;
    if (waitingModel) return;

    let cancelled = false;

    const run = async () => {
      try {
        const transcript =
          sourceKind === "uploaded"
            ? uploadedAudioPath
              ? await loadUploadedTranscript(uploadedAudioPath)
              : null
            : await loadModelTranscript(sentenceHash);

        if (cancelled) return;

        if (transcript && transcript.segments.length > 0) {
          setModelText(transcript.segments.map((s) => s.text).join(" "));
        } else {
          setModelText(null);
        }
      } catch {
        if (cancelled) return;
        setModelText(null);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [sentenceHash, sourceKind, uploadedAudioPath, waitingModel, setModelText]);
}
