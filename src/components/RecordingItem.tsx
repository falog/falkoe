import { Button, Flex } from "antd";
import { useRef } from "react";
import type { Recording, Transcript } from "../types/recording";

type Props = {
  rec: Recording;
  index: number;
  total: number;
  transcript: Transcript | null | undefined;
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
  recognizing,
  recognize,
  audioUrl,
  ensureAudioUrl,
  addToAnki,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);

  return (
    <div>
      <Flex align="center" justify="space-between">
        <div>
          <strong>Take {total - index}</strong> / {rec.dateLabel}
        </div>
        <Flex gap={8}>
          {transcript === null && recognize && !recognizing && (
            <Button loading={!!recognizing} onClick={() => recognize(rec)}>
              音声認識
            </Button>
          )}
          <Button
            onClick={() => {
              console.log("[RecordingItem] Anki clicked", rec);
              addToAnki(rec);
            }}
          >
            Ankiに追加
          </Button>
        </Flex>
      </Flex>

      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={audioUrl}
        style={{ width: "100%" }}
        onPointerDownCapture={() => {
          if (audioUrl) return;
          ensureAudioUrl?.(rec);
        }}
        onError={() => {
          console.error("[RecordingItem] audio error", {
            path: rec.path,
            audioUrl,
            mediaError: audioRef.current?.error,
          });

          // asset protocol 等が失敗した場合は Blob にフォールバックする
          ensureAudioUrl?.(rec, { forceBlob: true });
        }}
      />

      {transcript && transcript.segments.length > 0 && (
        <div style={{ fontSize: 14, marginTop: 4 }}>
          {transcript.segments.map((s, i) => (
            <div key={i}>{s.text.trim()}</div>
          ))}
        </div>
      )}

      {transcript?.segments?.length === 0 && (
        <div style={{ fontSize: 12, color: "#888" }}>
          （音声が検出されませんでした）
        </div>
      )}
    </div>
  );
}
