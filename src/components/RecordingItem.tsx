import { Button, Flex } from "antd";
import { useEffect, useRef } from "react";
import type { Recording, Transcript } from "../types/recording";

type Props = {
  rec: Recording;
  index: number;
  total: number;
  transcript: Transcript | null | undefined;
  audioUrl?: string;
  loadAudio: (path: string) => Promise<void>;
  addToAnki: (rec: Recording) => void;
};

export default function RecordingItem({
  rec,
  index,
  total,
  transcript,
  audioUrl,
  loadAudio,
  addToAnki,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);

  // audioUrl がセットされた瞬間に再生
  useEffect(() => {
    if (audioUrl) {
      audioRef.current?.play().catch(() => {});
    }
  }, [audioUrl]);

  return (
    <div>
      <Flex align="center" justify="space-between">
        <div>
          <strong>Take {total - index}</strong> / {rec.dateLabel}
        </div>
        <Button onClick={() => addToAnki(rec)}>Ankiに追加</Button>
      </Flex>

      <audio
        ref={audioRef}
        controls
        preload="none"
        src={audioUrl}
        style={{ width: "100%" }}
        onClick={() => {
          if (!audioUrl) {
            loadAudio(rec.path);
          }
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

      {transcript === null && (
        <div style={{ fontSize: 12, color: "#888" }}>（文字起こし中…）</div>
      )}
    </div>
  );
}
