import { Button, Flex, Typography, Spin, Space } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Recording, Transcript } from "../types/recording";
import type { PitchAnalysis, WordPitch } from "../types/pitch";
import { PitchAlignmentChart } from "./PitchAlignmentChart";

type AccentOut = {
  words: WordPitch[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitForAccentWords = async (path: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const txt = await readTextFile(path);
      const parsed = JSON.parse(txt) as AccentOut;
      return parsed.words ?? null;
    } catch {
      await sleep(300);
    }
  }
  return null;
};

type Props = {
  rec: Recording;
  index: number;
  total: number;
  transcript: Transcript | null | undefined;
  lang: string;
  recognizing?: boolean;
  recognize?: (rec: Recording) => void;
  audioUrl?: string;
  ensureAudioUrl?: (rec: Recording, opts?: { forceBlob?: boolean }) => void;
  addToAnki: (rec: Recording) => void;
};

export default function RecordingItem({
  rec,
  index,
  total,
  transcript,
  lang,
  recognizing,
  recognize,
  audioUrl,
  ensureAudioUrl,
  addToAnki,
}: Props) {
  const langNorm = (lang ?? "").toLowerCase();
  const isJapanese =
    langNorm === "jpn" || langNorm === "ja" || langNorm.startsWith("ja-");

  const stripWhisperSpecialTokens = (s: string) =>
    s
      .replace(/\[_[^\]]+\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [pitch, setPitch] = useState<PitchAnalysis | null>(null);
  const [accentWords, setAccentWords] = useState<WordPitch[] | null>(null);
  const [accentError, setAccentError] = useState<string | null>(null);
  const [pitchLoading, setPitchLoading] = useState(false);
  const [pitchError, setPitchError] = useState<string | null>(null);
  const pitchRequestedRef = useRef(false);

  const [playheadTime, setPlayheadTime] = useState<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastSetRef = useRef<number>(0);

  const handleRecognizeClick = () => {
    recognize?.(rec);
  };

  const handleAnkiClick = () => {
    addToAnki(rec);
  };

  const handleAudioPointerDownCapture = () => {
    if (audioUrl) return;
    ensureAudioUrl?.(rec);
  };

  useEffect(() => {
    pitchRequestedRef.current = false;
    setPitch(null);
    setAccentWords(null);
    setAccentError(null);
    setPitchLoading(false);
    setPitchError(null);
  }, [rec.path]);

  const ensurePitch = useCallback(async () => {
    if (pitchRequestedRef.current) return;
    pitchRequestedRef.current = true;

    setPitchLoading(true);
    setPitchError(null);
    try {
      // Prefer cached pitch analysis (generated during JP Whisper) if present.
      try {
        const pitchPath = rec.path.replace(/\.wav$/i, ".pitch.json");
        const cached = await readTextFile(pitchPath);
        const parsed = JSON.parse(cached) as PitchAnalysis;
        setPitch(parsed);

        if (isJapanese) {
          // Prefer accent overlay generated during transcription (Japanese only).
          try {
            const accentPath = rec.path.replace(/\.wav$/i, ".accent.json");
            const words = await waitForAccentWords(accentPath, 60000);
            setAccentWords(words);
            setAccentError(
              words === null
                ? `アクセント情報 (${accentPath.split(/[\\/]/).pop() ?? "accent.json"}) を1分待ちましたが読み込めませんでした。`
                : null,
            );
          } catch {
            // ignore; fall back to pitch.words/segments
          }
        }
        return;
      } catch {
        // ignore; fall back to live analysis
      }

      const res = await invoke<PitchAnalysis>("analyze_pitch", {
        wavPath: rec.path,
        includeSegments: true,
      });
      setPitch(res);

      if (isJapanese) {
        // If available, load accent overlay generated during transcription (Japanese only).
        try {
          const accentPath = rec.path.replace(/\.wav$/i, ".accent.json");
          const words = await waitForAccentWords(accentPath, 60000);
          setAccentWords(words);
          setAccentError(
            words === null
              ? `アクセント情報 (${accentPath.split(/[\\/]/).pop() ?? "accent.json"}) を1分待ちましたが読み込めませんでした。`
              : null,
          );
        } catch {
          // ignore
        }
      }
    } catch (e) {
      setPitchError(String(e));
    } finally {
      setPitchLoading(false);
    }
  }, [isJapanese, rec.path]);

  // Run pitch analysis as soon as a transcript exists so users don't need to play back first.
  useEffect(() => {
    if (!transcript) return;
    if (!transcript.segments?.length) return;
    void ensurePitch();
  }, [ensurePitch, transcript]);

  const handleAudioError = () => {
    console.error("[RecordingItem] audio error", {
      path: rec.path,
      audioUrl,
      mediaError: audioRef.current?.error,
    });

    // asset protocol 等が失敗した場合は Blob にフォールバックする
    ensureAudioUrl?.(rec, { forceBlob: true });
  };

  useEffect(() => {
    setPlayheadTime(null);
    lastSetRef.current = 0;

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
      // Throttle state updates to reduce render cost.
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
      stopRaf();
      rafIdRef.current = requestAnimationFrame(tick);
    };
    const onPauseOrEnd = () => {
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
  }, [rec.path, audioUrl]);

  return (
    <div>
      <Flex align="center" justify="space-between">
        <div>
          <strong>Take {total - index}</strong>
          {rec.dateLabel ? <> / {rec.dateLabel}</> : null}
        </div>
        <Flex gap={8}>
          {transcript === null && recognize && (
            <Button
              loading={!!recognizing}
              disabled={!!recognizing}
              onClick={handleRecognizeClick}
            >
              音声認識
            </Button>
          )}
          <Button onClick={handleAnkiClick}>Ankiに追加</Button>
        </Flex>
      </Flex>

      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={audioUrl}
        style={{ width: "100%" }}
        onPointerDownCapture={handleAudioPointerDownCapture}
        onError={handleAudioError}
      />

      {transcript && transcript.segments.length > 0 && (
        <div style={{ fontSize: 14, marginTop: 4 }}>
          {transcript.segments.map((s, i) => (
            <div key={i}>{stripWhisperSpecialTokens(s.text)}</div>
          ))}
        </div>
      )}

      {transcript && (
        <div style={{ marginTop: 8 }}>
          {pitchLoading && (
            <Space>
              <Spin size="small" />
              <Typography.Text type="secondary">ピッチ解析中…</Typography.Text>
            </Space>
          )}

          {!pitchLoading && pitchError && (
            <Typography.Text type="secondary">
              ピッチ解析に失敗しました: {pitchError}
            </Typography.Text>
          )}

          {!pitchLoading && !pitchError && pitch && (
            <>
              {isJapanese && accentError && (
                <div style={{ marginBottom: 6 }}>
                  <Typography.Text type="warning">
                    {accentError}
                  </Typography.Text>
                </div>
              )}
              <PitchAlignmentChart
                analysis={pitch}
                words={isJapanese ? (accentWords ?? undefined) : undefined}
                showLabels={isJapanese}
                playheadTime={playheadTime}
              />
            </>
          )}
        </div>
      )}

      {!transcript && recognizing && (
        <Space style={{ marginLeft: 8 }}>
          <Spin size="small" />
          <Typography.Text type="secondary">文字起こし中…</Typography.Text>
        </Space>
      )}

      {transcript?.segments?.length === 0 && (
        <div style={{ fontSize: 12, color: "#888" }}>
          （音声が検出されませんでした）
        </div>
      )}
    </div>
  );
}
