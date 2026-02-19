import { Button, message, Space, Spin, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadIpaIndex, type IpaIndex } from "../utils/ipaResources";
import {
  playBundledAudio,
  unlockAudioFromUserGesture,
} from "../utils/ipaPlayer";
import {
  sampleResourceCandidates,
  type SampleSpeaker,
  type CommonPitfall,
} from "../data/commonMistakes";
import TopNav from "../components/TopNav";
import { useTranslation } from "react-i18next";

type Props = {
  onBack: () => void;
  onOpenHistory: () => void;
  onOpenIpaList: () => void;
  onOpenAudioCutter: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
  onOpenSettings: () => void;
};

export default function CommonMistakesScreen({
  onBack,
  onOpenHistory,
  onOpenIpaList,
  onOpenAudioCutter,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
  onOpenSettings,
}: Props) {
  const { t, i18n } = useTranslation();
  const [ipaIndex, setIpaIndex] = useState<IpaIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const unlockTriedRef = useRef(false);

  const commonPitfalls = useMemo(() => {
    const v = t("data.commonPitfalls", { returnObjects: true });
    return Array.isArray(v) ? (v as CommonPitfall[]) : [];
  }, [t, i18n.language]);

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

  function androidDebugSuffix(err: unknown): string {
    if (!/Android/i.test(navigator.userAgent ?? "")) return "";
    const msg = String((err as any)?.message ?? err ?? "").trim();
    if (!msg) return "";
    const short = msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
    return ` [debug: ${short}]`;
  }

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
          message.info(t("screens.commonMistakes.audioUnlockHint"));
          return;
        }
        if (
          /not found|no such file|failed to (resolve|load)|os error\s*2|no supported source|empty bundled audio file/i.test(
            msg,
          )
        ) {
          continue;
        }
        //message.error(`再生に失敗: ${tok} (${msg})`);
        //message.info(`まだ音声がありません: ${tok} (${candidates.join(" / ")})`);
        message.info(
          `${t("screens.commonMistakes.noAudioForToken")}${tok}${androidDebugSuffix(e)}`,
        );
        return;
      }
    }

    //message.info(`まだ音声がありません: ${tok} (${candidates.join(" / ")})`);
    message.info(
      `${t("screens.commonMistakes.noAudioForToken")}${tok}${androidDebugSuffix(lastErr)}`,
    );
    void lastErr;
  }

  async function playCorrect(tok: string) {
    const entry = ipaIndex?.[tok];
    const resourcePath = entry?.audio ?? null;
    if (!resourcePath) {
      message.info(`${t("screens.commonMistakes.noAudioForToken")}${tok}`);
      return;
    }

    try {
      await playBundledAudio(resourcePath);
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      if (/user gesture|required/i.test(msg)) {
        message.info(t("screens.commonMistakes.audioUnlockHint"));
      } else {
        message.error(
          `${t("screens.commonMistakes.playFailed")}${tok} (${msg})`,
        );
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
        onOpenHistory={onOpenHistory}
        onOpenIpaList={onOpenIpaList}
        onOpenAudioCutter={onOpenAudioCutter}
        onOpenSettings={onOpenSettings}
        onOpenDevelopersMistakes={onOpenDevelopersMistakes}
        onOpenCommonMistakes={onOpenCommonMistakes}
      />

      <Typography.Title level={4} style={{ margin: 0 }}>
        {t("screens.commonMistakes.title")}
      </Typography.Title>

      <Typography.Paragraph style={{ marginBottom: 8 }}>
        {t("screens.commonMistakes.description")}
      </Typography.Paragraph>

      <Typography.Title level={5} style={{ margin: "12px 0 0" }}>
        {t("screens.commonMistakes.listTitle")}
      </Typography.Title>

      {loading && (
        <Space>
          <Spin size="small" />
          <Typography.Text type="secondary">
            {t("screens.commonMistakes.loading")}
          </Typography.Text>
        </Space>
      )}

      {error && (
        <Typography.Text type="danger">
          {t("screens.commonMistakes.ipaIndexLoadFailed")}
          {error}
        </Typography.Text>
      )}

      <div
        style={{
          border: "1px solid var(--ant-color-border)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {commonPitfalls.map((p, idx) => (
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
                          {t("screens.commonMistakes.buttons.failed")}
                        </Button>
                        <Button
                          size="small"
                          icon={<PlayCircleOutlined />}
                          onClick={() => void playCorrect(tok)}
                          disabled={!!error || loading}
                        >
                          {t("screens.commonMistakes.buttons.correct")}
                        </Button>
                      </Space>
                    ))}
                  </Space>
                )}
              </Space>
            </div>
            {idx < commonPitfalls.length - 1 && (
              <div style={{ borderTop: "1px solid var(--ant-color-split)" }} />
            )}
          </div>
        ))}
      </div>
    </Space>
  );
}
