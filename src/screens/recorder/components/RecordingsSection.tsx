import { Typography } from "antd";
import type { Recording, Transcript } from "../../../types/recording";
import RecordingsList from "../../../components/RecordingsList";

type Props = {
  recordings: Recording[];
  transcripts: Record<string, Transcript | null>;
  recognizing: Record<string, boolean>;
  recognizeRecording: (rec: Recording) => void;
  audioUrls: Record<string, string>;
  preferAssetProtocol: boolean;
  toAssetUrl: (path: string) => string;
  ensureBlobAudioUrl: (
    path: string,
    opts?: { forceReload?: boolean }
  ) => Promise<string | null>;
  addToAnki: (rec: Recording) => Promise<void>;
  lang: string;
};

export function RecordingsSection({
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
  return (
    <>
      <Typography.Title level={5}>Recordings</Typography.Title>
      <RecordingsList
        recordings={recordings}
        transcripts={transcripts}
        recognizing={recognizing}
        recognizeRecording={recognizeRecording}
        audioUrls={audioUrls}
        preferAssetProtocol={preferAssetProtocol}
        toAssetUrl={toAssetUrl}
        ensureBlobAudioUrl={ensureBlobAudioUrl}
        addToAnki={addToAnki}
        lang={lang}
      />
    </>
  );
}
