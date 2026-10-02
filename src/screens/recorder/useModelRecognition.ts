import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { message } from "antd";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { confirmOverwriteExisting } from "./uiUtils";
import { loadModelTranscript, loadUploadedTranscript } from "./transcriptUtils";
import type { SourceKind } from "../../types/speech";
import {
  cancelBackgroundTranscription,
  startBackgroundTranscription,
} from "../../state/backgroundTranscription";

type Params = {
  sourceKind: SourceKind;
  uploadedAudioPath: string | null;
  sentenceHash: string;
  lang: string;
  sentenceAudioUrl: string;
  sentenceAudioUrlFallbacks?: string[];

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
  sentenceAudioUrlFallbacks,
  waitingModel,
  modelText,
  setModelText,
  setWaitingModel,
  setIsTranscribing,
}: Params) {
  const { t } = useTranslation();

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
      const key = `${sentenceHash}:uploaded`;
      startBackgroundTranscription({ key, kind: "uploaded" });
      invoke("run_whisper_uploaded", {
        uploadedPath: uploadedAudioPath,
        sentenceHash,
        lang,
      }).catch((e) => {
        cancelBackgroundTranscription(key);
        setWaitingModel(false);
        setIsTranscribing(false);
        // eslint-disable-next-line no-console
        console.error(e);
        message.error(
          `${t("screens.recorder.messages.recognizeStartFailed")}${String(e)}`,
        );
      });
    } else {
      const key = `${sentenceHash}:model`;
      startBackgroundTranscription({ key, kind: "model" });

      let modelAudioPath = sentenceAudioUrl;
      if (sourceKind === "tatoeba") {
        const audioUrls = Array.from(
          new Set([sentenceAudioUrl, ...(sentenceAudioUrlFallbacks ?? [])]
            .map((url) => url.trim())
            .filter(Boolean)),
        );
        let cacheError: unknown;
        let cachedPath: string | null = null;

        for (const url of audioUrls) {
          try {
            cachedPath = await invoke<string>("ensure_sentence_audio_cached", {
              audioId: sentenceHash,
              url,
            });
            break;
          } catch (e) {
            cacheError = e;
          }
        }

        if (!cachedPath) {
          cancelBackgroundTranscription(key);
          setWaitingModel(false);
          setIsTranscribing(false);
          message.error(
            `${t("screens.recorder.messages.audioLoadFailed")}${String(cacheError ?? "No model audio URL available")}`,
          );
          return;
        }

        modelAudioPath = cachedPath;
      }

      invoke("run_whisper_model", {
        url: modelAudioPath,
        sentenceHash,
        lang,
      }).catch((e) => {
        cancelBackgroundTranscription(key);
        setWaitingModel(false);
        setIsTranscribing(false);
        // eslint-disable-next-line no-console
        console.error(e);
        message.error(
          `${t("screens.recorder.messages.recognizeStartFailed")}${String(e)}`,
        );
      });
    }
  }, [
    lang,
    modelText,
    sentenceAudioUrl,
    sentenceAudioUrlFallbacks,
    sentenceHash,
    setIsTranscribing,
    setModelText,
    setWaitingModel,
    t,
    sourceKind,
    uploadedAudioPath,
    waitingModel,
  ]);

  const disabled =
    !sentenceHash ||
    (sourceKind === "uploaded" && !uploadedAudioPath) ||
    (sourceKind !== "uploaded" && !sentenceAudioUrl) ||
    waitingModel;

  return {
    recognizeModel,
    disabled,
    loading: waitingModel,
  };
}
