import { useSyncExternalStore } from "react";

export type BackgroundTranscriptionJob = {
  key: string;
  kind: "recording" | "model" | "uploaded";
  startedAt: number;
};

type State = {
  active: Record<string, BackgroundTranscriptionJob>;
};

let state: State = { active: {} };
const listeners = new Set<() => void>();

function emitChange() {
  for (const l of listeners) l();
}

function setState(next: State) {
  state = next;
  emitChange();
}

export function subscribeBackgroundTranscription(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBackgroundTranscriptionState(): State {
  return state;
}

export function startBackgroundTranscription(job: {
  key: string;
  kind: BackgroundTranscriptionJob["kind"];
}) {
  setState({
    ...state,
    active: {
      ...state.active,
      [job.key]: {
        key: job.key,
        kind: job.kind,
        startedAt: Date.now(),
      },
    },
  });
}

export function cancelBackgroundTranscription(key: string) {
  if (!state.active[key]) return;
  const next = { ...state.active };
  delete next[key];
  setState({ ...state, active: next });
}

export function finishBackgroundTranscriptionByWavPath(wavPath: string) {
  const sentenceHash = extractSentenceHashFromSentenceWavPath(wavPath);

  const next = { ...state.active };
  // 1) exact wavPath key
  if (next[wavPath]) delete next[wavPath];

  // 2) model/uploaded keys (prefix by sentenceHash)
  if (sentenceHash) {
    for (const k of Object.keys(next)) {
      if (k.startsWith(sentenceHash + ":")) {
        delete next[k];
      }
    }
  }

  setState({ ...state, active: next });
}

export function extractSentenceHashFromSentenceWavPath(
  wavPath: string
): string | null {
  // Matches both POSIX and Windows-like separators.
  // Example: .../falkoe/sentences/<hash>/model/model.wav
  const m = wavPath.match(/[\\/]sentences[\\/]([^\\/]+)[\\/]/);
  return m?.[1] ?? null;
}

export function useBackgroundTranscription() {
  const s = useSyncExternalStore(
    subscribeBackgroundTranscription,
    getBackgroundTranscriptionState,
    getBackgroundTranscriptionState
  );
  const jobs = Object.values(s.active);
  return {
    activeCount: jobs.length,
    jobs,
  };
}
