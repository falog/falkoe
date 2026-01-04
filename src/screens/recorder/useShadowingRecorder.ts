import { message } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  startMicRecorderSilenceWatcher,
  type MicRecorderSilenceWatcher,
} from "./micRecorderSilenceWatcher";
import type { ModelStatus } from "../../types/model";

type ShadowingStartOptions = {
  mode?: "manual" | "mimic";
};

type UseShadowingRecorderArgs = {
  isRecording: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  status: ModelStatus;
  headerAudioUrl: string | null;
  isHeaderAudioLoading: boolean;
};

type UseShadowingRecorderResult = {
  isRecording: boolean;
  isMimicLoading: boolean;
  autoStopRemainingMs: number | null;
  start: (options?: ShadowingStartOptions) => Promise<void>;
  stop: () => Promise<void>;
};

export function useShadowingRecorder({
  isRecording,
  startRecording,
  stopRecording,
  status,
  headerAudioUrl,
  isHeaderAudioLoading,
}: UseShadowingRecorderArgs): UseShadowingRecorderResult {
  const isRecordingRef = useRef(isRecording);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  const autoPracticeInFlightRef = useRef(false);
  const [isMimicLoading, setIsMimicLoading] = useState(false);
  const [autoStopRemainingMs, setAutoStopRemainingMs] = useState<number | null>(
    null
  );
  const lastSilenceEndTimeRef = useRef<number>(0);
  const autoStopArmedRef = useRef(false);
  const silenceWatcherRef = useRef<MicRecorderSilenceWatcher | null>(null);
  const silenceUnavailableNotifiedRef = useRef(false);

  const startAutoStopWatcher = useCallback(() => {
    autoStopArmedRef.current = true;
    silenceWatcherRef.current?.stop();
    silenceWatcherRef.current = null;

    return startMicRecorderSilenceWatcher({
      silenceMs: 3000,
      rmsThreshold: 0.03,
      pollIntervalMs: 50,
      onSilence: () => {
        if (!autoStopArmedRef.current) return false;
        if (!isRecordingRef.current) return false;
        void stopRecording();
        return true;
      },
      onProgress: (remainingMs) => {
        if (!autoStopArmedRef.current) return;
        if (!isRecordingRef.current) return;
        // 音声終了時刻より後の更新のみ反映（古い更新は無視）
        if (Date.now() > lastSilenceEndTimeRef.current + 100) {
          setAutoStopRemainingMs(remainingMs);
        }
      },
      onSilenceEnd: () => {
        if (!autoStopArmedRef.current) return;
        if (!isRecordingRef.current) return;
        lastSilenceEndTimeRef.current = Date.now();
        setAutoStopRemainingMs(null);
      },
    })
      .then((watcher) => {
        silenceWatcherRef.current = watcher;
        return watcher;
      })
      .catch((e) => {
        console.warn("silence watcher unavailable", e);
        if (!silenceUnavailableNotifiedRef.current) {
          silenceUnavailableNotifiedRef.current = true;
          const msg = String((e as any)?.message ?? e);
          message.info(
            "無音検知を開始できません（デバイス競合の可能性）: " + msg
          );
        }
        return null;
      });
  }, [stopRecording]);

  useEffect(() => {
    return () => {
      silenceWatcherRef.current?.stop();
      silenceWatcherRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (isRecording) return;
    autoStopArmedRef.current = false;
    setAutoStopRemainingMs(null);
    silenceWatcherRef.current?.stop();
    silenceWatcherRef.current = null;
  }, [isRecording]);

  const stop = useCallback(async () => {
    try {
      await stopRecording();
    } finally {
      isRecordingRef.current = false;
      autoStopArmedRef.current = false;
      setAutoStopRemainingMs(null);
      silenceWatcherRef.current?.stop();
      silenceWatcherRef.current = null;
    }
  }, [stopRecording]);

  const start = useCallback(
    async (options?: ShadowingStartOptions) => {
      const mode = options?.mode ?? "manual";

      if (mode === "manual") {
        if (isRecording) return;
        if (status !== "ready") {
          message.info("モデル準備中のため録音を開始できません");
          return;
        }

        // Start the silence watcher BEFORE awaiting anything.
        // This helps keep initialization inside the user gesture.
        const watcherPromise = startAutoStopWatcher();

        try {
          await startRecording();
          isRecordingRef.current = true;
          await watcherPromise;
        } catch (e) {
          autoStopArmedRef.current = false;
          silenceWatcherRef.current?.stop();
          silenceWatcherRef.current = null;
          throw e;
        }
        return;
      }

      // mimic
      if (autoPracticeInFlightRef.current) return;
      autoPracticeInFlightRef.current = true;
      setIsMimicLoading(true);

      try {
        if (!headerAudioUrl || isHeaderAudioLoading) {
          message.info("音声を読み込み中…");
          return;
        }
        if (status !== "ready") {
          message.info("モデル準備中のため録音を開始できません");
          return;
        }
        if (isRecording) return;

        // Important: start sample playback BEFORE awaiting anything.
        // Awaiting here can break the user-gesture chain and cause audio.play() to be blocked.
        const audio = new Audio(headerAudioUrl);

        // Shadowing UX: while the sample is playing, the user might be silent (listening).
        // If we start silence detection immediately, it can auto-stop during playback.
        // So we start the auto-stop watcher only AFTER the sample finishes (or fails).
        const startWatcherAfterPlayback = () => {
          if (!isRecordingRef.current) return;
          if (!autoStopArmedRef.current) return;
          void startAutoStopWatcher();
        };

        audio.addEventListener("ended", startWatcherAfterPlayback, {
          once: true,
        });
        audio.addEventListener("error", startWatcherAfterPlayback, {
          once: true,
        });

        try {
          void audio.play().catch((e) => {
            console.warn("Mimic sample playback blocked/failed", e);
            startWatcherAfterPlayback();
          });
        } catch (e) {
          console.warn("Mimic sample playback failed", e);
          startWatcherAfterPlayback();
        }

        try {
          await startRecording();
          isRecordingRef.current = true;
          autoStopArmedRef.current = true;
        } catch (e) {
          autoStopArmedRef.current = false;
          const watcher =
            silenceWatcherRef.current as unknown as MicRecorderSilenceWatcher | null;
          watcher?.stop();
          silenceWatcherRef.current = null;
          throw e;
        }
      } finally {
        setIsMimicLoading(false);
        autoPracticeInFlightRef.current = false;
      }
    },
    [
      autoStopArmedRef,
      headerAudioUrl,
      isHeaderAudioLoading,
      isRecording,
      startAutoStopWatcher,
      startRecording,
      status,
    ]
  );

  return {
    isRecording,
    autoStopRemainingMs,
    isMimicLoading,
    start,
    stop,
  };
}
