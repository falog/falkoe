export type StartSilenceWatcherArgs = {
  // How long continuous silence must last before triggering onSilence.
  // Defaults to 3000ms.
  silenceMs?: number;
  // 0..1 RMS threshold. Smaller => more sensitive (treats quieter as sound).
  rmsThreshold: number;
  pollIntervalMs: number;
  // Return false to keep watching (e.g., not yet recording).
  onSilence: () => boolean | void;
};

export type SilenceWatcher = {
  stop: () => void;
};

export async function startSilenceWatcher({
  silenceMs,
  rmsThreshold,
  pollIntervalMs,
  onSilence,
}: StartSilenceWatcherArgs): Promise<SilenceWatcher> {
  // Guardrail: never auto-stop earlier than 3 seconds.
  const effectiveSilenceMs = Math.max(3000, silenceMs ?? 3000);
  if (typeof window === "undefined") {
    throw new Error("silence watcher is only available in browser context");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia is not available");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
  });
  const audioContext = new (
    window.AudioContext || (window as any).webkitAudioContext
  )();

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;

  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  const buf = new Uint8Array(analyser.fftSize);

  let silentFor = 0;
  let stopped = false;

  // Calibrate noise floor briefly so "silence" still works with constant noise.
  // e.g. baseline=0.02 => adaptive threshold becomes ~0.036.
  const warmupMs = 300;
  let warmedUpFor = 0;
  let baselineSum = 0;
  let baselineSamples = 0;
  let adaptiveThreshold: number | null = null;

  const tick = () => {
    if (stopped) return;

    analyser.getByteTimeDomainData(buf);

    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / buf.length);

    if (adaptiveThreshold == null && warmedUpFor < warmupMs) {
      warmedUpFor += pollIntervalMs;
      baselineSum += rms;
      baselineSamples += 1;
      setTimeout(tick, pollIntervalMs);
      return;
    }

    if (adaptiveThreshold == null) {
      const baseline = baselineSamples > 0 ? baselineSum / baselineSamples : 0;
      adaptiveThreshold = Math.max(rmsThreshold, baseline * 1.8);
    }

    if (rms < adaptiveThreshold) {
      silentFor += pollIntervalMs;
      if (silentFor >= effectiveSilenceMs) {
        let shouldStop = true;

        try {
          const res = onSilence();
          if (res === false) shouldStop = false;
        } finally {
          if (shouldStop) {
            stop();
            return;
          }
        }

        // Caller decided not to act; keep watching without spamming.
        silentFor = 0;
      }
    } else {
      silentFor = 0;
    }

    setTimeout(tick, pollIntervalMs);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;

    try {
      source.disconnect();
    } catch {}

    try {
      for (const track of stream.getTracks()) track.stop();
    } catch {}

    try {
      void audioContext.close();
    } catch {}
  };

  setTimeout(tick, pollIntervalMs);

  return { stop };
}
