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
  const autoStopArmedRef = useRef(false);
  const silenceWatcherRef = useRef<MicRecorderSilenceWatcher | null>(null);
  const silenceUnavailableNotifiedRef = useRef(false);

  const startAutoStopWatcher = useCallback(() => {
    if (!isRecordingRef.current) {
      return Promise.resolve(null);
    }
    autoStopArmedRef.current = true;
    silenceWatcherRef.current?.stop();
    silenceWatcherRef.current = null;

    return startMicRecorderSilenceWatcher({
      silenceMs: 3000,
      rmsThreshold: 0.006,
      pollIntervalMs: 50,
      onSilence: () => {
        if (!autoStopArmedRef.current) return false;
        if (!isRecordingRef.current) return false;
        void stopRecording();
        return true;
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
    silenceWatcherRef.current?.stop();
    silenceWatcherRef.current = null;
  }, [isRecording]);

  const stop = useCallback(async () => {
    try {
      await stopRecording();
    } finally {
      isRecordingRef.current = false;
      autoStopArmedRef.current = false;
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

        await startRecording();
        isRecordingRef.current = true;
        await startAutoStopWatcher();
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
    isMimicLoading,
    start,
    stop,
  };
}
