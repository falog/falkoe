import { Button, Space, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { openExternalUrl } from "../utils/openExternalUrl";
import { formatTatoebaCreditText } from "../utils/formatTatoebaCreditText";

export type SentenceAttribution = {
  provider: "tatoeba";
  sentenceLicense: string;
  sentenceOwner?: string | null;
  sentenceUrl: string;
  audioLicense: string;
  audioAuthor?: string | null;
  audioAttributionUrl?: string | null;
  audioId?: number | null;
};

export type Sentence = {
  id: number;
  text: string;
  translation?: string | null;
  audioUrl: string;
  lang: string;
  attribution?: SentenceAttribution;
};

type ExampleListProps = {
  sentences: Sentence[];
  onSelect: (sentence: Sentence) => void;
  onRecord?: (s: Sentence) => void;
  disabled?: boolean;
};

const ExampleList = ({ sentences, onSelect, disabled }: ExampleListProps) => {
  const { t } = useTranslation();
  const openLink = (url: string) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void openExternalUrl(url);
  };

  const playAudio = (url: string) => {
    const audio = new Audio(url);
    audio.play();
  };

  if (!sentences || sentences.length === 0) {
    return (
      <Typography.Text type="secondary" disabled={disabled}>
        {t("components.exampleList.noResults")}
      </Typography.Text>
    );
  }

  return (
    <div
      style={{
        border: "1px solid var(--ant-color-border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {sentences.map((item, idx) => (
        <div key={`example-${item.id}`}>
          <div
            style={{
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
              <Typography.Text disabled={disabled} style={{ display: "block" }}>
                {item.text}
              </Typography.Text>
              {item.attribution?.provider === "tatoeba" ? (
                <Typography.Text
                  type="secondary"
                  disabled={disabled}
                  style={{ display: "block", marginTop: 4 }}
                >
                  {formatTatoebaCreditText(item.attribution, t)}
                  {item.attribution.sentenceUrl ? (
                    <>
                      {" "}
                      <Typography.Link
                        href={item.attribution.sentenceUrl}
                        target="_blank"
                        rel="noreferrer"
                        disabled={disabled}
                        onClick={openLink(item.attribution.sentenceUrl)}
                      >
                        {t("tatoeba.source")}
                      </Typography.Link>
                    </>
                  ) : null}
                  {item.attribution.audioAttributionUrl ? (
                    <>
                      {" "}
                      <Typography.Link
                        href={item.attribution.audioAttributionUrl}
                        target="_blank"
                        rel="noreferrer"
                        disabled={disabled}
                        onClick={openLink(item.attribution.audioAttributionUrl)}
                      >
                        {t("tatoeba.audioCredit")}
                      </Typography.Link>
                    </>
                  ) : null}
                </Typography.Text>
              ) : null}
              {item.translation ? (
                <Typography.Text
                  type="secondary"
                  disabled={disabled}
                  style={{ display: "block", marginTop: 4 }}
                >
                  {item.translation}
                </Typography.Text>
              ) : null}
            </div>

            <Space size={8} style={{ flex: "0 0 auto" }}>
              <Button
                key="play"
                icon={<PlayCircleOutlined />}
                disabled={disabled}
                onClick={() => playAudio(item.audioUrl)}
              />
              <Button
                key="select"
                type="primary"
                size="small"
                disabled={disabled}
                onClick={() => onSelect(item)}
              >
                {t("components.exampleList.practiceWithSentence")}
              </Button>
            </Space>
          </div>

          {idx < sentences.length - 1 && (
            <div style={{ borderTop: "1px solid var(--ant-color-split)" }} />
          )}
        </div>
      ))}
    </div>
  );
};

export default ExampleList;
