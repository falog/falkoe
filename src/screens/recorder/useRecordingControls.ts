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
    null,
  );

  const sentenceHashRef = useRef(sentenceHash);
  const langRef = useRef(lang);
  const refreshFilesRef = useRef(refreshFiles);
  const setRecognizingRef = useRef(setRecognizing);
  const setTranscriptsRef = useRef(setTranscripts);
  const setIsTranscribingRef = useRef(setIsTranscribing);

  const ensureMicPermission = useCallback(async () => {
    const ua =
      typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : "";
    if (!/Android/i.test(ua)) return;
    if (!navigator.mediaDevices?.getUserMedia) return;

    // Best-effort: some WebView environments deny getUserMedia() even when the
    // native (cpal-based) recorder can still work via the Tauri plugin.
    // Never block recording start on this warm-up call.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }, []);

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
      await ensureMicPermission();
      await startRecording();
      setIsRecording(true);
    } catch (e) {
      message.error(
        `${t("screens.recorder.messages.recordingStartFailed")}${String(e)}`,
      );
    }
  }, [ensureMicPermission, pendingRecordedPath, t]);

  const handleStopRecording = useCallback(async () => {
    setIsRecording(false);

    try {
      const recordedPath = await stopRecording();
      setPendingRecordedPath(recordedPath);
    } catch (e) {
      console.warn("[useRecordingControls] stopRecording failed; attempting recovery", e);

      // Recovery: sometimes the recorder produces a temp wav but stopRecording()
      // fails (e.g. finalize error). Try to locate the newest temp file.
      try {
        const temps = await invoke<string[]>("list_temp_recordings");
        if (temps?.length) {
          // Try newest-first and only accept a file that looks like a valid WAV
          // (we use ensure_wav_pcm16 as a best-effort validator/normalizer).
          for (let i = temps.length - 1; i >= 0; i--) {
            const candidate = temps[i];
            if (!candidate) continue;
            try {
              await invoke("ensure_wav_pcm16", { path: candidate });
              setPendingRecordedPath(candidate);
              return;
            } catch {
              // keep trying older temp files
            }
          }
        }
      } catch (recoverErr) {
        console.warn("[useRecordingControls] temp recording recovery failed", recoverErr);
      }

      message.error(
        `${t("screens.recorder.messages.saveRecordingFailed")}${String(e)}`,
      );
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
    } catch (e) {
      // If moving failed, keep the pending path so user can retry.
      setPendingRecordedPath(recordedPath);
      message.error(
        `${t("screens.recorder.messages.saveRecordingFailed")}${String(e)}`,
      );
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
        t("screens.recorder.messages.recordingSavedTranscribeLater"),
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
