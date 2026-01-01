import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadUploadedTranscript } from "./transcriptUtils";
import type { SourceKind } from "../../types/speech";
import type { ModelStatus } from "../../types/model";

type Args = {
  enabled?: boolean;
  loadCached?: boolean;
  sourceKind: SourceKind;
  sentenceText: string;
  uploadedAudioPath: string | null;
  status: ModelStatus;
  sentenceHash: string;
  lang: string;
  setDisplayText: Dispatch<SetStateAction<string>>;
  setIsTranscribing: (value: boolean) => void;
};

export function useAutoTranscribeUploaded({
  enabled = true,
  loadCached = true,
  sourceKind,
  sentenceText,
  uploadedAudioPath,
  status,
  sentenceHash,
  lang,
  setDisplayText,
  setIsTranscribing,
}: Args) {
  const autoStartedRef = useRef(false);

  useEffect(() => {
    autoStartedRef.current = false;
  }, [sentenceHash]);

  useEffect(() => {
    if (sourceKind !== "uploaded" || !uploadedAudioPath) {
      return;
    }

    // 手動でテキストが入力済みなら自動認識は不要
    if (sentenceText.trim() !== "") {
      return;
    }

    if (!enabled && !loadCached) {
      return;
    }

    if (autoStartedRef.current) {
      return;
    }

    let cancelled = false;

    const run = async () => {
      if (loadCached) {
        const cached = await loadUploadedTranscript(uploadedAudioPath);
        if (cancelled) return;

        if (cached) {
          const joined = cached.segments
            .map((s) => s.text)
            .join(" ")
            .trim();

          setDisplayText((prev) => prev || joined);
          autoStartedRef.current = true;
          return;
        }
      }

      if (!enabled) return;
      if (status !== "ready") return;

      autoStartedRef.current = true;

      invoke("run_whisper_uploaded", {
        uploadedPath: uploadedAudioPath,
        sentenceHash,
        lang,
      });

      setIsTranscribing(true);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    loadCached,
    sourceKind,
    sentenceText,
    uploadedAudioPath,
    status,
    sentenceHash,
    lang,
    setDisplayText,
    setIsTranscribing,
  ]);
}
