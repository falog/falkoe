import { useState, useCallback } from "react";
import { message } from "antd";
import { startRecording, stopRecording } from "tauri-plugin-mic-recorder-api";
import { invoke } from "@tauri-apps/api/core";

export const useRecording = (sentenceHash: string, lang: string) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const handleStartRecording = useCallback(async () => {
    try {
      await startRecording();
      setIsRecording(true);
    } catch (e) {
      message.error(String(e));
    }
  }, []);

  const handleStopRecording = useCallback(
    async (onSuccess: (movedPath: string) => void, onError: () => void) => {
      setIsRecording(false);
      let movedPath: string;

      try {
        const recordedPath = await stopRecording();
        movedPath = await invoke<string>("move_recorded_audio", {
          srcPath: recordedPath,
          sentenceHash: sentenceHash,
        });
      } catch (e) {
        message.error("録音の保存に失敗しました");
        onError();
        return;
      }

      setIsTranscribing(true);

      try {
        await invoke("run_whisper", {
          path: movedPath,
          sentenceHash: sentenceHash,
          lang: lang,
        });
        onSuccess(movedPath);
      } catch {
        setIsTranscribing(false);
        message.info("録音は保存されました（文字起こしは後で実行できます）");
      }
    },
    [sentenceHash, lang]
  );

  return {
    isRecording,
    isTranscribing,
    setIsTranscribing,
    handleStartRecording,
    handleStopRecording,
  };
};
