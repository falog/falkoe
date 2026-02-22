import { message } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  startMicRecorderSilenceWatcher,
  type MicRecorderSilenceWatcher,
} from "./micRecorderSilenceWatcher";
import { useTranslation } from "react-i18next";
import { playAudioUrl } from "./uiUtils";

type ShadowingStartOptions = {
  mode?: "manual" | "mimic";
};

type UseShadowingRecorderArgs = {
  isRecording: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
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
  headerAudioUrl,
  isHeaderAudioLoading,
}: UseShadowingRecorderArgs): UseShadowingRecorderResult {
  const { t } = useTranslation();
  const isRecordingRef = useRef(isRecording);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  const autoPracticeInFlightRef = useRef(false);
  const [isMimicLoading, setIsMimicLoading] = useState(false);
  const [autoStopRemainingMs, setAutoStopRemainingMs] = useState<number | null>(
    null,
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
      rmsThreshold: 0.008,
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
            `${t("screens.recorder.messages.silenceWatcherUnavailable")}${msg}`,
          );
        }
        return null;
      });
  }, [stopRecording, t]);

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
          message.info(t("screens.recorder.messages.audioLoading"));
          return;
        }
        if (isRecording) return;

        // Important: start sample playback BEFORE awaiting anything.
        // Awaiting here can break the user-gesture chain and cause audio.play() to be blocked.
        // Shadowing UX: while the sample is playing, the user might be silent (listening).
        // If we start silence detection immediately, it can auto-stop during playback.
        // So we start the auto-stop watcher only AFTER the sample finishes (or fails).
        // Use shared playback helper (Android: WebAudio bytes path).
        void playAudioUrl(headerAudioUrl).catch((e) => {
          console.warn("Mimic sample playback blocked/failed", e);
        });

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
      t,
    ],
  );

  return {
    isRecording,
    autoStopRemainingMs,
    isMimicLoading,
    start,
    stop,
  };
}
