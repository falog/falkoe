import { Button, Typography } from "antd";
import { useTranslation } from "react-i18next";
import HeaderAudioPlayButton from "../HeaderAudioPlayButton";

type Props = {
  headerAudioUrl: string | null;
  isHeaderAudioLoading: boolean;
  displayText: string;
  sentenceText: string;
  onRecognizeModel: () => void;
  waitingModel: boolean;
  autoRecognizingUploaded: boolean;
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
  autoRecognizingUploaded,
  modelRecognizeDisabled,
  sourceKind,
}: Props) {
  const { t } = useTranslation();

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
        loading={waitingModel || autoRecognizingUploaded}
        disabled={modelRecognizeDisabled || autoRecognizingUploaded}
      >
        {sourceKind === "uploaded"
          ? t("screens.recorder.header.recognizeUploaded")
          : t("screens.recorder.header.recognizeModel")}
      </Button>
    </div>
  );
}
