import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Transcript } from "../../types/recording";

type FinalResultPayload = {
  wav_path: string;
  segments: { text: string }[];
};

type Params = {
  sentenceId: string | number;
  sourceKind: string;
  sentenceText: string;
  waitingModel: boolean;

  loadTranscript: (wavPath: string) => Promise<Transcript | null>;

  setWaitingModel: (v: boolean) => void;
  setIsTranscribing: (v: boolean) => void;
  setModelText: (v: string | null) => void;
  setDisplayText: (updater: (prev: string) => string) => void;

  setRecognizing: (
    updater: (prev: Record<string, boolean>) => Record<string, boolean>
  ) => void;
  setTranscripts: (
    updater: (
      prev: Record<string, Transcript | null>
    ) => Record<string, Transcript | null>
  ) => void;
};

export function useWhisperEvents({
  sentenceId,
  sourceKind,
  sentenceText,
  waitingModel,
  loadTranscript,
  setWaitingModel,
  setIsTranscribing,
  setModelText,
  setDisplayText,
  setRecognizing,
  setTranscripts,
}: Params) {
  const waitingModelRef = useRef(waitingModel);
  const sourceKindRef = useRef(sourceKind);
  const sentenceTextRef = useRef(sentenceText);

  useEffect(() => {
    waitingModelRef.current = waitingModel;
  }, [waitingModel]);

  useEffect(() => {
    sourceKindRef.current = sourceKind;
  }, [sourceKind]);

  useEffect(() => {
    sentenceTextRef.current = sentenceText;
  }, [sentenceText]);

  useEffect(() => {
    const unlisten = listen<string>("transcript-started", (e) => {
      const wavPath = e.payload;
      setTranscripts((prev) => ({
        ...prev,
        [wavPath]: null,
      }));

      setRecognizing((prev) => ({
        ...prev,
        [wavPath]: true,
      }));
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [setRecognizing, setTranscripts]);

  useEffect(() => {
    const unlisten = listen<string>("transcript-ready", async (e) => {
      const wavPath = e.payload;
      if (!wavPath.endsWith(".wav")) return;

      const transcript = await loadTranscript(wavPath);
      setWaitingModel(false);
      setIsTranscribing(false);

      setRecognizing((prev) => {
        if (!prev[wavPath]) return prev;
        const next = { ...prev };
        delete next[wavPath];
        return next;
      });

      setTranscripts((prev) => ({
        ...prev,
        [wavPath]: transcript,
      }));
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [
    sentenceId,
    loadTranscript,
    setIsTranscribing,
    setRecognizing,
    setTranscripts,
    setWaitingModel,
  ]);

  useEffect(() => {
    const unlistenPromise = listen<FinalResultPayload>(
      "transcript-final",
      (e) => {
        setIsTranscribing(false);
        const result = e.payload;

        setRecognizing((prev) => {
          if (!prev[result.wav_path]) return prev;
          const next = { ...prev };
          delete next[result.wav_path];
          return next;
        });

        if (waitingModelRef.current) {
          setModelText(result.segments.map((s) => s.text).join(" "));
          setWaitingModel(false);
          return;
        }

        const joined = result.segments
          .map((s) => s.text)
          .join(" ")
          .trim();

        if (
          sourceKindRef.current === "uploaded" &&
          (!sentenceTextRef.current || sentenceTextRef.current.trim() === "")
        ) {
          setDisplayText((prev) => prev || joined);
          try {
            sessionStorage.setItem("falkoe.recognizedText", joined);
          } catch {}
        }

        setTranscripts((prev) => ({
          ...prev,
          [result.wav_path]: {
            segments: (result.segments as any[]).map((seg) => ({
              start: 0,
              end: 0,
              text: seg.text,
            })),
          },
        }));
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [
    setDisplayText,
    setIsTranscribing,
    setModelText,
    setRecognizing,
    setTranscripts,
    setWaitingModel,
  ]);
}
