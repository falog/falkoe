import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState, type SetStateAction } from "react";
import type { Recording, Transcript } from "../../types/recording";
import { parseRecording } from "./transcriptUtils";

export type RecordingState = {
  recordings: Recording[];
  transcripts: Record<string, Transcript | null>;
  recognizing: Record<string, boolean>;
};

type UseRecordingsStateResult = {
  recordings: Recording[];
  transcripts: Record<string, Transcript | null>;
  recognizing: Record<string, boolean>;
  setTranscripts: (
    action: SetStateAction<Record<string, Transcript | null>>
  ) => void;
  setRecognizing: (action: SetStateAction<Record<string, boolean>>) => void;
  refreshFiles: () => Promise<void>;
};

export function useRecordingsState(
  sentenceHash: string
): UseRecordingsStateResult {
  const [recordingState, setRecordingState] = useState<RecordingState>({
    recordings: [],
    transcripts: {},
    recognizing: {},
  });

  const { recordings, transcripts, recognizing } = recordingState;

  const setTranscripts = useCallback(
    (action: SetStateAction<Record<string, Transcript | null>>) => {
      setRecordingState((prev) => ({
        ...prev,
        transcripts:
          typeof action === "function"
            ? (
                action as (
                  p: Record<string, Transcript | null>
                ) => Record<string, Transcript | null>
              )(prev.transcripts)
            : action,
      }));
    },
    []
  );

  const setRecognizing = useCallback(
    (action: SetStateAction<Record<string, boolean>>) => {
      setRecordingState((prev) => ({
        ...prev,
        recognizing:
          typeof action === "function"
            ? (
                action as (
                  p: Record<string, boolean>
                ) => Record<string, boolean>
              )(prev.recognizing)
            : action,
      }));
    },
    []
  );

  const setRecordings = useCallback((next: Recording[]) => {
    setRecordingState((prev) => ({ ...prev, recordings: next }));
  }, []);

  const refreshFiles = useCallback(async () => {
    const list = await invoke<string[]>("list_recordings", {
      sentenceHash,
    });

    const parsed = list.map(parseRecording).sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return b.timestamp.localeCompare(a.timestamp);
    });

    setRecordings(parsed);
  }, [sentenceHash, setRecordings]);

  useEffect(() => {
    setRecordingState({ recordings: [], transcripts: {}, recognizing: {} });
    void refreshFiles();
  }, [sentenceHash, refreshFiles]);

  return {
    recordings,
    transcripts,
    recognizing,
    setTranscripts,
    setRecognizing,
    refreshFiles,
  };
}
