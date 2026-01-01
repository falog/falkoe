import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadUploadedTranscript } from "./transcriptUtils";

type Args = {
  sourceKind: string;
  sentenceText: string;
  uploadedAudioPath: string | null;
  status: string;
  sentenceHash: string;
  lang: string;
  setDisplayText: Dispatch<SetStateAction<string>>;
  setIsTranscribing: (value: boolean) => void;
};

export function useAutoTranscribeUploaded({
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
    if (
      sourceKind !== "uploaded" ||
      !(!sentenceText || sentenceText.trim() === "") ||
      !uploadedAudioPath ||
      status !== "ready" ||
      autoStartedRef.current
    ) {
      return;
    }

    autoStartedRef.current = true;

    let cancelled = false;

    const run = async () => {
      const cached = await loadUploadedTranscript(uploadedAudioPath);
      if (cancelled) return;

      if (cached) {
        const joined = cached.segments
          .map((s) => s.text)
          .join(" ")
          .trim();

        setDisplayText((prev) => prev || joined);
        return;
      }

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
