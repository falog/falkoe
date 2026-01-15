import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { message } from "antd";
import type { Recording } from "../../types/recording";
import type { ModelStatus } from "../../types/model";
import {
  cancelBackgroundTranscription,
  startBackgroundTranscription,
} from "../../state/backgroundTranscription";
import { useTranslation } from "react-i18next";

export function useRecognizeRecording(params: {
  status: ModelStatus;
  sentenceHash: string;
  lang: string;
  recognizing: Record<string, boolean>;
  setRecognizing: (
    updater: (prev: Record<string, boolean>) => Record<string, boolean>
  ) => void;
  setIsTranscribing: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const {
    status,
    sentenceHash,
    lang,
    recognizing,
    setRecognizing,
    setIsTranscribing,
  } = params;

  const recognizeRecording = useCallback(
    async (rec: Recording) => {
      if (status !== "ready") return;
      if (recognizing[rec.path]) return;

      setRecognizing((prev) => ({ ...prev, [rec.path]: true }));
      setIsTranscribing(true);
      startBackgroundTranscription({ key: rec.path, kind: "recording" });
      try {
        await invoke("run_whisper", {
          path: rec.path,
          sentenceHash,
          lang,
        });
      } catch (e) {
        cancelBackgroundTranscription(rec.path);
        setRecognizing((prev) => {
          const next = { ...prev };
          delete next[rec.path];
          return next;
        });
        setIsTranscribing(false);
        message.error(
          `${t("screens.recorder.messages.recognizeStartFailed")}${String(e)}`
        );
      }
    },
    [
      lang,
      recognizing,
      sentenceHash,
      setIsTranscribing,
      setRecognizing,
      status,
      t,
    ]
  );

  return { recognizeRecording };
}
