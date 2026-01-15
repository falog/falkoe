import { Button, message, Space, Spin, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadIpaIndex, type IpaIndex } from "../utils/ipaResources";
import {
  playBundledAudio,
  bundledResourceExists,
  unlockAudioFromUserGesture,
} from "../utils/ipaPlayer";
import {
  sampleResourceCandidates,
  type SampleSpeaker,
  type CommonMistake,
  type MistakeInline,
  type MistakeParagraph,
} from "../data/commonMistakes";
import TopNav from "../components/TopNav";

type Props = {
  onBack: () => void;
  onOpenHistory: () => void;
  onOpenIpaList: () => void;
  onOpenCommonMistakes: () => void;
  onOpenSettings: () => void;
  initialFocus?: "j" | "r" | "oo";
};

export default function DevelopersMistakesScreen({
  onBack,
  onOpenHistory,
  onOpenIpaList,
  onOpenCommonMistakes,
  onOpenSettings,
  initialFocus,
}: Props) {
  const { t, i18n } = useTranslation();
  const [ipaIndex, setIpaIndex] = useState<IpaIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sampleExplainAvailable, setSampleExplainAvailable] = useState<
    Record<string, boolean>
  >({});
  const unlockTriedRef = useRef(false);

  const commonMistakes = useMemo(() => {
    const v = t("data.commonMistakes", { returnObjects: true });
    return (Array.isArray(v) ? v : []) as unknown as CommonMistake[];
  }, [t, i18n.language]);

  const pageMistakes = useMemo(() => {
    return commonMistakes.filter((m) => m.key === "r" || m.key === "oo");
  }, [commonMistakes]);

  useEffect(() => {
    let cancelled = false;

    const simpleKeys = new Set(["r", "oo"]);
    const explainToks = Array.from(
      new Set(
        pageMistakes
          .filter((m) => simpleKeys.has(m.key))
          .flatMap((m) =>
            m.buttons.filter((b) => b.kind === "explain").map((b) => b.tok)
          )
      )
    );

    (async () => {
      const updates: Record<string, boolean> = {};

      for (const tok of explainToks) {
        const speaker: SampleSpeaker = "falkoe";
        const key = `${speaker}:${tok}:explain`;
        if (key in updates) continue;

        const candidates = sampleResourceCandidates(speaker, tok).map((p) =>
          p.replace(/\.wav$/i, "_explain.wav")
        );

        let ok = false;
        for (const p of candidates) {
          if (await bundledResourceExists(p)) {
            ok = true;
            break;
          }
        }
        updates[key] = ok;
      }

      if (cancelled) return;
      setSampleExplainAvailable((prev) => ({ ...prev, ...updates }));
    })().catch(() => {
      // not fatal
    });

    return () => {
      cancelled = true;
    };
  }, [pageMistakes]);

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

  useEffect(() => {
    if (!initialFocus) return;
    if (loading || error) return;

    // Back-compat: the old page had a "j" section; now it only has r/oo.
    const focus = initialFocus === "j" ? "r" : initialFocus;
    const el = document.getElementById(`mistake-${focus}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [initialFocus, loading, error]);

  function renderInline(inline: MistakeInline, idx: number) {
    if (inline.kind === "code") {
      return (
        <Typography.Text key={idx} code>
          {inline.value}
        </Typography.Text>
      );
    }
    return <span key={idx}>{inline.value}</span>;
  }

  function renderParagraph(p: MistakeParagraph, idx: number) {
    return (
      <Typography.Paragraph key={idx} style={{ marginBottom: 8 }}>
        {p.map(renderInline)}
      </Typography.Paragraph>
    );
  }

  async function playTok(tok: string, kind: "audio" | "explain") {
    const entry = ipaIndex?.[tok];
    const resourcePath =
      kind === "explain"
        ? (entry?.explainAudio ?? null)
        : (entry?.audio ?? null);

    if (!resourcePath) {
      message.info(`${t("screens.developersMistakes.noAudioForToken")}${tok}`);
      return;
    }

    try {
      await playBundledAudio(resourcePath);
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      if (/user gesture|required/i.test(msg)) {
        message.info(t("screens.commonMistakes.audioUnlockHint"));
      } else {
        //message.error(`再生に失敗: ${tok} (${msg})`);
        message.info(`${t("screens.developersMistakes.noAudioAlt")}${tok}`);
      }
    }
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
          /not found|no such file|failed to (resolve|load)|os error\s*2/i.test(
            msg
          )
        ) {
          // try next candidate
          continue;
        }
        //message.error(`再生に失敗: ${tok} (${msg})`);
        message.info(`${t("screens.developersMistakes.noAudioAlt")}${tok}`);
        return;
      }
    }

    message.info(
      `${t("screens.developersMistakes.noAudioWithCandidates")}${tok} (${candidates.join(
        " / "
      )})`
    );
    void lastErr;
  }

  async function playSampleExplain(speaker: SampleSpeaker, tok: string) {
    const candidates = sampleResourceCandidates(speaker, tok).map((p) =>
      p.replace(/\.wav$/i, "_explain.wav")
    );
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
          /not found|no such file|failed to (resolve|load)|os error\s*2/i.test(
            msg
          )
        ) {
          // try next candidate
          continue;
        }
        //message.error(`再生に失敗: ${tok} (${msg})`);
        message.info(
          `${t("screens.developersMistakes.noAudioForToken")}${tok}`
        );
        return;
      }
    }

    //message.info(`まだ音声がありません: ${tok} (${candidates.join(" / ")})`);
    message.info(t("screens.developersMistakes.noAudio"));
    void lastErr;
  }

  return (
    <div
      onPointerDown={() => {
        if (unlockTriedRef.current) return;
        unlockTriedRef.current = true;
        void unlockAudioFromUserGesture().catch(() => {
          // not fatal
        });
      }}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <TopNav
          current="mistakes"
          onBack={onBack}
          onOpenHistory={onOpenHistory}
          onOpenIpaList={onOpenIpaList}
          onOpenSettings={onOpenSettings}
          onOpenDevelopersMistakes={() => {
            // already here
          }}
          onOpenCommonMistakes={onOpenCommonMistakes}
        />

        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("screens.developersMistakes.title")}
        </Typography.Title>

        <Typography.Paragraph style={{ margin: 0 }}>
          <Typography.Text strong>
            {t("screens.developersMistakes.tocTitle")}
          </Typography.Text>
        </Typography.Paragraph>
        <Space wrap>
          {pageMistakes.map((m) => (
            <Button
              key={`toc-${m.key}`}
              type="link"
              onClick={() =>
                document
                  .getElementById(`mistake-${m.key}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              {m.title}
            </Button>
          ))}
        </Space>

        <Typography.Paragraph>
          {t("screens.developersMistakes.intro")}
        </Typography.Paragraph>

        <Typography.Paragraph>
          <Typography.Text strong>
            {t("screens.developersMistakes.nativeCommentOriginal")}
          </Typography.Text>
          <pre style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>
            {t("screens.developersMistakes.nativeFeedback")}
          </pre>
        </Typography.Paragraph>

        <Typography.Paragraph>
          <Typography.Text strong>
            {t("screens.developersMistakes.nativeCommentJa")}
          </Typography.Text>
          <pre style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>
            {t("screens.developersMistakes.nativeFeedbackJa")}
          </pre>
        </Typography.Paragraph>

        <Typography.Paragraph>
          {t("screens.developersMistakes.fun.line1")}
          <Typography.Text type="secondary">
            {t("screens.developersMistakes.fun.aside")}
          </Typography.Text>
          <br />
          {t("screens.developersMistakes.fun.line2")}
        </Typography.Paragraph>

        {loading && (
          <Space>
            <Spin size="small" />
            <Typography.Text type="secondary">
              {t("screens.developersMistakes.loading")}
            </Typography.Text>
          </Space>
        )}

        {error && (
          <Typography.Text type="danger">
            {t("screens.developersMistakes.ipaIndexLoadFailed")}
            {error}
          </Typography.Text>
        )}

        {!loading && !error && (
          <>
            <Typography.Title level={5} style={{ margin: "8px 0 0" }}>
              {t("screens.developersMistakes.whatHappenedTitle")}
            </Typography.Title>

            <div
              style={{
                border: "1px solid var(--ant-color-border)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              {pageMistakes.map((item, idx) => (
                <div key={item.key} id={`mistake-${item.key}`}>
                  <div style={{ padding: "12px 16px" }}>
                    <Space
                      orientation="vertical"
                      size={8}
                      style={{ width: "100%" }}
                    >
                      <Typography.Text strong>{item.title}</Typography.Text>

                      <div>{item.paragraphs.map(renderParagraph)}</div>

                      {(() => {
                        const simpleKeys = new Set(["r", "oo"]);

                        if (!simpleKeys.has(item.key)) {
                          return (
                            <Space wrap>
                              {item.buttons.map((b) => (
                                <Button
                                  key={`${item.key}-${b.kind}-${b.tok}`}
                                  icon={<PlayCircleOutlined />}
                                  onClick={() => void playTok(b.tok, b.kind)}
                                  disabled={
                                    b.kind === "explain"
                                      ? !ipaIndex?.[b.tok]?.explainAudio
                                      : !ipaIndex?.[b.tok]?.audio
                                  }
                                >
                                  {b.label}
                                </Button>
                              ))}
                            </Space>
                          );
                        }

                        const audioTokSet = new Set(
                          item.buttons
                            .filter((b) => b.kind === "audio")
                            .map((b) => b.tok)
                        );
                        const explainTokSet = new Set(
                          item.buttons
                            .filter((b) => b.kind === "explain")
                            .map((b) => b.tok)
                        );

                        const tokenOrderByKey: Record<string, string[]> = {
                          r: ["ɹ"],
                          oo: ["uː", "ʊ"],
                        };

                        const orderedToks = (
                          tokenOrderByKey[item.key] ?? []
                        ).filter((tok) => audioTokSet.has(tok));

                        return (
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 8,
                            }}
                          >
                            {orderedToks.flatMap((tok, tokIdx) => {
                              const out = [
                                <Button
                                  key={`${item.key}-${tok}-pronounce-falkoe`}
                                  icon={<PlayCircleOutlined />}
                                  onClick={() => void playSample("falkoe", tok)}
                                >
                                  {tok}{" "}
                                  {t(
                                    "screens.developersMistakes.buttons.pronounceWithTok"
                                  )}
                                </Button>,
                                explainTokSet.has(tok) &&
                                sampleExplainAvailable[
                                  `falkoe:${tok}:explain`
                                ] ? (
                                  <Button
                                    key={`${item.key}-${tok}-explain-falkoe`}
                                    onClick={() =>
                                      void playSampleExplain("falkoe", tok)
                                    }
                                  >
                                    {tok}{" "}
                                    {t(
                                      "screens.developersMistakes.buttons.explainWithTok"
                                    )}
                                  </Button>
                                ) : null,
                                <Button
                                  key={`${item.key}-${tok}-native`}
                                  icon={<PlayCircleOutlined />}
                                  onClick={() =>
                                    void playSample("advised-by-native", tok)
                                  }
                                >
                                  {tok}{" "}
                                  {t(
                                    "screens.developersMistakes.buttons.native"
                                  )}
                                </Button>,
                              ].filter(Boolean);

                              if (tokIdx < orderedToks.length - 1) {
                                out.push(
                                  <div
                                    key={`${item.key}-${tok}-break`}
                                    style={{ flexBasis: "100%", height: 0 }}
                                  />
                                );
                              }

                              return out;
                            })}
                          </div>
                        );
                      })()}

                      {(() => {
                        const simpleKeys = new Set(["r", "oo"]);
                        if (simpleKeys.has(item.key)) return null;

                        const abcExcluded = new Set(["dʒ", "ʊ", "ɹ"]);
                        const abcToks = Array.from(
                          new Set(
                            item.buttons
                              .filter((b) => b.kind === "audio")
                              .map((b) => b.tok)
                              .filter((tok) => !abcExcluded.has(tok))
                          )
                        );

                        if (abcToks.length === 0) return null;

                        return (
                          <div style={{ marginTop: 8 }}>
                            <Typography.Text type="secondary">
                              {t("screens.developersMistakes.abLabel")}
                            </Typography.Text>
                            <Space wrap style={{ marginTop: 6 }}>
                              {abcToks.map((tok) => (
                                <Space key={`${item.key}-abc-${tok}`} wrap>
                                  <Typography.Text>{tok}</Typography.Text>
                                  <Button
                                    size="small"
                                    onClick={() =>
                                      void playSample("failed", tok)
                                    }
                                  >
                                    {t(
                                      "screens.developersMistakes.buttons.failed"
                                    )}
                                  </Button>
                                  <Button
                                    size="small"
                                    onClick={() =>
                                      void playSample("advised-by-native", tok)
                                    }
                                  >
                                    {t(
                                      "screens.developersMistakes.buttons.native"
                                    )}
                                  </Button>
                                </Space>
                              ))}
                            </Space>
                          </div>
                        );
                      })()}
                    </Space>
                  </div>

                  {idx < pageMistakes.length - 1 && (
                    <div
                      style={{ borderTop: "1px solid var(--ant-color-split)" }}
                    />
                  )}
                </div>
              ))}
            </div>
            <Typography.Title level={5} style={{ margin: "12px 0 0" }}>
              {t("screens.developersMistakes.fixNextStepsTitle")}
            </Typography.Title>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              - {t("screens.developersMistakes.fix.line1")}
              <br />- {t("screens.developersMistakes.fix.line2")}
            </Typography.Paragraph>
          </>
        )}
      </Space>
    </div>
  );
}
