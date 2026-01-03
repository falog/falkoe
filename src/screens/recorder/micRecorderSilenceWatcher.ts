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
  // Called periodically with remaining time (ms) until auto-stop.
  onProgress?: (remainingMs: number) => void;
  // Called when silence ends (sound is detected).
  onSilenceEnd?: () => void;
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
  onProgress,
  onSilenceEnd,
}: StartMicRecorderSilenceWatcherArgs): Promise<MicRecorderSilenceWatcher> {
  // Guardrail: never auto-stop earlier than 3 seconds.
  const effectiveSilenceMs = Math.max(3000, silenceMs ?? 3000);
  const countdownStartMs = 300;
  let stopped = false;
  let silentFor = 0;
  let wasSilent = false; // 前フレームの無音状態を記録

  // Calibrate noise floor briefly so "silence" still works with constant noise
  // and different mic gains.
  const warmupMs = 300;
  let warmedUpFor = 0;
  // Use the minimum RMS during warmup as a proxy for noise floor.
  // Using an average can become too large if the user starts speaking during warmup,
  // which would make the silence threshold too strict and cause false "silence".
  let baselineMin = Number.POSITIVE_INFINITY;
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
      if (rms < baselineMin) baselineMin = rms;
      return;
    }

    if (adaptiveThreshold == null) {
      const baseline = Number.isFinite(baselineMin) ? baselineMin : 0;
      // Slightly above noise floor, but never below the provided absolute threshold.
      adaptiveThreshold = Math.max(rmsThreshold, baseline * 1.3);
    }

    if (rms < adaptiveThreshold) {
      silentFor += dt;
      wasSilent = true;
      if (onProgress) {
        const remaining = Math.max(0, effectiveSilenceMs - silentFor);
        if (silentFor >= countdownStartMs) {
          onProgress(remaining);
        }
      }
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
      // 音声検出：前フレームが無音だった場合のみ onSilenceEnd を呼ぶ
      if (wasSilent) {
        wasSilent = false;
        if (onSilenceEnd) {
          onSilenceEnd();
        }
      }
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
