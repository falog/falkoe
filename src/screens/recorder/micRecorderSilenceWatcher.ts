import { listen } from "@tauri-apps/api/event";

export type StartMicRecorderSilenceWatcherArgs = {
  // How long continuous silence must last before triggering onSilence.
  // Defaults to 3000ms.
  silenceMs?: number;
  // 0..1 RMS threshold. Smaller => more sensitive (treats quieter as sound).
  rmsThreshold: number;
  // Used as a fallback step size if event timestamps are not available.
  pollIntervalMs: number;
  // Return false to keep watching (e.g., not yet recording).
  onSilence: () => boolean | void;
};

export type MicRecorderSilenceWatcher = {
  stop: () => void;
};

// Uses RMS levels emitted by the native mic-recorder plugin (no getUserMedia).
export async function startMicRecorderSilenceWatcher({
  silenceMs,
  rmsThreshold,
  pollIntervalMs,
  onSilence,
}: StartMicRecorderSilenceWatcherArgs): Promise<MicRecorderSilenceWatcher> {
  // Guardrail: never auto-stop earlier than 3 seconds.
  const effectiveSilenceMs = Math.max(3000, silenceMs ?? 3000);
  let stopped = false;
  let silentFor = 0;

  // Calibrate noise floor briefly so "silence" still works with constant noise
  // and different mic gains.
  const warmupMs = 300;
  let warmedUpFor = 0;
  let baselineSum = 0;
  let baselineSamples = 0;
  let adaptiveThreshold: number | null = null;

  let lastTs: number | null = null;

  const unlisten = await listen<any>("mic-recorder:level", (event) => {
    if (stopped) return;

    const payload = event.payload as any;
    const rms =
      typeof payload === "number"
        ? payload
        : typeof payload?.rms === "number"
          ? payload.rms
          : null;

    if (rms == null) return;

    const now = performance.now();

    const dt =
      lastTs == null
        ? pollIntervalMs
        : Math.max(0, Math.min(250, now - lastTs));

    lastTs = now;

    if (adaptiveThreshold == null && warmedUpFor < warmupMs) {
      warmedUpFor += dt;
      baselineSum += rms;
      baselineSamples += 1;
      return;
    }

    if (adaptiveThreshold == null) {
      const baseline = baselineSamples > 0 ? baselineSum / baselineSamples : 0;
      adaptiveThreshold = Math.max(rmsThreshold, baseline * 1.8);
    }

    if (rms < adaptiveThreshold) {
      silentFor += dt;
      if (silentFor >= effectiveSilenceMs) {
        let shouldStop = true;
        try {
          const res = onSilence();
          if (res === false) shouldStop = false;
        } finally {
          if (shouldStop) {
            stop();
          } else {
            silentFor = 0;
          }
        }
      }
    } else {
      silentFor = 0;
    }
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      void unlisten();
    } catch {}
  };

  return { stop };
}
