import { Button, Space, Spin, Typography } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useRef, useState } from "react";
import type { RenderLinkingResult, DisplayMode } from "../../../types/linking";
import type { IpaIndex } from "../../../utils/ipaResources";
import LinkingStressArea from "../LinkingStressArea";
import type { ModelStatus } from "../../../types/model";
import type { PitchAnalysis, WordPitch } from "../../../types/pitch";
import { PitchAlignmentChart } from "../../../components/PitchAlignmentChart";

type AccentOut = {
  words: WordPitch[];
};

type Props = {
  isTranscribing: boolean;
  modelText: string | null;
  sentenceHash: string;
  lang: string;
  modelAudioUrl: string | null;
  linkingResult: RenderLinkingResult | null;
  linkingDisplayMode: DisplayMode;
  setLinkingDisplayMode: (mode: DisplayMode) => void;
  ipaIndex: IpaIndex | null;
  status: ModelStatus;
  progress: number | null;
};

export function ModelTranscriptSection({
  isTranscribing,
  modelText,
  sentenceHash,
  lang,
  modelAudioUrl,
  linkingResult,
  linkingDisplayMode,
  setLinkingDisplayMode,
  ipaIndex,
  status,
  progress,
}: Props) {
  const langNorm = (lang ?? "").toLowerCase();
  const isJapanese =
    langNorm === "jpn" || langNorm === "ja" || langNorm.startsWith("ja-");

  const stripWhisperSpecialTokens = (s: string) =>
    s
      .replace(/\[_[^\]]+\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const [pitch, setPitch] = useState<PitchAnalysis | null>(null);
  const [accentWords, setAccentWords] = useState<WordPitch[] | null>(null);
  const [pitchLoading, setPitchLoading] = useState(false);
  const [pitchError, setPitchError] = useState<string | null>(null);
  const pitchRequestedRef = useRef(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadTime, setPlayheadTime] = useState<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastSetRef = useRef<number>(0);

  useEffect(() => {
    pitchRequestedRef.current = false;
    setPitch(null);
    setAccentWords(null);
    setPitchLoading(false);
    setPitchError(null);
    setIsPlaying(false);
    setPlayheadTime(null);
    lastSetRef.current = 0;
  }, [sentenceHash]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const stopRaf = () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };

    const tick = () => {
      const cur = el.currentTime ?? 0;
      if (Math.abs(cur - lastSetRef.current) >= 0.03) {
        lastSetRef.current = cur;
        setPlayheadTime(cur);
      }
      if (!el.paused && !el.ended) {
        rafIdRef.current = requestAnimationFrame(tick);
      } else {
        stopRaf();
      }
    };

    const onPlay = () => {
      setIsPlaying(true);
      stopRaf();
      rafIdRef.current = requestAnimationFrame(tick);
    };
    const onPauseOrEnd = () => {
      setIsPlaying(false);
      stopRaf();
      setPlayheadTime(el.currentTime ?? 0);
    };
    const onSeek = () => {
      lastSetRef.current = el.currentTime ?? 0;
      setPlayheadTime(el.currentTime ?? 0);
    };

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPauseOrEnd);
    el.addEventListener("ended", onPauseOrEnd);
    el.addEventListener("seeked", onSeek);

    return () => {
      stopRaf();
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPauseOrEnd);
      el.removeEventListener("ended", onPauseOrEnd);
      el.removeEventListener("seeked", onSeek);
    };
  }, [modelAudioUrl, pitch]);

  useEffect(() => {
    // Only run after we have a transcript for the model audio.
    if (!modelText?.trim()) return;
    if (pitchRequestedRef.current) return;
    pitchRequestedRef.current = true;

    let cancelled = false;
    (async () => {
      setPitchLoading(true);
      setPitchError(null);
      try {
        const dir = await documentDir();
        const wavPath = await join(
          dir,
          "falkoe",
          "sentences",
          sentenceHash,
          "model",
          "model.wav"
        );

        // Prefer cached pitch analysis if present.
        try {
          const pitchPath = await join(
            dir,
            "falkoe",
            "sentences",
            sentenceHash,
            "model",
            "model.pitch.json"
          );
          const cached = await readTextFile(pitchPath);
          const parsed = JSON.parse(cached) as PitchAnalysis;
          if (!cancelled) setPitch(parsed);

          if (isJapanese) {
            // Prefer accent overlay from model.accent.json if present (Japanese only).
            try {
              const accentPath = await join(
                dir,
                "falkoe",
                "sentences",
                sentenceHash,
                "model",
                "model.accent.json"
              );
              const accentCached = await readTextFile(accentPath);
              const accentParsed = JSON.parse(accentCached) as AccentOut;
              if (!cancelled) setAccentWords(accentParsed.words ?? null);
            } catch {
              // ignore; fall back to pitch.words/segments
            }
          }
          return;
        } catch {
          // ignore; fall back to live analysis
        }

        const res = await invoke<PitchAnalysis>("analyze_pitch", {
          wavPath,
          includeSegments: true,
        });

        if (!cancelled) setPitch(res);

        if (isJapanese) {
          // If available, load accent overlay generated during transcription (Japanese only).
          try {
            const accentPath = await join(
              dir,
              "falkoe",
              "sentences",
              sentenceHash,
              "model",
              "model.accent.json"
            );
            const accentCached = await readTextFile(accentPath);
            const accentParsed = JSON.parse(accentCached) as AccentOut;
            if (!cancelled) setAccentWords(accentParsed.words ?? null);
          } catch {
            // ignore
          }
        }
      } catch (e) {
        if (!cancelled) setPitchError(String(e));
      } finally {
        if (!cancelled) setPitchLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isJapanese, modelText, sentenceHash]);

  return (
    <>
      {isTranscribing && (
        <Space>
          <Spin size="small" />
          <Typography.Text type="secondary">文字起こし中…</Typography.Text>
        </Space>
      )}

      <Typography.Paragraph>
        <strong>Model transcript:</strong>
        <br />
        {modelText ? (
          stripWhisperSpecialTokens(modelText)
        ) : (
          <Typography.Text type="secondary">
            音声認識されていません
          </Typography.Text>
        )}
      </Typography.Paragraph>

      {/* hidden audio element to drive playhead sync */}
      {modelAudioUrl && (
        <audio
          ref={audioRef}
          src={modelAudioUrl}
          preload="metadata"
          style={{ display: "none" }}
        />
      )}

      {modelText && (
        <div style={{ marginTop: 8 }}>
          {pitchLoading && (
            <Space>
              <Spin size="small" />
              <Typography.Text type="secondary">
                模範音声のピッチ解析中…
              </Typography.Text>
            </Space>
          )}

          {!pitchLoading && pitchError && (
            <Typography.Text type="secondary">
              模範音声のピッチ解析に失敗しました: {pitchError}
            </Typography.Text>
          )}

          {!pitchLoading && !pitchError && pitch && (
            <div style={{ marginBottom: 15 }}>
              <Space align="center" size={10} style={{ marginBottom: 4 }}>
                <Typography.Text type="secondary">
                  Pitch extractor: {pitch.extractor ?? "(unknown)"}
                </Typography.Text>
                <Button
                  size="small"
                  disabled={!modelAudioUrl}
                  onClick={async () => {
                    const el = audioRef.current;
                    if (!el) return;
                    if (el.paused || el.ended) {
                      try {
                        await el.play();
                      } catch {
                        // ignore
                      }
                    } else {
                      el.pause();
                    }
                  }}
                >
                  {isPlaying ? "停止" : "再生"}
                </Button>
              </Space>
              <PitchAlignmentChart
                analysis={pitch}
                words={isJapanese ? accentWords : undefined}
                showLabels={isJapanese}
                playheadTime={playheadTime}
              />
            </div>
          )}
        </div>
      )}

      {linkingResult?.joined && (
        <LinkingStressArea
          linkingResult={linkingResult}
          linkingDisplayMode={linkingDisplayMode}
          setLinkingDisplayMode={setLinkingDisplayMode}
          ipaIndex={ipaIndex}
        />
      )}

      <Typography.Text type="secondary">Model status: {status}</Typography.Text>

      {status === "downloading" && (
        <Typography.Text type="secondary">
          Downloading model… {progress ?? 0}%
        </Typography.Text>
      )}
    </>
  );
}
