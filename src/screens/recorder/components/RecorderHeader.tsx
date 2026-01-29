import { Button, Typography } from "antd";
import { useTranslation } from "react-i18next";
import type { MouseEvent } from "react";
import HeaderAudioPlayButton from "../HeaderAudioPlayButton";
import type { SentenceAttribution } from "../../../components/ExampleList";
import { openExternalUrl } from "../../../utils/openExternalUrl";
import { formatTatoebaCreditText } from "../../../utils/formatTatoebaCreditText";

type Props = {
  headerAudioUrl: string | null;
  isHeaderAudioLoading: boolean;
  displayText: string;
  sentenceText: string;
  sentenceAttribution?: SentenceAttribution;
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
  sentenceAttribution,
  onRecognizeModel,
  waitingModel,
  autoRecognizingUploaded,
  modelRecognizeDisabled,
  sourceKind,
}: Props) {
  const { t } = useTranslation();

  const showTatoebaCredit = sentenceAttribution?.provider === "tatoeba";

  const openLink = (url: string) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void openExternalUrl(url);
  };

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
      <div style={{ flex: 1, minWidth: 0 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {displayText || sentenceText}
        </Typography.Title>
        {showTatoebaCredit ? (
          <Typography.Text type="secondary" style={{ display: "block" }}>
            {sentenceAttribution
              ? formatTatoebaCreditText(sentenceAttribution, t)
              : ""}
            {sentenceAttribution?.sentenceUrl ? (
              <>
                {" "}
                <Typography.Link
                  href={sentenceAttribution.sentenceUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={openLink(sentenceAttribution.sentenceUrl)}
                >
                  {t("tatoeba.source")}
                </Typography.Link>
              </>
            ) : null}
            {sentenceAttribution?.audioAttributionUrl ? (
              <>
                {" "}
                <Typography.Link
                  href={sentenceAttribution.audioAttributionUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={openLink(sentenceAttribution.audioAttributionUrl)}
                >
                  {t("tatoeba.audioCredit")}
                </Typography.Link>
              </>
            ) : null}
          </Typography.Text>
        ) : null}
      </div>
      <Button
        onClick={onRecognizeModel}
        loading={waitingModel || autoRecognizingUploaded}
        disabled={
          modelRecognizeDisabled || autoRecognizingUploaded || waitingModel
        }
      >
        {sourceKind === "uploaded"
          ? t("screens.recorder.header.recognizeUploaded")
          : t("screens.recorder.header.recognizeModel")}
      </Button>
    </div>
  );
}
