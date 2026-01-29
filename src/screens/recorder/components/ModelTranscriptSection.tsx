import { Button, Input, Space, Spin, Typography, message } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RenderLinkingResult, DisplayMode } from "../../../types/linking";
import type { IpaIndex } from "../../../utils/ipaResources";
import LinkingStressArea from "../LinkingStressArea";
import type { ModelStatus } from "../../../types/model";
import type { PitchAnalysis, WordPitch } from "../../../types/pitch";
import { PitchAlignmentChart } from "../../../components/PitchAlignmentChart";
import type { SourceKind } from "../../../types/speech";

type UpsertManifestTextResult = {
  status: "created" | "updated" | "conflict";
  manifestPath: string;
  previousText?: string | null;
};

type AccentOut = {
  words: WordPitch[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitForAccentWords = async (path: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const txt = await readTextFile(path);
      const parsed = JSON.parse(txt) as AccentOut;
      return parsed.words ?? null;
    } catch {
      // file may not exist yet or may be mid-write; retry
      await sleep(300);
    }
  }
  return null;
};

type Props = {
  isTranscribing: boolean;
  modelText: string | null;
  sentenceHash: string;
  lang: string;
  displayText: string;
  setDisplayText: (v: string) => void;
  modelAudioUrl: string | null;
  sourceKind: SourceKind;
  linkingResult: RenderLinkingResult | null;
  linkingDisplayMode: DisplayMode;
  setLinkingDisplayMode: (mode: DisplayMode) => void;
  ipaIndex: IpaIndex | null;
  status: ModelStatus;
  progress: number | null;
  headerRight?: React.ReactNode;
};

