import { useEffect, useState, useRef } from "react";
import { Button, message, Space, Spin, Typography, theme } from "antd";
import { invoke } from "@tauri-apps/api/core";
import type { Sentence } from "../components/ExampleList";
import { sha256 } from "../utils/hash";
import { useAudioUrlCache } from "./recorder/useAudioUrlCache";
import { useHeaderAudioUrl } from "./recorder/useHeaderAudioUrl";
import { useModelStatus } from "./recorder/useModelStatus";
import {
  loadModelTranscript,
  loadTranscript,
  loadUploadedTranscript,
  parseRecording,
} from "./recorder/transcriptUtils";
import HeaderAudioPlayButton from "./recorder/HeaderAudioPlayButton";
import { renderLinkingRust } from "../utils/linkingInvoke";
import type { RenderLinkingResult, DisplayMode } from "../types/linking";
import { loadIpaIndex, type IpaIndex } from "../utils/ipaResources";
import { unlockAudioFromUserGesture } from "../utils/ipaPlayer";
import TopNav from "../components/TopNav";
import RecordingsList from "../components/RecordingsList";
import type { Recording, Transcript } from "../types/recording";
import LinkingStressArea from "./recorder/LinkingStressArea";
import { useWhisperEvents } from "./recorder/useWhisperEvents";
import { useRecordingControls } from "./recorder/useRecordingControls";
import { useModelRecognition } from "./recorder/useModelRecognition";
import { useAddToAnki } from "./recorder/useAddToAnki";
import { useUploadedAudio } from "./recorder/useUploadedAudio";

