import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { documentDir, join, videoDir } from "@tauri-apps/api/path";
import {
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  writeFile,
} from "@tauri-apps/plugin-fs";
import { message, Modal } from "antd";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { SentenceAttribution } from "../../components/ExampleList";
import { formatTatoebaCreditText } from "../../utils/formatTatoebaCreditText";
import {
  buildPitchAlignmentChartSvg,
  type PitchChartSvgOptions,
  type PitchChartSvgResult,
} from "../../components/PitchAlignmentChart";
import type { Recording } from "../../types/recording";
import type { SourceKind } from "../../types/speech";
import type { WordPitch } from "../../types/pitch";

type AccentOut = {
  words: WordPitch[];
};

const makeSafeVideoBaseName = (text: string) => {
  const raw = (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/g, "");
  const base = raw || "falkoe";

  // Preserve readability while avoiding Windows-illegal filename characters.
  // Convert these to fullwidth instead of '_' so the name looks natural.
  const mapped = base
    .replace(/\\/g, "＼")
    .replace(/\//g, "／")
    .replace(/:/g, "：")
    .replace(/\*/g, "＊")
    .replace(/\?/g, "？")
    .replace(/"/g, "＂")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/\|/g, "｜")
    .replace(/'/g, "’");

  // Keep it reasonably short for cross-platform compatibility.
  return mapped.length > 80 ? mapped.slice(0, 80).trim() : mapped;
};

const isJapanese = (lang?: string | null) => {
  const l = (lang ?? "").toLowerCase();
  return l === "jpn" || l === "ja" || l.startsWith("ja-");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitForFile = async (path: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await exists(path)) return true;
    } catch {
      // ignore
    }
    await sleep(200);
  }
  return false;
};

const waitForJsonFile = async <T>(
  path: string,
  timeoutMs: number,
): Promise<T | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (!(await exists(path))) {
        await sleep(200);
        continue;
      }
      const txt = await readTextFile(path);
      return JSON.parse(txt) as T;
    } catch {
      // file may be mid-write; retry
      await sleep(200);
    }
  }
  return null;
};

const loadAccentWordsIfAny = async (accentPath: string) => {
  try {
    if (!(await exists(accentPath))) return null;
    const txt = await readTextFile(accentPath);
    const parsed = JSON.parse(txt) as AccentOut;
    return parsed.words ?? null;
  } catch {
    return null;
  }
};

