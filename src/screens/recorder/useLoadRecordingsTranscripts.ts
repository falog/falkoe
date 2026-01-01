import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Recording, Transcript } from "../../types/recording";
import { loadTranscript } from "./transcriptUtils";

type Args = {
  recordings: Recording[];
  transcripts: Record<string, Transcript | null>;
  setTranscripts: Dispatch<SetStateAction<Record<string, Transcript | null>>>;
  recognizing?: Record<string, boolean>;
};

export function useLoadRecordingsTranscripts({
  recordings,
  transcripts,
  setTranscripts,
  recognizing,
}: Args) {
  const transcriptsRef = useRef(transcripts);
  const recognizingRef = useRef(recognizing);
  const retryTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>(
    {}
  );

  useEffect(() => {
    transcriptsRef.current = transcripts;
  }, [transcripts]);

  useEffect(() => {
    recognizingRef.current = recognizing;
  }, [recognizing]);

  useEffect(() => {
    return () => {
      const timers = retryTimersRef.current;
      for (const key of Object.keys(timers)) {
        clearTimeout(timers[key]);
      }
      retryTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const scheduleRetry = (path: string) => {
      if (retryTimersRef.current[path]) return;

      retryTimersRef.current[path] = setTimeout(async () => {
        delete retryTimersRef.current[path];
        if (cancelled) return;
        if (!recognizingRef.current?.[path]) return;

        try {
          const t = await loadTranscript(path);
          if (cancelled) return;
          if (!t) {
            scheduleRetry(path);
            return;
          }
          setTranscripts((prev) => ({ ...prev, [path]: t }));
        } catch {
          if (cancelled) return;
          scheduleRetry(path);
        }
      }, 800);
    };

    const run = async () => {
      for (const rec of recordings) {
        if (cancelled) return;

        const current = transcriptsRef.current[rec.path];
        const shouldTryLoad =
          current === undefined ||
          (current === null && Boolean(recognizing?.[rec.path]));

        if (!shouldTryLoad) continue;

        const transcript = await loadTranscript(rec.path);
        if (cancelled) return;

        setTranscripts((prev) => {
          if (prev[rec.path] !== undefined && prev[rec.path] !== null) {
            return prev;
          }
          return {
            ...prev,
            [rec.path]: transcript,
          };
        });

        if (!transcript && recognizing?.[rec.path]) {
          scheduleRetry(rec.path);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [recordings, recognizing, setTranscripts]);
}
