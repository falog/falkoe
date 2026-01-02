import { Button, Flex, Typography, Spin, Space } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Recording, Transcript } from "../types/recording";
import type { PitchAnalysis } from "../types/pitch";
import { PitchAlignmentChart } from "./PitchAlignmentChart";

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
  const enablePitchAccent =
    langNorm === "jpn" || langNorm === "ja" || langNorm.startsWith("ja-");
  const audioRef = useRef<HTMLAudioElement>(null);
  const [pitch, setPitch] = useState<PitchAnalysis | null>(null);
  const [pitchLoading, setPitchLoading] = useState(false);
  const [pitchError, setPitchError] = useState<string | null>(null);
  const pitchRequestedRef = useRef(false);

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

  const ensurePitch = useCallback(async () => {
    if (!enablePitchAccent) return;
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
        return;
      } catch {
        // ignore; fall back to live analysis
      }

      const res = await invoke<PitchAnalysis>("analyze_pitch", {
        wavPath: rec.path,
        includeSegments: true,
      });
      setPitch(res);
    } catch (e) {
      setPitchError(String(e));
    } finally {
      setPitchLoading(false);
    }
  }, [enablePitchAccent, rec.path]);

  // Run pitch analysis as soon as a transcript exists so users don't need to play back first.
  useEffect(() => {
    if (!transcript) return;
    if (!transcript.segments?.length) return;
    if (!enablePitchAccent) return;
    void ensurePitch();
  }, [enablePitchAccent, ensurePitch, transcript]);

  const handleAudioError = () => {
    console.error("[RecordingItem] audio error", {
      path: rec.path,
      audioUrl,
      mediaError: audioRef.current?.error,
    });

    // asset protocol 等が失敗した場合は Blob にフォールバックする
    ensureAudioUrl?.(rec, { forceBlob: true });
  };

  return (
    <div>
      <Flex align="center" justify="space-between">
        <div>
          <strong>Take {total - index}</strong>
          {rec.dateLabel ? <> / {rec.dateLabel}</> : null}
        </div>
        <Flex gap={8}>
          {transcript === null && recognize && !recognizing && (
            <Button loading={!!recognizing} onClick={handleRecognizeClick}>
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
            <div key={i}>{s.text.trim()}</div>
          ))}
        </div>
      )}

      {transcript && enablePitchAccent && (
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
            <PitchAlignmentChart analysis={pitch} />
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