type RecorderScreenProps = {
  source: any;
  onBack: () => void;
  onOpenIpaList: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

const RecorderScreen = ({
  source,
  onBack,
  onOpenIpaList,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: RecorderScreenProps) => {
  theme.useToken();
  const isLinux = (() => {
    const ua =
      typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : "";
    const plat =
      typeof navigator !== "undefined"
        ? ((navigator as any).platform ?? "")
        : "";
    return /Linux/i.test(ua) || /Linux/i.test(String(plat));
  })();
  const preferAssetProtocol = !isLinux;

  const [sentenceHash, setSentenceHash] = useState<string>("");

  const sentenceTextForHash: string = (() => {
    switch (source.kind) {
      case "tatoeba":
        return source.sentence?.text ?? "";
      case "uploaded":
      case "recorded":
        return source.text ?? "";
      default:
        return "";
    }
  })();

  const sentenceLangForHash: string = (() => {
    switch (source.kind) {
      case "tatoeba":
        return source.sentence?.lang ?? "";
      case "uploaded":
      case "recorded":
        return source.lang ?? "";
      default:
        return "";
    }
  })();

  const { uploadedFileAudioUrl, uploadedAudioPath } = useUploadedAudio({
    source,
    sentenceHash,
    sentenceText: sentenceTextForHash,
    lang: sentenceLangForHash,
  });

  const sentence: Sentence = (() => {
    switch (source.kind) {
      case "tatoeba":
        return source.sentence;
      case "uploaded":
        return {
          id: hashText(source.text ?? "uploaded"),
          text: source.text ?? "",
          audioUrl: source.file ? uploadedFileAudioUrl : "",
          lang: source.lang,
        };
      case "recorded":
        return {
          id: hashText(source.text ?? "recorded"),
          text: source.text ?? "",
          audioUrl: source.filePath,
          lang: source.lang,
        };
    }
  })();

  useEffect(() => {
    if (source.kind === "uploaded" && source.sentenceHash) {
      setSentenceHash(source.sentenceHash);
      return;
    }
    sha256(sentenceTextForHash, sentenceLangForHash).then(setSentenceHash);
  }, [source, sentenceTextForHash, sentenceLangForHash]);

  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [transcripts, setTranscripts] = useState<
    Record<string, Transcript | null>
  >({});
  const { status, progress } = useModelStatus();
  const [modelText, setModelText] = useState<string | null>(null);
  const [waitingModel, setWaitingModel] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recognizing, setRecognizing] = useState<Record<string, boolean>>({});
  const [displayText, setDisplayText] = useState<string>(sentence.text);
  const [linkingResult, setLinkingResult] =
    useState<RenderLinkingResult | null>(null);
  const [linkingDisplayMode, setLinkingDisplayMode] =
    useState<DisplayMode>("phoneme");
  const [ipaIndex, setIpaIndex] = useState<IpaIndex | null>(null);
  const audioUnlockTriedRef = useRef(false);

  useEffect(() => {
    loadIpaIndex()
      .then((idx) => {
        setIpaIndex(idx);
      })
      .catch((e) => {
        setIpaIndex(null);
        const msg = String((e as any)?.message ?? e);
        message.error(`IPA index 読み込み失敗: ${msg}`);
      });
  }, []);

  const autoStartedRef = useRef(false);
  const { audioUrls, ensureBlobAudioUrl, toAssetUrl, resetAudioUrls } =
    useAudioUrlCache();

  const { headerAudioUrl, isHeaderAudioLoading } = useHeaderAudioUrl({
    sourceKind: source.kind,
    sentenceAudioUrl: sentence.audioUrl,
    uploadedAudioPath,
    preferAssetProtocol,
    ensureBlobAudioUrl,
    toAssetUrl,
    hasUploadedFile: source.kind === "uploaded" && Boolean(source.file),
  });

  useEffect(() => {
    setDisplayText(sentence.text);
  }, [sentence.text]);

  useEffect(() => {
    const text = (displayText || sentence.text || "").trim();
    if (!text || sentence.lang !== "eng") {
      setLinkingResult(null);
      return;
    }

    let cancelled = false;

    renderLinkingRust(text, {
      linkingMode: true,
      displayMode: linkingDisplayMode,
      useDict: true,
    })
      .then((res) => {
        if (cancelled) return;
        setLinkingResult(res);
      })
      .catch((e) => {
        console.warn("render_linking failed", e);
        if (cancelled) return;
        setLinkingResult(null);
      });

    return () => {
      cancelled = true;
    };
  }, [displayText, sentence.text, sentence.lang, linkingDisplayMode]);

  useEffect(() => {
    setRecordings([]);
    setTranscripts({});
    setModelText(null);
    setWaitingModel(false);
    resetAudioUrls();
    autoStartedRef.current = false;
    refreshFiles();
  }, [sentenceHash]);

  useEffect(() => {
    if (
      source.kind !== "uploaded" ||
      !(!sentence.text || sentence.text.trim() === "") ||
      !uploadedAudioPath ||
      status !== "ready" ||
      autoStartedRef.current
    ) {
      return;
    }

    autoStartedRef.current = true;

    let cancelled = false;

    const run = async () => {
      const cached = await loadUploadedTranscript(uploadedAudioPath);
      if (cancelled) return;
      if (cached) {
        const joined = cached.segments
          .map((s) => s.text)
          .join(" ")
          .trim();
        setDisplayText((prev) => prev || joined);
        return;
      }

      invoke("run_whisper_uploaded", {
        uploadedPath: uploadedAudioPath,
        sentenceHash: sentenceHash,
        lang: sentence.lang,
      });

      setIsTranscribing(true);
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [
    source,
    sentence.text,
    uploadedAudioPath,
    status,
    sentenceHash,
    sentence.lang,
  ]);

  const refreshFiles = async () => {
    const list = await invoke<string[]>("list_recordings", {
      sentenceHash,
    });

    const parsed = list.map(parseRecording).sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return b.timestamp.localeCompare(a.timestamp);
    });

    setRecordings(parsed);
  };

  const { isRecording, startRecording, stopRecording } = useRecordingControls({
    sentenceHash,
    lang: sentence.lang,
    refreshFiles,
    setRecognizing,
    setTranscripts,
    setIsTranscribing,
  });

  const { recognizeModel, disabled: modelRecognizeDisabled } =
    useModelRecognition({
      sourceKind: source.kind,
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
    sourceKind: source.kind,
    sentence,
    sentenceHash,
    uploadedAudioPath,
    displayText,
  });

  useWhisperEvents({
    sentenceId: sentence.id,
    sourceKind: source.kind,
    sentenceText: sentence.text,
    waitingModel,
    loadTranscript,
    setWaitingModel,
    setIsTranscribing,
    setModelText,
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

  useEffect(() => {
    const run = async () => {
      for (const rec of recordings) {
        if (transcripts[rec.path] === undefined) {
          const transcript = await loadTranscript(rec.path);
          setTranscripts((prev) => ({
            ...prev,
            [rec.path]: transcript,
          }));
        }
      }
    };
    run();
  }, [recordings]);

  useEffect(() => {
    if (!sentenceHash) return;
    if (waitingModel) return;

    let cancelled = false;

    const run = async () => {
      try {
        const transcript =
          source.kind === "uploaded"
            ? uploadedAudioPath
              ? await loadUploadedTranscript(uploadedAudioPath)
              : null
            : await loadModelTranscript(sentenceHash);

        if (cancelled) return;

        if (transcript && transcript.segments.length > 0) {
          setModelText(transcript.segments.map((s) => s.text).join(" "));
        } else {
          setModelText(null);
        }
      } catch {
        if (cancelled) return;
        setModelText(null);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [sentenceHash, source.kind, uploadedAudioPath, waitingModel]);

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
          onBack={onBack}
          onOpenIpaList={onOpenIpaList}
          onOpenDevelopersMistakes={onOpenDevelopersMistakes}
          onOpenCommonMistakes={onOpenCommonMistakes}
        />

        {/* Audio Debug Info - コメントアウトして非表示
        {audioDebugInfo && (
          <Typography.Paragraph
            style={{
              fontSize: 11,
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              backgroundColor: "#f5f5f5",
              padding: 8,
              borderRadius: 4,
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            <strong>Audio Debug:</strong>
            <br />
            {audioDebugInfo}
            <br />
            <strong>Current headerAudioUrl:</strong> {headerAudioUrl?.substring(0, 100) || "null"}
          </Typography.Paragraph>
        )}
        */}

        {isTranscribing && (
          <Space>
            <Spin size="small" />
            <Typography.Text type="secondary">文字起こし中…</Typography.Text>
          </Space>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <HeaderAudioPlayButton
            url={headerAudioUrl}
            loading={isHeaderAudioLoading}
            disabled={!headerAudioUrl || isHeaderAudioLoading}
          />
          <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>
            {displayText || sentence.text}
          </Typography.Title>
          <Button
            onClick={recognizeModel}
            loading={waitingModel}
            disabled={modelRecognizeDisabled}
          >
            {source.kind === "uploaded"
              ? "アップロード音声を音声認識する"
              : "模範音声を音声認識する"}
          </Button>
        </div>
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
        <Typography.Text type="secondary">
          Model status: {status}
        </Typography.Text>

        {status === "downloading" && (
          <Typography.Text type="secondary">
            Downloading model… {progress ?? 0}%
          </Typography.Text>
        )}
        <Space>
          <Button
            type="primary"
            disabled={isRecording || status !== "ready"}
            onClick={startRecording}
          >
            Start Recording
          </Button>

          <Button danger disabled={!isRecording} onClick={stopRecording}>
            Stop Recording
          </Button>
        </Space>

        {isRecording && <Typography.Text>Recording...</Typography.Text>}

        <Typography.Title level={5}>Recordings</Typography.Title>
        <RecordingsList
          recordings={recordings}
          transcripts={transcripts}
          recognizing={recognizing}
          recognizeRecording={recognizeRecording}
          audioUrls={audioUrls}
          preferAssetProtocol={preferAssetProtocol}
          toAssetUrl={toAssetUrl}
          ensureBlobAudioUrl={ensureBlobAudioUrl}
          addToAnki={addToAnki}
        />
      </Space>
    </div>
  );
};
export default RecorderScreen;
