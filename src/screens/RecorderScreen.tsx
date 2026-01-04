import { useEffect, useRef, useState } from "react";
import { Button, message, Space, theme, Row, Col, Modal } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { documentDir, join, videoDir } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { useAudioUrlCache } from "./recorder/useAudioUrlCache";
import { useHeaderAudioUrl } from "./recorder/useHeaderAudioUrl";
import { useModelStatus } from "./recorder/useModelStatus";
import { loadTranscript } from "./recorder/transcriptUtils";
import type { DisplayMode } from "../types/linking";
import { unlockAudioFromUserGesture } from "../utils/ipaPlayer";
import TopNav from "../components/TopNav";
import {
  buildPitchAlignmentChartSvg,
  type PitchChartSvgResult,
} from "../components/PitchAlignmentChart";
import type { Recording } from "../types/recording";
import type { SpeechSource } from "../types/speech";
import type { ModelStatus } from "../types/model";
import { useWhisperEvents } from "./recorder/useWhisperEvents";
import { useRecordingControls } from "./recorder/useRecordingControls";
import { useModelRecognition } from "./recorder/useModelRecognition";
import { useAddToAnki } from "./recorder/useAddToAnki";
import { useAutoTranscribeUploaded } from "./recorder/useAutoTranscribeUploaded";
import { useLoadRecordingsTranscripts } from "./recorder/useLoadRecordingsTranscripts";
import { useModelTranscriptLoader } from "./recorder/useModelTranscriptLoader";
import { RecorderHeader } from "./recorder/components/RecorderHeader";
import { ModelTranscriptSection } from "./recorder/components/ModelTranscriptSection";
import { RecordingControls } from "./recorder/components/RecordingControls";
import { RecordingsSection } from "./recorder/components/RecordingsSection";
import { useSentenceContext } from "./recorder/useSentenceContext";
import { useShadowingRecorder } from "./recorder/useShadowingRecorder";
import { useTranscriptionCompletion } from "./recorder/useTranscriptionCompletion";
import { usePreferAssetProtocol } from "./recorder/usePreferAssetProtocol";
import { useIpaIndex } from "./recorder/useIpaIndex";
import { useLinkingResult } from "./recorder/useLinkingResult";
import { useRecordingsState } from "./recorder/useRecordingsState";
import { useModelUiState } from "./recorder/useModelUiState";
import { useSafeNavigation } from "./recorder/useSafeNavigation";

