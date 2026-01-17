import { useCallback, useEffect, useRef, useState } from "react";
import { message } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { startRecording, stopRecording } from "tauri-plugin-mic-recorder-api";
import type { Dispatch, SetStateAction } from "react";
import type { Transcript } from "../../types/recording";
import {
  cancelBackgroundTranscription,
  startBackgroundTranscription,
} from "../../state/backgroundTranscription";
import { useTranslation } from "react-i18next";

type Params = {
  sentenceHash: string;
  lang: string;
  refreshFiles: () => Promise<void>;
  setRecognizing: Dispatch<SetStateAction<Record<string, boolean>>>;
  setTranscripts: Dispatch<SetStateAction<Record<string, Transcript | null>>>;
  setIsTranscribing: Dispatch<SetStateAction<boolean>>;
};

export function useRecordingControls({
  sentenceHash,
  lang,
  refreshFiles,
  setRecognizing,
  setTranscripts,
  setIsTranscribing,
}: Params) {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [pendingRecordedPath, setPendingRecordedPath] = useState<string | null>(
    null
  );

  const sentenceHashRef = useRef(sentenceHash);
  const langRef = useRef(lang);
  const refreshFilesRef = useRef(refreshFiles);
  const setRecognizingRef = useRef(setRecognizing);
  const setTranscriptsRef = useRef(setTranscripts);
  const setIsTranscribingRef = useRef(setIsTranscribing);

  useEffect(() => {
    sentenceHashRef.current = sentenceHash;
    langRef.current = lang;
    refreshFilesRef.current = refreshFiles;
    setRecognizingRef.current = setRecognizing;
    setTranscriptsRef.current = setTranscripts;
    setIsTranscribingRef.current = setIsTranscribing;
  }, [
    sentenceHash,
    lang,
    refreshFiles,
    setRecognizing,
    setTranscripts,
    setIsTranscribing,
  ]);

  const handleStartRecording = useCallback(async () => {
    try {
      if (pendingRecordedPath) return;
      await startRecording();
      setIsRecording(true);
    } catch (e) {
      message.error(
        `${t("screens.recorder.messages.recordingStartFailed")}${String(e)}`
      );
    }
  }, [pendingRecordedPath, t]);

  const handleStopRecording = useCallback(async () => {
    setIsRecording(false);

    try {
      const recordedPath = await stopRecording();
      setPendingRecordedPath(recordedPath);
    } catch (e) {
      message.error(t("screens.recorder.messages.saveRecordingFailed"));
      await refreshFilesRef.current();
      return;
    }
  }, [t]);

  const savePendingRecording = useCallback(async () => {
    const recordedPath = pendingRecordedPath;
    if (!recordedPath) return;

    setPendingRecordedPath(null);

    let movedPath: string;
    try {
      movedPath = await invoke<string>("move_recorded_audio", {
        srcPath: recordedPath,
        sentenceHash: sentenceHashRef.current,
      });
    } catch {
      // If moving failed, keep the pending path so user can retry.
      setPendingRecordedPath(recordedPath);
      message.error(t("screens.recorder.messages.saveRecordingFailed"));
      await refreshFilesRef.current();
      return;
    }

    setRecognizingRef.current((prev) => ({
      ...prev,
      [movedPath]: true,
    }));
    setTranscriptsRef.current((prev) => ({
      ...prev,
      [movedPath]: null,
    }));
    setIsTranscribingRef.current(true);
    startBackgroundTranscription({ key: movedPath, kind: "recording" });

    try {
      await invoke("run_whisper", {
        path: movedPath,
        sentenceHash: sentenceHashRef.current,
        lang: langRef.current,
      });
    } catch {
      cancelBackgroundTranscription(movedPath);
      setRecognizingRef.current((prev) => {
        if (!prev[movedPath]) return prev;
        const next = { ...prev };
        delete next[movedPath];
        return next;
      });
      setIsTranscribingRef.current(false);
      message.info(
        t("screens.recorder.messages.recordingSavedTranscribeLater")
      );
    }

    await refreshFilesRef.current();
  }, [pendingRecordedPath, t]);

  const discardPendingRecording = useCallback(async () => {
    const recordedPath = pendingRecordedPath;
    if (!recordedPath) return;
    setPendingRecordedPath(null);
    try {
      await invoke("delete_temp_recording", { srcPath: recordedPath });
    } catch {
      // best-effort; ignore
    }
    await refreshFilesRef.current();
  }, [pendingRecordedPath]);

  return {
    isRecording,
    startRecording: handleStartRecording,
    stopRecording: handleStopRecording,
    pendingRecordedPath,
    savePendingRecording,
    discardPendingRecording,
  };
}
