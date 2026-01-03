import { Button, message, Space, Spin, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { loadIpaIndex, type IpaIndex } from "../utils/ipaResources";
import {
  playBundledAudio,
  unlockAudioFromUserGesture,
} from "../utils/ipaPlayer";
import {
  COMMON_PITFALLS,
  sampleResourceCandidates,
  type SampleSpeaker,
} from "../data/commonMistakes";
import TopNav from "../components/TopNav";

type Props = {
  onBack: () => void;
  onOpenIpaList: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

export default function CommonMistakesScreen({
  onBack,
  onOpenIpaList,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: Props) {
  const [ipaIndex, setIpaIndex] = useState<IpaIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const unlockTriedRef = useRef(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    loadIpaIndex()
      .then((idx) => setIpaIndex(idx))
      .catch((e) => {
        setIpaIndex(null);
        setError(String((e as any)?.message ?? e));
      })
      .finally(() => setLoading(false));
  }, []);

  async function playSample(speaker: SampleSpeaker, tok: string) {
    const candidates = sampleResourceCandidates(speaker, tok);
    let lastErr: unknown = null;

    for (const resourcePath of candidates) {
      try {
        await playBundledAudio(resourcePath);
        return;
      } catch (e) {
        lastErr = e;
        const msg = String((e as any)?.message ?? e);
        if (/user gesture|required/i.test(msg)) {
          message.info("最初に画面を1回クリックして音声を有効化してください");
          return;
        }
        if (
          /not found|no such file|failed to (resolve|load)|os error\s*2/i.test(
            msg
          )
        ) {
          continue;
        }
        //message.error(`再生に失敗: ${tok} (${msg})`);
        //message.info(`まだ音声がありません: ${tok} (${candidates.join(" / ")})`);
        message.info(`まだ音声がありません: ${tok}`);
        return;
      }
    }

    //message.info(`まだ音声がありません: ${tok} (${candidates.join(" / ")})`);
    message.info(`まだ音声がありません: ${tok}`);
    void lastErr;
  }

  async function playCorrect(tok: string) {
    const entry = ipaIndex?.[tok];
    const resourcePath = entry?.audio ?? null;
    if (!resourcePath) {
      message.info(`まだ音声がありません: ${tok}`);
      return;
    }

    try {
      await playBundledAudio(resourcePath);
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      if (/user gesture|required/i.test(msg)) {
        message.info("最初に画面を1回クリックして音声を有効化してください");
      } else {
        message.error(`再生に失敗: ${tok} (${msg})`);
      }
    }
  }

  return (
    <Space
      orientation="vertical"
      style={{ width: "100%" }}
      onPointerDown={() => {
        if (unlockTriedRef.current) return;
        unlockTriedRef.current = true;
        void unlockAudioFromUserGesture().catch(() => {
          // not fatal
        });
      }}
    >
      <TopNav
        current="common"
        onBack={onBack}
        onOpenIpaList={onOpenIpaList}
        onOpenDevelopersMistakes={onOpenDevelopersMistakes}
        onOpenCommonMistakes={onOpenCommonMistakes}
      />

      <Typography.Title level={4} style={{ margin: 0 }}>
        よくある間違い（録音はあとで追加）
      </Typography.Title>

      <Typography.Paragraph style={{ marginBottom: 8 }}>
        ネイティブの指摘とは別に、発音学習でハマりやすいポイントをメモしていくページです。
      </Typography.Paragraph>

      <Typography.Title level={5} style={{ margin: "12px 0 0" }}>
        一覧
      </Typography.Title>

      {loading && (
        <Space>
          <Spin size="small" />
          <Typography.Text type="secondary">読み込み中…</Typography.Text>
        </Space>
      )}

      {error && (
        <Typography.Text type="danger">
          IPA index 読み込み失敗: {error}
        </Typography.Text>
      )}

      <div
        style={{
          border: "1px solid var(--ant-color-border)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {COMMON_PITFALLS.map((p, idx) => (
          <div key={p.key}>
            <div style={{ padding: "12px 16px" }}>
              <Space orientation="vertical" size={4} style={{ width: "100%" }}>
                <Typography.Text strong>{p.title}</Typography.Text>
                <Typography.Text type="secondary">{p.body}</Typography.Text>
                {p.ipa && p.ipa.length > 0 && (
                  <Space wrap>
                    {p.ipa.map((tok) => (
                      <Space key={`${p.key}-${tok}`} wrap>
                        <Typography.Text>{tok}</Typography.Text>
                        <Button
                          size="small"
                          icon={<PlayCircleOutlined />}
                          onClick={() => void playSample("failed", tok)}
                        >
                          failed
                        </Button>
                        <Button
                          size="small"
                          icon={<PlayCircleOutlined />}
                          onClick={() => void playCorrect(tok)}
                          disabled={!!error || loading}
                        >
                          Correct
                        </Button>
                      </Space>
                    ))}
                  </Space>
                )}
              </Space>
            </div>
            {idx < COMMON_PITFALLS.length - 1 && (
              <div style={{ borderTop: "1px solid var(--ant-color-split)" }} />
            )}
          </div>
        ))}
      </div>
    </Space>
  );
}