const pickFirstExisting = async (paths: string[]) => {
  for (const p of paths) {
    try {
      if (await exists(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
};

const confirmExportWithMissingTranscripts = (
  t: TFunction,
): Promise<boolean> => {
  return new Promise((resolve) => {
    Modal.confirm({
      title: t("screens.recorder.export.confirmMissingTranscripts.title"),
      content: t("screens.recorder.export.confirmMissingTranscripts.content"),
      okText: t("screens.recorder.export.confirmMissingTranscripts.ok"),
      cancelText: t("screens.recorder.export.confirmMissingTranscripts.cancel"),
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
};

const confirmCreateMissingReferenceAudio = (
  t: TFunction,
  kind: "model" | "uploaded",
): Promise<boolean> => {
  return new Promise((resolve) => {
    const titleKey =
      kind === "model"
        ? "screens.recorder.export.confirmCreateModelAudio.title"
        : "screens.recorder.export.confirmCreateUploadedAudio.title";
    const contentKey =
      kind === "model"
        ? "screens.recorder.export.confirmCreateModelAudio.content"
        : "screens.recorder.export.confirmCreateUploadedAudio.content";
    const okKey =
      kind === "model"
        ? "screens.recorder.export.confirmCreateModelAudio.ok"
        : "screens.recorder.export.confirmCreateUploadedAudio.ok";
    const cancelKey =
      kind === "model"
        ? "screens.recorder.export.confirmCreateModelAudio.cancel"
        : "screens.recorder.export.confirmCreateUploadedAudio.cancel";

    Modal.confirm({
      title: t(titleKey),
      content: t(contentKey),
      okText: t(okKey),
      cancelText: t(cancelKey),
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
};

const renderSvgToPngFile = async (
  svgResult: PitchChartSvgResult,
  outPath: string,
) => {
  const blob = new Blob([svgResult.svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("failed to load svg"));
    });
    img.src = url;
    await loaded;

    const canvas = document.createElement("canvas");
    canvas.width = svgResult.renderWidthPx;
    canvas.height = svgResult.renderHeightPx;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas context");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (!b) reject(new Error("failed to encode png"));
        else resolve(b);
      }, "image/png");
    });

    const bytes = new Uint8Array(await pngBlob.arrayBuffer());
    await writeFile(outPath, bytes);
  } finally {
    URL.revokeObjectURL(url);
  }
};

export function useExportVideo(params: {
  sentenceHash: string;
  sentenceText: string;
  sentenceLang: string;
  sentenceAudioUrl: string;
  sentenceAttribution?: SentenceAttribution | null | undefined;
  sourceKind: SourceKind;
  uploadedAudioPath: string | null;
  recordings: Recording[];
  transcripts: Record<string, any>;
  token: PitchChartSvgOptions["token"];
  recognizeModel: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const {
    sentenceHash,
    sentenceText,
    sentenceLang,
    sentenceAudioUrl,
    sentenceAttribution,
    sourceKind,
    uploadedAudioPath,
    recordings,
    transcripts,
    token,
    recognizeModel,
  } = params;

  const [isExportingVideo, setIsExportingVideo] = useState(false);

  const handleExportVideo = useCallback(async () => {
    if (isExportingVideo) return;
    setIsExportingVideo(true);

    let tmpBase: string | null = null;

    const tryRemoveEmptyDir = async (path: string) => {
      try {
        if (!(await exists(path))) return;
        const entries = await readDir(path);
        if (!entries || entries.length !== 0) return;
        await remove(path);
      } catch {
        // ignore
      }
    };

    const cleanupVideoTmp = async () => {
      try {
        const doc = await documentDir();
        const falkoeDir = await join(doc, "falkoe");

        // Remove our temp base (PNG renders etc.).
        if (tmpBase && (await exists(tmpBase))) {
          await remove(tmpBase, { recursive: true });
        }

        // Best-effort remove empty parents.
        const hashRoot = await join(falkoeDir, "tmp", "video", sentenceHash);
        await tryRemoveEmptyDir(hashRoot);
        await tryRemoveEmptyDir(await join(falkoeDir, "tmp", "video"));
        await tryRemoveEmptyDir(await join(falkoeDir, "tmp"));

        // Legacy cleanup: older versions accidentally created
        // $DOCUMENTS/falkoe/<sentenceHash>/tmp/video/... .
        const legacyHashRoot = await join(falkoeDir, sentenceHash);
        const legacyProbe = await join(legacyHashRoot, "tmp", "video");
        if ((await exists(legacyHashRoot)) && (await exists(legacyProbe))) {
          await remove(legacyHashRoot, { recursive: true });
        }
      } catch {
        // ignore
      }
    };

    try {
      // Put temp artifacts under $DOCUMENTS/falkoe/tmp/video/... (NOT under $DOCUMENTS/falkoe/<sentenceHash>/...).
      // This keeps the Documents/falkoe root clean.
      const baseDir = await join(
        "tmp",
        "video",
        sentenceHash,
        String(Date.now()),
      );

      tmpBase = await join(await documentDir(), "falkoe", baseDir);
      if (!(await exists(tmpBase))) {
        await mkdir(tmpBase, { recursive: true });
      }

      const segments: Array<{
        label: string;
        wavPath: string;
        transcriptJsonPath: string | null;
        pitchJsonPath: string;
        chartPngPath: string;
        chartWidthPx: number;
        chartHeightPx: number;
        viewBoxW: number;
        viewBoxH: number;
        padX: number;
        padY: number;
        plotW: number;
        plotH: number;
      }> = [];

      const sentenceDir = await join(
        await documentDir(),
        "falkoe",
        "sentences",
        sentenceHash,
      );

      const refSubdir = sourceKind === "uploaded" ? "uploaded" : "model";
      const refWav = await join(
        sentenceDir,
        refSubdir,
        sourceKind === "uploaded" ? "uploaded.wav" : "model.wav",
      );
      const refTranscript = await join(
        sentenceDir,
        refSubdir,
        sourceKind === "uploaded" ? "uploaded.json" : "model.json",
      );
      const refTranscriptAlt = await join(
        sentenceDir,
        refSubdir,
        "transcript.json",
      );
      const refPitch = await join(
        sentenceDir,
        refSubdir,
        sourceKind === "uploaded" ? "uploaded.pitch.json" : "model.pitch.json",
      );

      const refAccent = await join(
        sentenceDir,
        refSubdir,
        sourceKind === "uploaded"
          ? "uploaded.accent.json"
          : "model.accent.json",
      );

      const ensureReferenceAnalyzed = async () => {
        // Simulate pressing the "模範音声を音声認識する" button:
        // reuse the same handler so UI state (spinner etc.) behaves consistently.
        // Note: the actual whisper work happens in background; we wait on output files below.

        if (sourceKind === "uploaded") {
          if (!uploadedAudioPath) {
            throw new Error(t("screens.recorder.export.missingUploadedPath"));
          }
        } else {
          if (!sentenceAudioUrl) {
            throw new Error(t("screens.recorder.export.missingModelUrl"));
          }
        }

        const wavExists = await exists(refWav);
        const transcriptCandidateExists = await exists(refTranscript);
        const pitchCandidateExists = await exists(refPitch);

        const transcriptOk = transcriptCandidateExists
          ? Boolean(await waitForJsonFile<any>(refTranscript, 1500))
          : false;
        const pitchOk = pitchCandidateExists
          ? Boolean(await waitForJsonFile<any>(refPitch, 1500))
          : false;

        const shouldRun = !wavExists || !pitchOk || !transcriptOk;
        if (shouldRun) {
          await recognizeModel();
        }

        // Wait for required artifacts. Pitch is required for chart generation.
        const wavReady = await waitForFile(refWav, 120_000);
        const pitchJson = await waitForJsonFile<any>(refPitch, 120_000);
        if (!wavReady || !pitchJson) {
          throw new Error(
            t("screens.recorder.export.referenceAnalysisTimeout"),
          );
        }

        // Transcript is optional (subtitles are optional in the video pipeline).
        const transcriptJson = await waitForJsonFile<any>(refTranscript, 5000);

        return { transcriptJson, pitchJson };
      };

      // Reference segment (model/uploaded)
      if (!(await exists(refWav))) {
        const ok = await confirmCreateMissingReferenceAudio(
          t,
          sourceKind === "uploaded" ? "uploaded" : "model",
        );
        if (!ok) return;
      }

      const { pitchJson: refPitchAnalysis } = await ensureReferenceAnalyzed();
      const refAccentWords = isJapanese(sentenceLang)
        ? await loadAccentWordsIfAny(refAccent)
        : null;

      const refTranscriptPicked0 = await pickFirstExisting([
        refTranscript,
        refTranscriptAlt,
      ]);
      const refTranscriptPicked = refTranscriptPicked0
        ? (await waitForJsonFile<any>(refTranscriptPicked0, 1500))
          ? refTranscriptPicked0
          : null
        : null;

      const refSvgRes = buildPitchAlignmentChartSvg({
        analysis: refPitchAnalysis,
        words: refAccentWords ?? undefined,
        height: 320,
        showLabels: isJapanese(sentenceLang) && sourceKind !== "uploaded",
        renderMode: "video",
        maxRenderWidthPx: 12000,
        token,
      });
      const refOutPng = await join(tmpBase, "ref.png");
      await renderSvgToPngFile(refSvgRes, refOutPng);
      segments.push({
        label: sourceKind === "uploaded" ? "Upload" : "Model",
        wavPath: refWav,
        transcriptJsonPath: refTranscriptPicked,
        pitchJsonPath: refPitch,
        chartPngPath: refOutPng,
        chartWidthPx: refSvgRes.renderWidthPx,
        chartHeightPx: refSvgRes.renderHeightPx,
        viewBoxW: refSvgRes.viewBoxW,
        viewBoxH: refSvgRes.viewBoxH,
        padX: refSvgRes.padX,
        padY: refSvgRes.padY,
        plotW: refSvgRes.plotW,
        plotH: refSvgRes.plotH,
      });

      // Takes
      const recognizedRecs = recordings.filter((r) => {
        const t = transcripts[r.path];
        return t && t.segments && t.segments.length > 0;
      });

      const missingTranscriptCount = Math.max(
        0,
        recordings.length - recognizedRecs.length,
      );

      if (missingTranscriptCount > 0) {
        const ok = await confirmExportWithMissingTranscripts(t);
        if (!ok) return;
      }

      // recordings are sorted newest-first; export should be oldest-first
      // so Take 1 corresponds to the first recording.
      const doneRecs = recognizedRecs.slice().reverse();

      for (let i = 0; i < doneRecs.length; i++) {
        const rec = doneRecs[i];
        const pitchPath = rec.path.replace(/\.wav$/i, ".pitch.json");
        const accentPath = rec.path.replace(/\.wav$/i, ".accent.json");
        let pitchAnalysis: any;
        try {
          pitchAnalysis = JSON.parse(await readTextFile(pitchPath));
        } catch {
          pitchAnalysis = await invoke("analyze_pitch", {
            wavPath: rec.path,
            includeSegments: true,
          });
          await writeFile(
            pitchPath,
            new TextEncoder().encode(JSON.stringify(pitchAnalysis, null, 2)),
          );
        }

        const accentWords = isJapanese(sentenceLang)
          ? await loadAccentWordsIfAny(accentPath)
          : null;

        const svgRes = buildPitchAlignmentChartSvg({
          analysis: pitchAnalysis,
          words: accentWords ?? undefined,
          height: 320,
          showLabels: isJapanese(sentenceLang),
          renderMode: "video",
          maxRenderWidthPx: 12000,
          token,
        });
        const outPng = await join(tmpBase, `take_${i + 1}.png`);
        await renderSvgToPngFile(svgRes, outPng);

        const transcriptPath = rec.path.replace(/\.wav$/i, ".json");

        segments.push({
          label: `Take ${i + 1}`,
          wavPath: rec.path,
          transcriptJsonPath: (await waitForJsonFile<any>(transcriptPath, 1500))
            ? transcriptPath
            : null,
          pitchJsonPath: pitchPath,
          chartPngPath: outPng,
          chartWidthPx: svgRes.renderWidthPx,
          chartHeightPx: svgRes.renderHeightPx,
          viewBoxW: svgRes.viewBoxW,
          viewBoxH: svgRes.viewBoxH,
          padX: svgRes.padX,
          padY: svgRes.padY,
          plotW: svgRes.plotW,
          plotH: svgRes.plotH,
        });
      }

      if (segments.length === 0) {
        message.warning(t("screens.recorder.messages.exportNoSegments"));
        return;
      }

      const creditText =
        sentenceAttribution?.provider === "tatoeba"
          ? formatTatoebaCreditText(sentenceAttribution, t)
              .split(" / ")
              .join("\n")
          : null;

      const outDir = await videoDir();
      const outBase = `Falkoe_${makeSafeVideoBaseName(sentenceText)}`;
      const outPath = await invoke<string>("export_practice_video", {
        outputDir: outDir,
        outputBase: outBase,
        modelText: sentenceText,
        creditText,
        segments,
      });

      message.success(`${t("screens.recorder.messages.videoSaved")}${outPath}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
      message.error(
        `${t("screens.recorder.messages.videoCreateFailed")}${String(e)}`,
      );
    } finally {
      await cleanupVideoTmp();
      setIsExportingVideo(false);
    }
  }, [
    isExportingVideo,
    recordings,
    recognizeModel,
    sentenceAudioUrl,
    sentenceHash,
    sentenceLang,
    sentenceText,
    sentenceAttribution,
    sourceKind,
    t,
    token,
    transcripts,
    uploadedAudioPath,
  ]);

  return { handleExportVideo, isExportingVideo };
}