export function ModelTranscriptSection({
  isTranscribing,
  modelText,
  sentenceHash,
  lang,
  displayText,
  setDisplayText,
  modelAudioUrl,
  sourceKind,
  linkingResult,
  linkingDisplayMode,
  setLinkingDisplayMode,
  ipaIndex,
  status,
  progress,
  headerRight,
}: Props) {
  const { t } = useTranslation();

  const langNorm = (lang ?? "").toLowerCase();
  const isJapanese =
    langNorm === "jpn" || langNorm === "ja" || langNorm.startsWith("ja-");

  const stripWhisperSpecialTokens = (s: string) =>
    s
      .replace(/\[_[^\]]+\]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const modelTextClean = modelText ? stripWhisperSpecialTokens(modelText) : "";

  const hasModelText = Boolean(modelText?.trim());
  const [isEditingText, setIsEditingText] = useState(false);
  const [draftText, setDraftText] = useState<string>(displayText ?? "");
  const [savingText, setSavingText] = useState(false);
  const [pitch, setPitch] = useState<PitchAnalysis | null>(null);
  const [accentWords, setAccentWords] = useState<WordPitch[] | null>(null);
  const [accentError, setAccentError] = useState<string | null>(null);
  const [pitchLoading, setPitchLoading] = useState(false);
  const [pitchError, setPitchError] = useState<string | null>(null);
  const pitchRequestedRef = useRef(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadTime, setPlayheadTime] = useState<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastSetRef = useRef<number>(0);

  useEffect(() => {
    pitchRequestedRef.current = false;
    setPitch(null);
    setAccentWords(null);
    setAccentError(null);
    setPitchLoading(false);
    setPitchError(null);
    setIsPlaying(false);
    setPlayheadTime(null);
    lastSetRef.current = 0;
  }, [sentenceHash, sourceKind]);

  useEffect(() => {
    if (!isEditingText) setDraftText(displayText ?? "");
  }, [displayText, isEditingText]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const stopRaf = () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };

    const tick = () => {
      const cur = el.currentTime ?? 0;
      if (Math.abs(cur - lastSetRef.current) >= 0.03) {
        lastSetRef.current = cur;
        setPlayheadTime(cur);
      }
      if (!el.paused && !el.ended) {
        rafIdRef.current = requestAnimationFrame(tick);
      } else {
        stopRaf();
      }
    };

    const onPlay = () => {
      setIsPlaying(true);
      stopRaf();
      rafIdRef.current = requestAnimationFrame(tick);
    };
    const onPauseOrEnd = () => {
      setIsPlaying(false);
      stopRaf();
      setPlayheadTime(el.currentTime ?? 0);
    };
    const onSeek = () => {
      lastSetRef.current = el.currentTime ?? 0;
      setPlayheadTime(el.currentTime ?? 0);
    };

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPauseOrEnd);
    el.addEventListener("ended", onPauseOrEnd);
    el.addEventListener("seeked", onSeek);

    return () => {
      stopRaf();
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPauseOrEnd);
      el.removeEventListener("ended", onPauseOrEnd);
      el.removeEventListener("seeked", onSeek);
    };
  }, [modelAudioUrl, pitch]);

  useEffect(() => {
    // Only run after we have a transcript for the model audio.
    if (!hasModelText) return;
    if (pitchRequestedRef.current) return;
    pitchRequestedRef.current = true;

    let cancelled = false;
    (async () => {
      setPitchLoading(true);
      setPitchError(null);
      try {
        const dir = await documentDir();

        // Uploaded sources store wav/pitch next to uploaded/uploaded.*.
        // Other sources (tatoeba/recorded) use model/model.* as the reference audio cache.
        const cacheSubdir = sourceKind === "uploaded" ? "uploaded" : "model";
        const cacheStem = sourceKind === "uploaded" ? "uploaded" : "model";

        const wavPath = await join(
          dir,
          "falkoe",
          "sentences",
          sentenceHash,
          cacheSubdir,
          `${cacheStem}.wav`,
        );

        // Prefer cached pitch analysis if present.
        try {
          const pitchPath = await join(
            dir,
            "falkoe",
            "sentences",
            sentenceHash,
            cacheSubdir,
            `${cacheStem}.pitch.json`,
          );
          const cached = await readTextFile(pitchPath);
          const parsed = JSON.parse(cached) as PitchAnalysis;
          if (!cancelled) setPitch(parsed);

          if (isJapanese) {
            // Prefer accent overlay from model.accent.json if present (Japanese only).
            const accentPath = await join(
              dir,
              "falkoe",
              "sentences",
              sentenceHash,
              cacheSubdir,
              `${cacheStem}.accent.json`,
            );
            const words = await waitForAccentWords(accentPath, 60000);
            if (!cancelled) {
              setAccentWords(words);
              setAccentError(
                words === null
                  ? `アクセント情報 (${accentPath.split(/[\\/]/).pop() ?? "accent.json"}) を1分待ちましたが読み込めませんでした。`
                  : null,
              );
            }
          }
          return;
        } catch {
          // ignore; fall back to live analysis
        }

        const res = await invoke<PitchAnalysis>("analyze_pitch", {
          wavPath,
          includeSegments: true,
        });

        if (!cancelled) setPitch(res);

        if (isJapanese) {
          // If available, load accent overlay generated during transcription (Japanese only).
          const accentPath = await join(
            dir,
            "falkoe",
            "sentences",
            sentenceHash,
            cacheSubdir,
            `${cacheStem}.accent.json`,
          );
          const words = await waitForAccentWords(accentPath, 60000);
          if (!cancelled) {
            setAccentWords(words);
            const filename = accentPath.split(/[\\/]/).pop() ?? "accent.json";
            setAccentError(
              words === null
                ? `${t("screens.recorder.pitch.accentTimeoutPrefix")}${filename}${t("screens.recorder.pitch.accentTimeoutSuffix")}`
                : null,
            );
          }
        }
      } catch (e) {
        if (!cancelled) setPitchError(String(e));
      } finally {
        if (!cancelled) setPitchLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasModelText, isJapanese, sentenceHash, sourceKind, t]);

  return (
    <>
      {isTranscribing && (
        <Space>
          <Spin size="small" />
          <Typography.Text type="secondary">
            {t("screens.recorder.modelTranscript.transcribing")}
          </Typography.Text>
        </Space>
      )}

      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <Typography.Paragraph style={{ flex: "1 1 auto", minWidth: 0 }}>
          <strong style={{ whiteSpace: "nowrap" }}>
            {t("screens.recorder.modelTranscript.label")}
          </strong>{" "}
          {modelText ? (
            modelTextClean
          ) : (
            <Typography.Text type="secondary">
              {t("screens.recorder.modelTranscript.notTranscribed")}
            </Typography.Text>
          )}
        </Typography.Paragraph>

        {headerRight && <div style={{ flex: "0 0 auto" }}>{headerRight}</div>}
      </div>

      <div style={{ marginTop: 8 }}>
        {!isEditingText ? (
          <Button
            size="small"
            onClick={() => {
              const initial = (displayText || "").trim() || modelTextClean;
              setDraftText(initial);
              setIsEditingText(true);
            }}
          >
            {t("screens.recorder.modelTranscript.edit")}
          </Button>
        ) : (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Input.TextArea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 8 }}
              placeholder={
                modelTextClean ||
                t("screens.recorder.modelTranscript.notTranscribed")
              }
            />
            <Space wrap>
              <Button
                size="small"
                disabled={!modelTextClean}
                onClick={() => setDraftText(modelTextClean)}
              >
                {t("screens.recorder.modelTranscript.useTranscript")}
              </Button>
              <Button
                size="small"
                type="primary"
                loading={savingText}
                disabled={savingText}
                onClick={async () => {
                  const next = (draftText ?? "").trim();
                  const l = (lang ?? "").trim();
                  if (!next) {
                    message.warning(
                      t("screens.recorder.modelTranscript.emptyError"),
                    );
                    return;
                  }
                  if (!sentenceHash || !l) return;

                  setSavingText(true);
                  try {
                    await invoke<UpsertManifestTextResult>(
                      "upsert_sentence_manifest_text",
                      {
                        audioId: sentenceHash,
                        lang: l,
                        text: next,
                        overwrite: true,
                      },
                    );
                    setDisplayText(next);
                    setIsEditingText(false);
                    message.success(
                      t("screens.recorder.modelTranscript.saved"),
                    );
                  } catch (e: any) {
                    message.error(
                      t("screens.recorder.modelTranscript.saveFailed") +
                        String(e),
                    );
                  } finally {
                    setSavingText(false);
                  }
                }}
              >
                {t("screens.recorder.modelTranscript.save")}
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setIsEditingText(false);
                  setDraftText(displayText ?? "");
                }}
              >
                {t("screens.recorder.modelTranscript.cancel")}
              </Button>
            </Space>
          </Space>
        )}
      </div>

      {/* hidden audio element to drive playhead sync */}
      {modelAudioUrl && (
        <audio
          ref={audioRef}
          src={modelAudioUrl}
          preload="metadata"
          style={{ display: "none" }}
        />
      )}

      {modelText && (
        <div style={{ marginTop: 8 }}>
          {pitchLoading && (
            <Space>
              <Spin size="small" />
              <Typography.Text type="secondary">
                {t("screens.recorder.pitch.loading")}
              </Typography.Text>
            </Space>
          )}

          {!pitchLoading && pitchError && (
            <Typography.Text type="secondary">
              {t("screens.recorder.pitch.failed")}
              {pitchError}
            </Typography.Text>
          )}

          {!pitchLoading && !pitchError && pitch && (
            <div style={{ marginBottom: 15 }}>
              <Space align="center" size={10} style={{ marginBottom: 4 }}>
                <Typography.Text type="secondary">
                  {t("screens.recorder.pitch.extractor")}{" "}
                  {pitch.extractor ??
                    t("screens.recorder.pitch.extractorUnknown")}
                </Typography.Text>
                <Button
                  size="small"
                  disabled={!modelAudioUrl}
                  onClick={async () => {
                    const el = audioRef.current;
                    if (!el) return;
                    if (el.paused || el.ended) {
                      try {
                        await el.play();
                      } catch {
                        // ignore
                      }
                    } else {
                      el.pause();
                    }
                  }}
                >
                  {isPlaying
                    ? t("screens.recorder.pitch.stop")
                    : t("screens.recorder.pitch.play")}
                </Button>
              </Space>
              {!pitchLoading && !pitchError && isJapanese && accentError && (
                <div style={{ marginBottom: 6 }}>
                  <Typography.Text type="warning">
                    {accentError}
                  </Typography.Text>
                </div>
              )}
              <PitchAlignmentChart
                analysis={pitch}
                words={isJapanese ? accentWords : undefined}
                showLabels={isJapanese}
                playheadTime={playheadTime}
              />
            </div>
          )}
        </div>
      )}

      {linkingResult?.joined && (
        <LinkingStressArea
          linkingResult={linkingResult}
          linkingDisplayMode={linkingDisplayMode}
          setLinkingDisplayMode={setLinkingDisplayMode}
          ipaIndex={ipaIndex}
        />
      )}

      <Typography.Text type="secondary">
        {t("screens.recorder.model.status")}
        {status}
      </Typography.Text>

      {status === "downloading" && (
        <Typography.Text type="secondary">
          {t("screens.recorder.model.downloading")}
          {progress ?? 0}%
        </Typography.Text>
      )}
    </>
  );
}
