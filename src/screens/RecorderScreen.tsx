import { useEffect, useState, useRef } from "react";
import { message, Space, theme } from "antd";
import { invoke } from "@tauri-apps/api/core";
import type { Sentence } from "../components/ExampleList";
import { sha256 } from "../utils/hash";
import { useAudioUrlCache } from "./recorder/useAudioUrlCache";
import { useHeaderAudioUrl } from "./recorder/useHeaderAudioUrl";
import { useModelStatus } from "./recorder/useModelStatus";
import { loadTranscript, parseRecording } from "./recorder/transcriptUtils";
import { renderLinkingRust } from "../utils/linkingInvoke";
import type { RenderLinkingResult, DisplayMode } from "../types/linking";
import { loadIpaIndex, type IpaIndex } from "../utils/ipaResources";
import { unlockAudioFromUserGesture } from "../utils/ipaPlayer";
import TopNav from "../components/TopNav";
import type { Recording, Transcript } from "../types/recording";
import { useWhisperEvents } from "./recorder/useWhisperEvents";
import { useRecordingControls } from "./recorder/useRecordingControls";
import { useModelRecognition } from "./recorder/useModelRecognition";
import { useAddToAnki } from "./recorder/useAddToAnki";
import { useUploadedAudio } from "./recorder/useUploadedAudio";
import { useAutoTranscribeUploaded } from "./recorder/useAutoTranscribeUploaded";
import { useLoadRecordingsTranscripts } from "./recorder/useLoadRecordingsTranscripts";
import { useModelTranscriptLoader } from "./recorder/useModelTranscriptLoader";
import { RecorderHeader } from "./recorder/components/RecorderHeader";
import { ModelTranscriptSection } from "./recorder/components/ModelTranscriptSection";
import { RecordingControls } from "./recorder/components/RecordingControls";
import { RecordingsSection } from "./recorder/components/RecordingsSection";

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
    refreshFiles();
  }, [sentenceHash]);

  useAutoTranscribeUploaded({
    sourceKind: source.kind,
    sentenceText: sentence.text,
    uploadedAudioPath,
    status,
    sentenceHash,
    lang: sentence.lang,
    setDisplayText,
    setIsTranscribing,
  });

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

  useLoadRecordingsTranscripts({
    recordings,
    transcripts,
    setTranscripts,
  });

  useModelTranscriptLoader({
    sentenceHash,
    sourceKind: source.kind,
    uploadedAudioPath,
    waitingModel,
    setModelText,
  });

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

        <RecorderHeader
          headerAudioUrl={headerAudioUrl}
          isHeaderAudioLoading={isHeaderAudioLoading}
          displayText={displayText}
          sentenceText={sentence.text}
          onRecognizeModel={recognizeModel}
          waitingModel={waitingModel}
          modelRecognizeDisabled={modelRecognizeDisabled}
          sourceKind={source.kind}
        />

        <ModelTranscriptSection
          isTranscribing={isTranscribing}
          modelText={modelText}
          linkingResult={linkingResult}
          linkingDisplayMode={linkingDisplayMode}
          setLinkingDisplayMode={setLinkingDisplayMode}
          ipaIndex={ipaIndex}
          status={status}
          progress={progress}
        />

        <RecordingControls
          isRecording={isRecording}
          status={status}
          onStartRecording={startRecording}
          onStopRecording={stopRecording}
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
        />
      </Space>
    </div>
  );
};
export default RecorderScreen;
