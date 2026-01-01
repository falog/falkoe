import { useEffect, useRef } from "react";
import type { Transcript } from "../../types/recording";
import type { SourceKind } from "../../types/speech";

type UseTranscriptionCompletionArgs = {
  sourceKind: SourceKind;
  sentenceText: string;
  displayText: string;
  modelText: string | null;
  isTranscribing: boolean;
  waitingModel: boolean;
  recognizing: Record<string, boolean>;
  transcripts: Record<string, Transcript | null>;
  setRecognizing: (
    action:
      | Record<string, boolean>
      | ((prev: Record<string, boolean>) => Record<string, boolean>)
  ) => void;
  setIsTranscribing: (action: boolean | ((prev: boolean) => boolean)) => void;
  setDisplayText: (action: string | ((prev: string) => string)) => void;
};

type UseTranscriptionCompletionResult = {
  isRecordingsTranscribing: boolean;
  showModelAreaTranscribing: boolean;
  autoRecognizingUploaded: boolean;
};

export function useTranscriptionCompletion({
  sourceKind,
  sentenceText,
  displayText,
  modelText,
  isTranscribing,
  waitingModel,
  recognizing,
  transcripts,
  setRecognizing,
  setIsTranscribing,
  setDisplayText,
}: UseTranscriptionCompletionArgs): UseTranscriptionCompletionResult {
  const hadRecordingRecognizingRef = useRef(false);

  useEffect(() => {
    if (!isTranscribing) return;
    if (waitingModel) return;

    const recognizingKeys = Object.keys(recognizing);
    if (recognizingKeys.length > 0) {
      hadRecordingRecognizingRef.current = true;
    } else if (hadRecordingRecognizingRef.current) {
      hadRecordingRecognizingRef.current = false;
      setIsTranscribing(false);
      return;
    } else {
      // uploaded/model など「recognizing で追えない」文字起こしはここで落とさない
      return;
    }

    const donePaths = recognizingKeys.filter((p) => transcripts[p]);
    if (donePaths.length === 0) return;

    setRecognizing((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const p of donePaths) {
        if (next[p]) {
          delete next[p];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [
    isTranscribing,
    waitingModel,
    recognizing,
    transcripts,
    setIsTranscribing,
    setRecognizing,
  ]);

  useEffect(() => {
    if (sourceKind !== "uploaded") return;

    const hasUserProvidedSentenceText = Boolean(sentenceText?.trim());
    const hasDisplayText = Boolean(displayText?.trim());
    const recognizedText = (modelText ?? "").trim();

    if (!hasUserProvidedSentenceText && !hasDisplayText && recognizedText) {
      setDisplayText(recognizedText);
    }

    // transcript-final を取りこぼしても、ファイルから modelText が読めていれば完了扱いにする
    if (
      isTranscribing &&
      !waitingModel &&
      Object.keys(recognizing).length === 0 &&
      recognizedText
    ) {
      setIsTranscribing(false);
    }
  }, [
    sourceKind,
    sentenceText,
    displayText,
    modelText,
    isTranscribing,
    waitingModel,
    recognizing,
    setDisplayText,
    setIsTranscribing,
  ]);

  const isRecordingsTranscribing =
    !waitingModel && Object.keys(recognizing).length > 0;
  const showModelAreaTranscribing = isTranscribing && !isRecordingsTranscribing;

  const autoRecognizingUploaded =
    sourceKind === "uploaded" &&
    isTranscribing &&
    !waitingModel &&
    Object.keys(recognizing).length === 0;

  return {
    isRecordingsTranscribing,
    showModelAreaTranscribing,
    autoRecognizingUploaded,
  };
}
