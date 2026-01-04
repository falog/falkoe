import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, SetStateAction } from "react";
import { confirmOverwriteExisting } from "./uiUtils";
import { loadModelTranscript, loadUploadedTranscript } from "./transcriptUtils";
import type { SourceKind } from "../../types/speech";

type Params = {
  sourceKind: SourceKind;
  uploadedAudioPath: string | null;
  sentenceHash: string;
  lang: string;
  sentenceAudioUrl: string;

  waitingModel: boolean;
  modelText: string | null;

  setModelText: Dispatch<SetStateAction<string | null>>;
  setWaitingModel: Dispatch<SetStateAction<boolean>>;
  setIsTranscribing: Dispatch<SetStateAction<boolean>>;
};

export function useModelRecognition({
  sourceKind,
  uploadedAudioPath,
  sentenceHash,
  lang,
  sentenceAudioUrl,
  waitingModel,
  modelText,
  setModelText,
  setWaitingModel,
  setIsTranscribing,
}: Params) {
  const recognizeModel = useCallback(async () => {
    // eslint-disable-next-line no-console
    console.log("model recognize clicked");

    if (waitingModel) return;

    if (sourceKind === "uploaded") {
      if (!uploadedAudioPath) return;
      const cached = await loadUploadedTranscript(uploadedAudioPath);
      if (cached) {
        const overwrite = await confirmOverwriteExisting();
        if (!overwrite) {
          setModelText(cached.segments.map((s) => s.text).join(" "));
          return;
        }
      }
    } else {
      const cached = await loadModelTranscript(sentenceHash);
      if (cached) {
        const overwrite = await confirmOverwriteExisting();
        if (!overwrite) {
          setModelText(cached.segments.map((s) => s.text).join(" "));
          return;
        }
      }
    }

    setWaitingModel(true);
    setIsTranscribing(true);

    if (sourceKind === "uploaded" && uploadedAudioPath) {
      invoke("run_whisper_uploaded", {
        uploadedPath: uploadedAudioPath,
        sentenceHash,
        lang,
      });
    } else {
      invoke("run_whisper_model", {
        url: sentenceAudioUrl,
        sentenceHash,
        lang,
      });
    }
  }, [
    lang,
    modelText,
    sentenceAudioUrl,
    sentenceHash,
    setIsTranscribing,
    setModelText,
    setWaitingModel,
    sourceKind,
    uploadedAudioPath,
    waitingModel,
  ]);

  const disabled =
    (sourceKind === "uploaded" && !uploadedAudioPath) ||
    (sourceKind !== "uploaded" && !sentenceAudioUrl) ||
    waitingModel;

  return {
    recognizeModel,
    disabled,
    loading: waitingModel,
  };
}
