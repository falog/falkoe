import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Recording, Transcript } from "../../types/recording";
import { loadTranscript } from "./transcriptUtils";

type Args = {
  recordings: Recording[];
  transcripts: Record<string, Transcript | null>;
  setTranscripts: Dispatch<SetStateAction<Record<string, Transcript | null>>>;
};

export function useLoadRecordingsTranscripts({
  recordings,
  transcripts,
  setTranscripts,
}: Args) {
  const transcriptsRef = useRef(transcripts);

  useEffect(() => {
    transcriptsRef.current = transcripts;
  }, [transcripts]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      for (const rec of recordings) {
        if (cancelled) return;

        if (transcriptsRef.current[rec.path] !== undefined) {
          continue;
        }

        const transcript = await loadTranscript(rec.path);
        if (cancelled) return;

        setTranscripts((prev) => {
          if (prev[rec.path] !== undefined) return prev;
          return {
            ...prev,
            [rec.path]: transcript,
          };
        });
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [recordings, setTranscripts]);
}
