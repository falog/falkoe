import { Button, List, message, Space, Spin, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { loadIpaIndex, type IpaIndex } from "../utils/ipaResources";
import {
  playBundledAudio,
  bundledResourceExists,
  unlockAudioFromUserGesture,
} from "../utils/ipaPlayer";
import {
  COMMON_MISTAKES,
  sampleResourceCandidates,
  type SampleSpeaker,
  type MistakeInline,
  type MistakeParagraph,
} from "../data/commonMistakes";
import TopNav from "../components/TopNav";

type Props = {
  onBack: () => void;
  onOpenIpaList: () => void;
  onOpenCommonMistakes: () => void;
  initialFocus?: "j" | "r" | "oo";
};

export default function DevelopersMistakeScreen({
  onBack,
  onOpenIpaList,
  onOpenCommonMistakes,
  initialFocus,
}: Props) {
  const [ipaIndex, setIpaIndex] = useState<IpaIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sampleExplainAvailable, setSampleExplainAvailable] = useState<
    Record<string, boolean>
  >({});
  const unlockTriedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const simpleKeys = new Set(["j", "r", "oo"]);
    const explainToks = Array.from(
      new Set(
        COMMON_MISTAKES.filter((m) => simpleKeys.has(m.key)).flatMap((m) =>
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
  }, []);

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

    const el = document.getElementById(`mistake-${initialFocus}`);
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
      message.info(`音声がありません: ${tok}`);
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
          // try next candidate
          continue;
        }
        message.error(`再生に失敗: ${tok} (${msg})`);
        return;
      }
    }

    message.info(`まだ音声がありません: ${tok} (${candidates.join(" / ")})`);
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
          message.info("最初に画面を1回クリックして音声を有効化してください");
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
        message.error(`再生に失敗: ${tok} (${msg})`);
        return;
      }
    }

    message.info(`まだ音声がありません: ${tok} (${candidates.join(" / ")})`);
    void lastErr;
  }

  const nativeFeedback =
    'The "J" sound is correct with a consonant but the common "J" sound is different. Like in jump.\n' +
    'The "R" sound is more like a zombie sound like for run.\n' +
    'And the "oo" sound almost sounds like a U. Like for book or look.';

  const nativeFeedbackJa =
    "「J」の音は子音と一緒なら合ってるけど、一般的な「J」の音は違う。たとえば jump の J。\n" +
    "「R」の音は、run の r みたいにゾンビっぽい音に近い。\n" +
    "あと「oo」の音が、ほとんど「U」みたいに聞こえる。book や look みたいに。";

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
          current="mistake"
          onBack={onBack}
          onOpenIpaList={onOpenIpaList}
          onOpenDevelopersMistake={() => {
            // already here
          }}
          onOpenCommonMistakes={onOpenCommonMistakes}
        />

        <Typography.Title level={4} style={{ margin: 0 }}>
          Developer’s mistake (recorded by fal)
        </Typography.Title>

        <Typography.Paragraph style={{ margin: 0 }}>
          <Typography.Text strong>
            このページの目次（今回の3つ）
          </Typography.Text>
        </Typography.Paragraph>
        <Space wrap>
          {COMMON_MISTAKES.map((m) => (
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
          ネイティブに指摘された「自分の録音のミス」を、失敗談として残すページです。
          恥ずかしいけど、学習ログとしてちゃんと積み上げる。
        </Typography.Paragraph>

        <Typography.Paragraph>
          <Typography.Text strong>ネイティブのコメント（原文）</Typography.Text>
          <pre style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>
            {nativeFeedback}
          </pre>
        </Typography.Paragraph>

        <Typography.Paragraph>
          <Typography.Text strong>日本語訳</Typography.Text>
          <pre style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>
            {nativeFeedbackJa}
          </pre>
        </Typography.Paragraph>

        <Typography.Paragraph>
          これだけ発音がある中で「3つだけ」って逆にすごい。
          <Typography.Text type="secondary">
            （伸びしろが見える？笑）
          </Typography.Text>
          <br />
          でも、一体どれくらい言語の勉強しているか、もはやわからない（笑）
        </Typography.Paragraph>

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

        {!loading && !error && (
          <>
            <Typography.Title level={5} style={{ margin: "8px 0 0" }}>
              What happened（今回の3つ）
            </Typography.Title>

            <List
              bordered
              dataSource={COMMON_MISTAKES}
              renderItem={(item) => (
                <List.Item key={item.key} id={`mistake-${item.key}`}>
                  <List.Item.Meta
                    title={
                      <Typography.Text strong>{item.title}</Typography.Text>
                    }
                    description={
                      <>
                        {item.paragraphs.map(renderParagraph)}
                        {(() => {
                          const simpleKeys = new Set(["j", "r", "oo"]);

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
                            j: ["j", "dʒ"],
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
                                    onClick={() =>
                                      void playSample("falkoe", tok)
                                    }
                                  >
                                    {tok} Pronounce
                                  </Button>,
                                  explainTokSet.has(tok) &&
                                  sampleExplainAvailable[
                                    `falkoe:${tok}:explain`
                                  ] ? (
                                    <Button
                                      key={`${item.key}-${tok}-explain-falkoe`}
                                      icon={<PlayCircleOutlined />}
                                      onClick={() =>
                                        void playSampleExplain("falkoe", tok)
                                      }
                                    >
                                      {tok} Explain
                                    </Button>
                                  ) : null,
                                  <Button
                                    key={`${item.key}-${tok}-native`}
                                    icon={<PlayCircleOutlined />}
                                    onClick={() =>
                                      void playSample("advised-by-native", tok)
                                    }
                                  >
                                    {tok} Native
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
                          const simpleKeys = new Set(["j", "r", "oo"]);
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
                                A/B (failed / ネイティブ)
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
                                      failed
                                    </Button>
                                    <Button
                                      size="small"
                                      onClick={() =>
                                        void playSample(
                                          "advised-by-native",
                                          tok
                                        )
                                      }
                                    >
                                      Native
                                    </Button>
                                  </Space>
                                ))}
                              </Space>
                            </div>
                          );
                        })()}
                      </>
                    }
                  />
                </List.Item>
              )}
            />
            <Typography.Title level={5} style={{ margin: "12px 0 0" }}>
              Fix / Next steps
            </Typography.Title>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              - <Typography.Text code>dʒ</Typography.Text> の録音を増やして、
              <Typography.Text code>j</Typography.Text>
              （yes）との対比を定着させる
              <br />- <Typography.Text code>ɹ</Typography.Text> は “うなり”
              を抜いて クリアな近似音に寄せる
              <br />- <Typography.Text code>uː</Typography.Text> と
              <Typography.Text code>ʊ</Typography.Text> を最小対立で練習する
            </Typography.Paragraph>
          </>
        )}
      </Space>
    </div>
  );
}
