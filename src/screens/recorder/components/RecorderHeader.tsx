import { Button, Typography } from "antd";
import HeaderAudioPlayButton from "../HeaderAudioPlayButton";

type Props = {
  headerAudioUrl: string | null;
  isHeaderAudioLoading: boolean;
  displayText: string;
  sentenceText: string;
  onRecognizeModel: () => void;
  waitingModel: boolean;
  modelRecognizeDisabled: boolean;
  sourceKind: string;
};

export function RecorderHeader({
  headerAudioUrl,
  isHeaderAudioLoading,
  displayText,
  sentenceText,
  onRecognizeModel,
  waitingModel,
  modelRecognizeDisabled,
  sourceKind,
}: Props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <HeaderAudioPlayButton
        url={headerAudioUrl}
        loading={isHeaderAudioLoading}
        disabled={!headerAudioUrl || isHeaderAudioLoading}
      />
      <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>
        {displayText || sentenceText}
      </Typography.Title>
      <Button
        onClick={onRecognizeModel}
        loading={waitingModel}
        disabled={modelRecognizeDisabled}
      >
        {sourceKind === "uploaded"
          ? "アップロード音声を音声認識する"
          : "模範音声を音声認識する"}
      </Button>
    </div>
  );
}
