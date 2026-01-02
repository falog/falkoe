import { Typography, Space } from "antd";
import RecordingItem from "./RecordingItem";
import type { Recording, Transcript } from "../types/recording";

type Props = {
  recordings: Recording[];
  transcripts: Record<string, Transcript | null>;
  recognizing: Record<string, boolean>;
  recognizeRecording: (rec: Recording) => void;
  audioUrls: Record<string, string>;
  preferAssetProtocol: boolean;
  toAssetUrl: (p: string) => string;
  ensureBlobAudioUrl: (p: string) => Promise<string | null>;
  addToAnki: (rec: Recording) => void;
  lang: string;
};

export default function RecordingsList({
  recordings,
  transcripts,
  recognizing,
  recognizeRecording,
  audioUrls,
  preferAssetProtocol,
  toAssetUrl,
  ensureBlobAudioUrl,
  addToAnki,
  lang,
}: Props) {
  if (!recordings.length) {
    return (
      <Typography.Text type="secondary">録音はまだありません</Typography.Text>
    );
  }

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      {recordings.map((rec, i) => (
        <RecordingItem
          key={rec.path}
          rec={rec}
          index={i}
          total={recordings.length}
          transcript={transcripts[rec.path]}
          lang={lang}
          recognizing={!!recognizing[rec.path]}
          recognize={recognizeRecording}
          audioUrl={
            audioUrls[rec.path] ??
            (preferAssetProtocol ? toAssetUrl(rec.path) : undefined)
          }
          ensureAudioUrl={(r, opts) => {
            if (!preferAssetProtocol || opts?.forceBlob) {
              void ensureBlobAudioUrl(r.path);
            }
          }}
          addToAnki={addToAnki}
        />
      ))}
    </Space>
  );
}
