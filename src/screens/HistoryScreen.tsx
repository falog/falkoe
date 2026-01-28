import { Button, Card, Empty, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import TopNav from "../components/TopNav";
import type { SpeechSource } from "../types/speech";
import type { SentenceAttribution } from "../components/ExampleList";

type HistoryItem = {
  audioId: string;
  lang: string;
  text: string | null;
  attribution: SentenceAttribution | null;
  recordingsCount: number;
  lastRecordingTimestamp: string | null;
  lastRecordingWavPath: string | null;
  modelWavPath: string | null;
  tatoebaMp3Path: string | null;
  uploadedPath: string | null;
  uploadedOriginalFilename: string | null;
};

type Props = {
  onBack: () => void;
  onOpenIpaList: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  onOpenFromHistory: (source: SpeechSource) => void;
};

export default function HistoryScreen({
  onBack,
  onOpenIpaList,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
  onOpenHistory,
  onOpenSettings,
  onOpenFromHistory,
}: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);

  const basename = (p: string): string => {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? p;
  };

  const displayFilename = (it: HistoryItem): string | null => {
    if (it.uploadedOriginalFilename?.trim()) return it.uploadedOriginalFilename;
    if (it.uploadedPath) return basename(it.uploadedPath);
    const headerPath =
      it.tatoebaMp3Path ?? it.modelWavPath ?? it.lastRecordingWavPath;
    if (headerPath) return basename(headerPath);
    return null;
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    invoke<HistoryItem[]>("list_sentence_history")
      .then((res) => {
        if (!cancelled) setItems(res);
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openItem = (it: HistoryItem) => {
    const text = it.text ?? "";

    // Prefer opening as uploaded if we have a persisted uploaded file.
    if (it.uploadedPath) {
      const originalFilename =
        it.uploadedOriginalFilename?.trim() || basename(it.uploadedPath);
      onOpenFromHistory({
        kind: "uploaded",
        savedPath: it.uploadedPath,
        originalFilename,
        sentenceHash: it.audioId,
        text,
        attribution: it.attribution ?? undefined,
        lang: it.lang,
      });
      return;
    }

    // Otherwise, open as recorded. Prefer model.wav, else the latest recorded take.
    const headerPath =
      it.tatoebaMp3Path ?? it.modelWavPath ?? it.lastRecordingWavPath;
    if (headerPath) {
      onOpenFromHistory({
        kind: "recorded",
        filePath: headerPath,
        sentenceHash: it.audioId,
        text,
        attribution: it.attribution ?? undefined,
        lang: it.lang,
      });
      return;
    }
  };

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <TopNav
        current="history"
        onBack={onBack}
        onOpenIpaList={onOpenIpaList}
        onOpenDevelopersMistakes={onOpenDevelopersMistakes}
        onOpenCommonMistakes={onOpenCommonMistakes}
        onOpenHistory={onOpenHistory}
        onOpenSettings={onOpenSettings}
      />

      <Typography.Title level={4} style={{ margin: 0 }}>
        {t("screens.history.title")}
      </Typography.Title>

      {loading && items.length === 0 && (
        <Typography.Text type="secondary">
          {t("screens.history.loading")}
        </Typography.Text>
      )}

      {!loading && items.length === 0 && (
        <Empty description={t("screens.history.empty")} />
      )}

      <Space orientation="vertical" style={{ width: "100%" }}>
        {items.map((it) => (
          <Card
            key={it.audioId}
            size="small"
            title={
              <Space wrap>
                <Typography.Text strong>
                  {it.text?.trim()
                    ? it.text
                    : `${t("screens.history.textNotSaved")} ${displayFilename(it) ?? it.audioId}`}
                </Typography.Text>
                <Typography.Text type="secondary">[{it.lang}]</Typography.Text>
              </Space>
            }
            extra={
              <Button
                type="primary"
                onClick={() => openItem(it)}
                disabled={
                  (it.recordingsCount ?? 0) === 0 &&
                  !it.tatoebaMp3Path &&
                  !it.modelWavPath &&
                  !it.lastRecordingWavPath &&
                  !it.uploadedPath
                }
              >
                {t("screens.history.open")}
              </Button>
            }
          >
            <Space wrap>
              <Typography.Text type="secondary">
                {t("screens.history.takes")}
                {it.recordingsCount ?? 0}
              </Typography.Text>
              {it.lastRecordingTimestamp && (
                <Typography.Text type="secondary">
                  {t("screens.history.last")}
                  {it.lastRecordingTimestamp}
                </Typography.Text>
              )}
            </Space>
          </Card>
        ))}
      </Space>
    </Space>
  );
}
