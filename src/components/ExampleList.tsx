import { Button, Space, Typography, message } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { openExternalUrl } from "../utils/openExternalUrl";
import { formatTatoebaCreditText } from "../utils/formatTatoebaCreditText";
import { isAndroidRuntime } from "../utils/runtimePlatform";

let exampleAudioContext: AudioContext | null = null;
let currentBufferSource: AudioBufferSourceNode | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AnyAudioContext =
    (window as any).AudioContext ?? (window as any).webkitAudioContext;
  if (!AnyAudioContext) return null;
  if (!exampleAudioContext) {
    exampleAudioContext = new AnyAudioContext();
  }
  return exampleAudioContext;
}

function stopCurrentBufferSource(): void {
  if (!currentBufferSource) return;
  try {
    currentBufferSource.stop();
  } catch {
    // ignore
  }
  currentBufferSource = null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function isAutoplayBlockedError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const anyErr = e as any;
  const name = String(anyErr?.name ?? "");
  const msg = String(anyErr?.message ?? "");
  return (
    name === "NotAllowedError" || /user gesture|not allowed|autoplay/i.test(msg)
  );
}

async function playDecodedAudioWithWebAudio(bytes: Uint8Array): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;

  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  stopCurrentBufferSource();

  try {
    const ab = toArrayBuffer(bytes);
    const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
      const anyCtx = ctx as any;
      const p = anyCtx.decodeAudioData(
        ab.slice(0),
        (buf: AudioBuffer) => resolve(buf),
        (err: unknown) => reject(err),
      );
      if (p && typeof p.then === "function") {
        p.then(resolve, reject);
      }
    });

    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    source.onended = () => {
      if (currentBufferSource === source) currentBufferSource = null;
    };
    currentBufferSource = source;
    source.start();
    return true;
  } catch {
    return false;
  }
}

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

  const playRemoteAudioAndroid = async (audioId: string, url: string) => {
    // Avoid WebView URL-loading paths on Android (can crash in shouldInterceptRequest).
    const cachedPath = await invoke<string>("ensure_sentence_audio_cached", {
      audioId,
      url,
    });
    const bytes = await readFile(cachedPath);

    // Prefer WebAudio decode; avoid HTMLAudio fallback on Android because it can crash
    // some WebViews (AUDIO_RENDERER_ERROR / process death).
    const played = await playDecodedAudioWithWebAudio(bytes);
    if (!played) {
      throw new Error("WebAudio decode failed");
    }
  };

  const playAudio = async (item: Sentence) => {
    const candidates = Array.from(
      new Set(
        [
          item.audioUrl,
          item.attribution?.audioId
            ? `https://tatoeba.org/en/audio/download/${item.attribution.audioId}`
            : null,
          `https://audio.tatoeba.org/sentences/${item.lang}/${item.id}.mp3`,
        ].filter(
          (x): x is string => typeof x === "string" && x.trim().length > 0,
        ),
      ),
    );

    let lastErr: unknown = null;
    const audioId = String(item.attribution?.audioId ?? `${item.lang}-${item.id}`);

    for (const url of candidates) {
      try {
        if (isAndroidRuntime()) {
          await playRemoteAudioAndroid(audioId, url);
        } else {
          const audio = new Audio(url);
          await audio.play();
        }
        return;
      } catch (e) {
        lastErr = e;
        if (isAutoplayBlockedError(e)) {
          message.info(t("screens.commonMistakes.audioUnlockHint"));
          return;
        }
      }
    }

    console.warn("[ExampleList] playAudio failed", { item, candidates, lastErr });
    message.info("音声の再生に失敗しました");
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
                onClick={() => void playAudio(item)}
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
