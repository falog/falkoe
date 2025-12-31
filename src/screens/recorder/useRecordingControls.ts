import { useCallback, useEffect, useRef, useState } from "react";
import { message } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { startRecording, stopRecording } from "tauri-plugin-mic-recorder-api";
import type { Dispatch, SetStateAction } from "react";
import type { Transcript } from "../../types/recording";

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
  const [isRecording, setIsRecording] = useState(false);

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
      await startRecording();
      setIsRecording(true);
    } catch (e) {
      message.error(String(e));
    }
  }, []);

  const handleStopRecording = useCallback(async () => {
    setIsRecording(false);

    let movedPath: string;

    try {
      const recordedPath = await stopRecording();
      movedPath = await invoke<string>("move_recorded_audio", {
        srcPath: recordedPath,
        sentenceHash: sentenceHashRef.current,
      });
    } catch (e) {
      message.error("録音の保存に失敗しました");
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

    try {
      await invoke("run_whisper", {
        path: movedPath,
        sentenceHash: sentenceHashRef.current,
        lang: langRef.current,
      });
    } catch {
      setRecognizingRef.current((prev) => {
        if (!prev[movedPath]) return prev;
        const next = { ...prev };
        delete next[movedPath];
        return next;
      });
      setIsTranscribingRef.current(false);
      message.info("録音は保存されました（文字起こしは後で実行できます）");
    }

    await refreshFilesRef.current();
  }, []);

  return {
    isRecording,
    startRecording: handleStartRecording,
    stopRecording: handleStopRecording,
  };
}
