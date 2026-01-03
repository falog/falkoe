import { Button, List, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TopNav from "../components/TopNav";
import type { SpeechSource } from "../types/speech";

type HistoryItem = {
  audioId: string;
  lang: string;
  text: string | null;
  recordingsCount: number;
  lastRecordingTimestamp: string | null;
  lastRecordingWavPath: string | null;
  modelWavPath: string | null;
  uploadedPath: string | null;
};

type Props = {
  onBack: () => void;
  onOpenIpaList: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
  onOpenHistory: () => void;
  onOpenFromHistory: (source: SpeechSource) => void;
};

export default function HistoryScreen({
  onBack,
  onOpenIpaList,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
  onOpenHistory,
  onOpenFromHistory,
}: Props) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);

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
      onOpenFromHistory({
        kind: "uploaded",
        savedPath: it.uploadedPath,
        originalFilename: "uploaded",
        sentenceHash: it.audioId,
        text,
        lang: it.lang,
      });
      return;
    }

    // Otherwise, open as recorded. Prefer model.wav, else the latest recorded take.
    const headerPath = it.modelWavPath ?? it.lastRecordingWavPath;
    if (headerPath) {
      onOpenFromHistory({
        kind: "recorded",
        filePath: headerPath,
        sentenceHash: it.audioId,
        text,
        lang: it.lang,
      });
      return;
    }
  };

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <TopNav
        current="history"
        onBack={onBack}
        onOpenIpaList={onOpenIpaList}
        onOpenDevelopersMistakes={onOpenDevelopersMistakes}
        onOpenCommonMistakes={onOpenCommonMistakes}
        onOpenHistory={onOpenHistory}
      />

      <Typography.Title level={4} style={{ margin: 0 }}>
        録音履歴
      </Typography.Title>

      <List
        loading={loading}
        dataSource={items}
        renderItem={(it) => (
          <List.Item
            actions={[
              <Button
                key="open"
                type="primary"
                onClick={() => openItem(it)}
                disabled={
                  (it.recordingsCount ?? 0) === 0 &&
                  !it.modelWavPath &&
                  !it.lastRecordingWavPath &&
                  !it.uploadedPath
                }
              >
                開く
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={
                <Space wrap>
                  <Typography.Text strong>
                    {it.text?.trim() ? it.text : "(テキスト未保存)"}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    [{it.lang}]
                  </Typography.Text>
                </Space>
              }
              description={
                <Space wrap>
                  <Typography.Text type="secondary">
                    Takes: {it.recordingsCount ?? 0}
                  </Typography.Text>
                  {it.lastRecordingTimestamp && (
                    <Typography.Text type="secondary">
                      Last: {it.lastRecordingTimestamp}
                    </Typography.Text>
                  )}
                </Space>
              }
            />
          </List.Item>
        )}
      />
    </Space>
  );
}