type RecorderScreenProps = {
  source: SpeechSource;
  onBack: () => void;
  onOpenHistory: () => void;
  onOpenIpaList: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

const RecorderScreen = ({
  source,
  onBack,
  onOpenHistory,
  onOpenIpaList,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: RecorderScreenProps) => {
  const { token } = theme.useToken();
  const preferAssetProtocol = usePreferAssetProtocol();

  const {
    sourceKind,
    sentenceHash,
    sentence,
    uploadedAudioPath,
    hasUploadedFile,
  } = useSentenceContext(source);

  // Persist/ensure manifest.json so the History screen can list this sentence reliably.
  useEffect(() => {
    const text = sentence.text?.trim() ?? "";
    const lang = sentence.lang?.trim() ?? "";
    if (!sentenceHash || !text || !lang) return;

    invoke("upsert_sentence_manifest_text", {
      audioId: sentenceHash,
      lang,
      text,
      overwrite: false,
    }).catch(() => {
      // Non-fatal: history listing will just be less informative.
    });
  }, [sentenceHash, sentence.text, sentence.lang]);

  const {
    recordings,
    transcripts,
    recognizing,
    setRecognizing,
    setTranscripts,
    refreshFiles,
  } = useRecordingsState(sentenceHash);

  const {
    modelText,
    waitingModel,
    isTranscribing,
    setModelText,
    setWaitingModel,
    setIsTranscribing,
    resetModelUiState,
  } = useModelUiState(sentenceHash);

  const { status, progress }: { status: ModelStatus; progress: number | null } =
    useModelStatus();

  const [displayText, setDisplayText] = useState<string>(sentence.text);
  const [linkingDisplayMode, setLinkingDisplayMode] =
    useState<DisplayMode>("phoneme");
  const ipaIndex = useIpaIndex();
  const audioUnlockTriedRef = useRef(false);

  const { audioUrls, ensureBlobAudioUrl, toAssetUrl, resetAudioUrls } =
    useAudioUrlCache();

  const { headerAudioUrl, isHeaderAudioLoading } = useHeaderAudioUrl({
    sourceKind,
    sentenceAudioUrl: sentence.audioUrl,
    sentenceHash,
    uploadedAudioPath,
    preferAssetProtocol,
    ensureBlobAudioUrl,
    toAssetUrl,
    hasUploadedFile,
  });

  useEffect(() => {
    setDisplayText(sentence.text);
  }, [sentence.text]);

  const linkingResult = useLinkingResult({
    displayText,
    sentenceText: sentence.text,
    lang: sentence.lang,
    linkingDisplayMode,
  });

  useEffect(() => {
    resetModelUiState();
    resetAudioUrls();
  }, [sentenceHash, resetAudioUrls, resetModelUiState]);

  useAutoTranscribeUploaded({
    sourceKind,
    sentenceText: sentence.text,
    uploadedAudioPath,
    status,
    sentenceHash,
    lang: sentence.lang,
    setDisplayText,
    setIsTranscribing: (v) => setIsTranscribing(v),
  });

  const { isRecording, startRecording, stopRecording } = useRecordingControls({
    sentenceHash,
    lang: sentence.lang,
    refreshFiles,
    setRecognizing,
    setTranscripts,
    setIsTranscribing,
  });

  const shadowingRecorder = useShadowingRecorder({
    isRecording,
    startRecording,
    stopRecording,
    status,
    headerAudioUrl,
    isHeaderAudioLoading,
  });

  const { navigateSafely } = useSafeNavigation({
    beforeNavigate: async () => {
      if (!shadowingRecorder.isRecording) return;
      await shadowingRecorder.stop();
    },
  });

  const { recognizeModel, disabled: modelRecognizeDisabled } =
    useModelRecognition({
      sourceKind,
      uploadedAudioPath,
      sentenceHash,
      lang: sentence.lang,
      sentenceAudioUrl: sentence.audioUrl,
      waitingModel,
      modelText,
      setModelText,
      setWaitingModel,
      setIsTranscribing,
    });

  const { addToAnki } = useAddToAnki({
    sourceKind,
    sentence,
    sentenceHash,
    uploadedAudioPath,
    displayText,
  });

  useWhisperEvents({
    sentenceId: sentence.id,
    sourceKind,
    sentenceText: sentence.text,
    waitingModel,
    loadTranscript,
    setWaitingModel: (v) => setWaitingModel(v),
    setIsTranscribing: (v) => setIsTranscribing(v),
    setModelText: (v) => setModelText(v),
    setDisplayText,
    setRecognizing,
    setTranscripts,
  });

  const recognizeRecording = async (rec: Recording) => {
    if (status !== "ready") return;
    if (recognizing[rec.path]) return;

    setRecognizing((prev) => ({ ...prev, [rec.path]: true }));
    setIsTranscribing(true);
    try {
      await invoke("run_whisper", {
        path: rec.path,
        sentenceHash: sentenceHash,
        lang: sentence.lang,
      });
    } catch (e) {
      setRecognizing((prev) => {
        const next = { ...prev };
        delete next[rec.path];
        return next;
      });
      setIsTranscribing(false);
      message.error("音声認識の開始に失敗しました: " + String(e));
    }
  };

  useLoadRecordingsTranscripts({
    recordings,
    transcripts,
    setTranscripts,
    recognizing,
  });

  const { showModelAreaTranscribing, autoRecognizingUploaded } =
    useTranscriptionCompletion({
      sourceKind,
      sentenceText: sentence.text,
      displayText,
      modelText,
      isTranscribing,
      waitingModel,
      recognizing,
      transcripts,
      setRecognizing,
      setIsTranscribing: (v) => setIsTranscribing(v),
      setDisplayText,
    });

  useModelTranscriptLoader({
    sentenceHash,
    sourceKind,
    uploadedAudioPath,
    waitingModel,
    setModelText: (v) => setModelText(v),
  });

  const [isExportingVideo, setIsExportingVideo] = useState(false);

  const makeSafeVideoBaseName = (text: string) => {
    const raw = (text ?? "").trim();
    const replaced = raw
      .replace(/[\\/\?%\*:|"<>]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.\s]+$/g, "");
    const base = replaced || "falkoe";
    // Keep it reasonably short for cross-platform compatibility.
    return base.length > 80 ? base.slice(0, 80).trim() : base;
  };

  const isJapanese = (lang?: string | null) => {
    const l = (lang ?? "").toLowerCase();
    return l === "jpn" || l === "ja" || l.startsWith("ja-");
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

  const waitForJsonFile = async <T,>(
    path: string,
    timeoutMs: number
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

  const confirmExportWithMissingTranscripts = (
    missingCount: number
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      Modal.confirm({
        title: "音声認識されていない録音があります",
        content: `音声認識されていない録音が ${missingCount} 件あります。未認識の録音は動画から除外されます。それでも実行しますか？`,
        okText: "実行する",
        cancelText: "キャンセル",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  };

  const confirmCreateMissingReferenceAudio = (
    kind: "model" | "uploaded"
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      const title =
        kind === "model"
          ? "model音声がありません"
          : "アップロード音声がありません";
      const content =
        kind === "model"
          ? "model音声がありませんので作成します。作成してから動画作成を続けますか？"
          : "アップロード音声(wav)がありませんので作成します。作成してから動画作成を続けますか？";
      Modal.confirm({
        title,
        content,
        okText: "作成して続行",
        cancelText: "キャンセル",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  };

  const renderSvgToPngFile = async (
    svgResult: PitchChartSvgResult,
    outPath: string
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

  const handleExportVideo = async () => {
    if (isExportingVideo) return;
    setIsExportingVideo(true);
    try {
      const baseDir = await join(
        sentenceHash,
        "tmp",
        "video",
        String(Date.now())
      );

      // Put temp artifacts under $DOCUMENTS/falkoe/tmp/video/... to keep Videos clean.
      const tmpBase = await join(await documentDir(), "falkoe", baseDir);
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
        sentenceHash
      );

      const refSubdir = sourceKind === "uploaded" ? "uploaded" : "model";
      const refWav = await join(
        sentenceDir,
        refSubdir,
        sourceKind === "uploaded" ? "uploaded.wav" : "model.wav"
      );
      const refTranscript = await join(
        sentenceDir,
        refSubdir,
        sourceKind === "uploaded" ? "uploaded.json" : "model.json"
      );
      const refTranscriptAlt = await join(
        sentenceDir,
        refSubdir,
        "transcript.json"
      );
      const refPitch = await join(
        sentenceDir,
        refSubdir,
        sourceKind === "uploaded" ? "uploaded.pitch.json" : "model.pitch.json"
      );

      const ensureReferenceAnalyzed = async () => {
        // Simulate pressing the "模範音声を音声認識する" button:
        // reuse the same handler so UI state (spinner etc.) behaves consistently.
        // Note: the actual whisper work happens in background; we wait on output files below.

        if (sourceKind === "uploaded") {
          if (!uploadedAudioPath) {
            throw new Error(
              "アップロード音声の作成に必要なパスが見つかりません。"
            );
          }
        } else {
          if (!sentence.audioUrl) {
            throw new Error("model音声のURLが見つかりません。");
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
            "参照音声の解析が完了しませんでした（音声認識/ピッチ解析）。もう一度お試しください。"
          );
        }

        // Transcript is optional (subtitles are optional in the video pipeline).
        const transcriptJson = await waitForJsonFile<any>(refTranscript, 5000);

        return { transcriptJson, pitchJson };
      };

      // Reference segment (model/uploaded)
      if (!(await exists(refWav))) {
        const ok = await confirmCreateMissingReferenceAudio(
          sourceKind === "uploaded" ? "uploaded" : "model"
        );
        if (!ok) return;
      }

      const { pitchJson: refPitchAnalysis } = await ensureReferenceAnalyzed();

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
        height: 320,
        showLabels: isJapanese(sentence.lang) && sourceKind !== "uploaded",
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
        recordings.length - recognizedRecs.length
      );

      if (missingTranscriptCount > 0) {
        const ok = await confirmExportWithMissingTranscripts(
          missingTranscriptCount
        );
        if (!ok) return;
      }

      // recordings are sorted newest-first; export should be oldest-first
      // so Take 1 corresponds to the first recording.
      const doneRecs = recognizedRecs.slice().reverse();

      for (let i = 0; i < doneRecs.length; i++) {
        const rec = doneRecs[i];
        const pitchPath = rec.path.replace(/\.wav$/i, ".pitch.json");
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
            new TextEncoder().encode(JSON.stringify(pitchAnalysis, null, 2))
          );
        }

        const svgRes = buildPitchAlignmentChartSvg({
          analysis: pitchAnalysis,
          height: 320,
          showLabels: isJapanese(sentence.lang),
          token,
        });
        const outPng = await join(tmpBase, `take_${i + 1}.png`);
        await renderSvgToPngFile(svgRes, outPng);

        segments.push({
          label: `Take ${i + 1}`,
          wavPath: rec.path,
          transcriptJsonPath: (await waitForJsonFile<any>(
            rec.path.replace(/\.wav$/i, ".json"),
            1500
          ))
            ? rec.path.replace(/\.wav$/i, ".json")
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
        message.warning(
          "動画に入れるデータがありません（認識済みの録音が必要です）"
        );
        return;
      }

      const outDir = await videoDir();
      const outBase = `Falkoe_${makeSafeVideoBaseName(sentence.text)}`;
      const outPath = await invoke<string>("export_practice_video", {
        outputDir: outDir,
        outputBase: outBase,
        modelText: sentence.text,
        segments,
      });

      message.success("ビデオに保存しました: " + outPath);
    } catch (e) {
      console.error(e);
      message.error("動画の作成に失敗しました: " + String(e));
    } finally {
      setIsExportingVideo(false);
    }
  };

  return (
    <div
      onPointerDown={() => {
        if (audioUnlockTriedRef.current) return;
        audioUnlockTriedRef.current = true;
        void unlockAudioFromUserGesture().catch(() => {});
      }}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <TopNav
          current="record"
          onBack={onBack ? () => navigateSafely(onBack) : undefined}
          onOpenHistory={() => navigateSafely(onOpenHistory)}
          onOpenIpaList={() => navigateSafely(onOpenIpaList)}
          onOpenDevelopersMistakes={() =>
            navigateSafely(onOpenDevelopersMistakes)
          }
          onOpenCommonMistakes={() => navigateSafely(onOpenCommonMistakes)}
        />

        <RecorderHeader
          headerAudioUrl={headerAudioUrl}
          isHeaderAudioLoading={isHeaderAudioLoading}
          displayText={displayText}
          sentenceText={sentence.text}
          onRecognizeModel={recognizeModel}
          waitingModel={waitingModel}
          autoRecognizingUploaded={autoRecognizingUploaded}
          modelRecognizeDisabled={modelRecognizeDisabled}
          sourceKind={sourceKind}
        />
        <Row align="top" gutter={12}>
          <Col flex="auto">
            <ModelTranscriptSection
              isTranscribing={showModelAreaTranscribing}
              modelText={modelText}
              sentenceHash={sentenceHash}
              lang={sentence.lang}
              modelAudioUrl={headerAudioUrl}
              linkingResult={linkingResult}
              linkingDisplayMode={linkingDisplayMode}
              setLinkingDisplayMode={setLinkingDisplayMode}
              ipaIndex={ipaIndex}
              status={status}
              progress={progress}
            />
          </Col>

          <Col>
            <Button
              onClick={handleExportVideo}
              loading={isExportingVideo}
              disabled={isExportingVideo}
            >
              動画を作成（mp4）
            </Button>
          </Col>
        </Row>

        <RecordingControls
          isRecording={isRecording}
          status={status}
          onMimic={() => shadowingRecorder.start({ mode: "mimic" })}
          mimicLoading={shadowingRecorder.isMimicLoading}
          mimicDisabled={!headerAudioUrl || isHeaderAudioLoading}
          onStartRecording={() => shadowingRecorder.start()}
          onStopRecording={shadowingRecorder.stop}
          autoStopRemainingMs={shadowingRecorder.autoStopRemainingMs}
        />

        <RecordingsSection
          recordings={recordings}
          transcripts={transcripts}
          recognizing={recognizing}
          recognizeRecording={recognizeRecording}
          audioUrls={audioUrls}
          preferAssetProtocol={preferAssetProtocol}
          toAssetUrl={toAssetUrl}
          ensureBlobAudioUrl={ensureBlobAudioUrl}
          addToAnki={addToAnki}
          lang={sentence.lang}
        />
      </Space>
    </div>
  );
};
export default RecorderScreen;
