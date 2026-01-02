import { Space, Spin, Typography } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useRef, useState } from "react";
import type { RenderLinkingResult, DisplayMode } from "../../../types/linking";
import type { IpaIndex } from "../../../utils/ipaResources";
import LinkingStressArea from "../LinkingStressArea";
import type { ModelStatus } from "../../../types/model";
import type { PitchAnalysis, WordPitch } from "../../../types/pitch";
import { PitchAlignmentChart } from "../../../components/PitchAlignmentChart";

type AccentOut = {
  words: WordPitch[];
};

type Props = {
  isTranscribing: boolean;
  modelText: string | null;
  sentenceHash: string;
  lang: string;
  linkingResult: RenderLinkingResult | null;
  linkingDisplayMode: DisplayMode;
  setLinkingDisplayMode: (mode: DisplayMode) => void;
  ipaIndex: IpaIndex | null;
  status: ModelStatus;
  progress: number | null;
};

export function ModelTranscriptSection({
  isTranscribing,
  modelText,
  sentenceHash,
  lang,
  linkingResult,
  linkingDisplayMode,
  setLinkingDisplayMode,
  ipaIndex,
  status,
  progress,
}: Props) {
  const langNorm = (lang ?? "").toLowerCase();
  const enablePitchAccent =
    langNorm === "jpn" || langNorm === "ja" || langNorm.startsWith("ja-");
  const [pitch, setPitch] = useState<PitchAnalysis | null>(null);
  const [accentWords, setAccentWords] = useState<WordPitch[] | null>(null);
  const [pitchLoading, setPitchLoading] = useState(false);
  const [pitchError, setPitchError] = useState<string | null>(null);
  const pitchRequestedRef = useRef(false);

  useEffect(() => {
    pitchRequestedRef.current = false;
    setPitch(null);
    setAccentWords(null);
    setPitchLoading(false);
    setPitchError(null);
  }, [sentenceHash]);

  useEffect(() => {
    // Only run after we have a transcript for the model audio.
    if (!modelText?.trim()) return;
    if (!enablePitchAccent) return;
    if (pitchRequestedRef.current) return;
    pitchRequestedRef.current = true;

    let cancelled = false;
    (async () => {
      setPitchLoading(true);
      setPitchError(null);
      try {
        const dir = await documentDir();
        const wavPath = await join(
          dir,
          "falkoe",
          "sentences",
          sentenceHash,
          "model",
          "model.wav"
        );

        // Prefer cached pitch analysis if present.
        try {
          const pitchPath = await join(
            dir,
            "falkoe",
            "sentences",
            sentenceHash,
            "model",
            "model.pitch.json"
          );
          const cached = await readTextFile(pitchPath);
          const parsed = JSON.parse(cached) as PitchAnalysis;
          if (!cancelled) setPitch(parsed);

          // Prefer accent overlay from model.accent.json if present.
          try {
            const accentPath = await join(
              dir,
              "falkoe",
              "sentences",
              sentenceHash,
              "model",
              "model.accent.json"
            );
            const accentCached = await readTextFile(accentPath);
            const accentParsed = JSON.parse(accentCached) as AccentOut;
            if (!cancelled) setAccentWords(accentParsed.words ?? null);
          } catch {
            // ignore; fall back to pitch.words/segments
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

        // If available, load accent overlay generated during transcription.
        try {
          const accentPath = await join(
            dir,
            "falkoe",
            "sentences",
            sentenceHash,
            "model",
            "model.accent.json"
          );
          const accentCached = await readTextFile(accentPath);
          const accentParsed = JSON.parse(accentCached) as AccentOut;
          if (!cancelled) setAccentWords(accentParsed.words ?? null);
        } catch {
          // ignore
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
  }, [enablePitchAccent, modelText, sentenceHash]);

  return (
    <>
      {isTranscribing && (
        <Space>
          <Spin size="small" />
          <Typography.Text type="secondary">文字起こし中…</Typography.Text>
        </Space>
      )}

      <Typography.Paragraph>
        <strong>Model transcript:</strong>
        <br />
        {modelText ? (
          modelText
        ) : (
          <Typography.Text type="secondary">
            音声認識されていません
          </Typography.Text>
        )}
      </Typography.Paragraph>

      {linkingResult?.joined && (
        <LinkingStressArea
          linkingResult={linkingResult}
          linkingDisplayMode={linkingDisplayMode}
          setLinkingDisplayMode={setLinkingDisplayMode}
          ipaIndex={ipaIndex}
        />
      )}

      {modelText && enablePitchAccent && (
        <div style={{ marginTop: 8 }}>
          {pitchLoading && (
            <Space>
              <Spin size="small" />
              <Typography.Text type="secondary">
                模範音声のピッチ解析中…
              </Typography.Text>
            </Space>
          )}

          {!pitchLoading && pitchError && (
            <Typography.Text type="secondary">
              模範音声のピッチ解析に失敗しました: {pitchError}
            </Typography.Text>
          )}

          {!pitchLoading && !pitchError && pitch && (
            <>
              <Typography.Text type="secondary">
                Pitch extractor: {pitch.extractor ?? "(unknown)"}
              </Typography.Text>
              <PitchAlignmentChart analysis={pitch} words={accentWords} />
            </>
          )}
        </div>
      )}

      <Typography.Text type="secondary">Model status: {status}</Typography.Text>

      {status === "downloading" && (
        <Typography.Text type="secondary">
          Downloading model… {progress ?? 0}%
        </Typography.Text>
      )}
    </>
  );
}
