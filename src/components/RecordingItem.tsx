import { Button, Flex } from "antd";
import { useEffect, useRef } from "react";
import type { Recording, Transcript } from "../types/recording";

type Props = {
  rec: Recording;
  index: number;
  total: number;
  transcript: Transcript | null | undefined;
  recognizing?: boolean;
  recognize?: (rec: Recording) => void;
  audioUrl?: string;
  loadAudio: (path: string) => Promise<void>;
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
  loadAudio,
  addToAnki,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingPlayRef = useRef(false);

  const ensureLoadedForUserPlayback = () => {
    if (audioUrl) return;
    pendingPlayRef.current = true;
    void loadAudio(rec.path);
  };

  // audioUrl がセットされた瞬間に再生
  useEffect(() => {
    if (!audioUrl) return;
    if (!pendingPlayRef.current) return;
    pendingPlayRef.current = false;
    audioRef.current?.play().catch(() => {});
  }, [audioUrl]);

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
        preload="none"
        src={audioUrl}
        style={{ width: "100%" }}
        onPointerDownCapture={() => {
          // WebView2 では <audio controls> の内部UIクリックが onClick に届かないことがある。
          // capture で先に拾って src をロードし、ロード後に play() する。
          ensureLoadedForUserPlayback();
        }}
        onKeyDownCapture={(e) => {
          // キーボード操作での再生（Space/Enter）でも同様にロードしておく
          if (e.key === " " || e.key === "Enter") {
            ensureLoadedForUserPlayback();
          }
        }}
        onError={() => {
          console.error("[RecordingItem] audio error", {
            path: rec.path,
            audioUrl,
            mediaError: audioRef.current?.error,
          });
        }}
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
    </div>
  );
}
