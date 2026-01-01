import {
  useCallback,
  useEffect,
  useState,
  useRef,
  type SetStateAction,
} from "react";
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
import type { SourceKind, SpeechSource } from "../types/speech";
import type { ModelStatus } from "../types/model";
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
  source: SpeechSource;
  onBack: () => void;
  onOpenIpaList: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

type RecordingState = {
  recordings: Recording[];
  transcripts: Record<string, Transcript | null>;
  recognizing: Record<string, boolean>;
};

type ModelState = {
  modelText: string | null;
  waitingModel: boolean;
  isTranscribing: boolean;
};

function hashText(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
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

  const sourceKind: SourceKind = source.kind;

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

  const [recordingState, setRecordingState] = useState<RecordingState>({
    recordings: [],
    transcripts: {},
    recognizing: {},
  });

  const [modelState, setModelState] = useState<ModelState>({
    modelText: null,
    waitingModel: false,
    isTranscribing: false,
  });

  const { recordings, transcripts, recognizing } = recordingState;
  const { modelText, waitingModel, isTranscribing } = modelState;

  const setRecordings = (next: Recording[]) => {
    setRecordingState((prev) => ({ ...prev, recordings: next }));
  };

  const setTranscripts = (
    action: SetStateAction<Record<string, Transcript | null>>
  ) => {
    setRecordingState((prev) => ({
      ...prev,
      transcripts:
        typeof action === "function"
          ? (
              action as (
                p: Record<string, Transcript | null>
              ) => Record<string, Transcript | null>
            )(prev.transcripts)
          : action,
    }));
  };

  const setRecognizing = (action: SetStateAction<Record<string, boolean>>) => {
    setRecordingState((prev) => ({
      ...prev,
      recognizing:
        typeof action === "function"
          ? (action as (p: Record<string, boolean>) => Record<string, boolean>)(
              prev.recognizing
            )
          : action,
    }));
  };

  const setModelTextState = (action: SetStateAction<string | null>) => {
    setModelState((prev) => ({
      ...prev,
      modelText:
        typeof action === "function"
          ? (action as (p: string | null) => string | null)(prev.modelText)
          : action,
    }));
  };

  const setWaitingModelState = (action: SetStateAction<boolean>) => {
    setModelState((prev) => ({
      ...prev,
      waitingModel:
        typeof action === "function"
          ? (action as (p: boolean) => boolean)(prev.waitingModel)
          : action,
    }));
  };

  const setIsTranscribingState = (action: SetStateAction<boolean>) => {
    setModelState((prev) => ({
      ...prev,
      isTranscribing:
        typeof action === "function"
          ? (action as (p: boolean) => boolean)(prev.isTranscribing)
          : action,
    }));
  };

  const { status, progress }: { status: ModelStatus; progress: number | null } =
    useModelStatus();

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
    sourceKind,
    sentenceAudioUrl: sentence.audioUrl,
    sentenceHash,
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
    setRecordingState({ recordings: [], transcripts: {}, recognizing: {} });
    setModelState({
      modelText: null,
      waitingModel: false,
      isTranscribing: false,
    });
    resetAudioUrls();
    refreshFiles();
  }, [sentenceHash]);

  useAutoTranscribeUploaded({
    sourceKind,
    sentenceText: sentence.text,
    uploadedAudioPath,
    status,
    sentenceHash,
    lang: sentence.lang,
    setDisplayText,
    setIsTranscribing: (v) => setIsTranscribingState(v),
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
    setIsTranscribing: setIsTranscribingState,
  });

  const navigateSafelyRef = useRef(false);

  const navigateSafely = useCallback(
    (nav: () => void) => {
      if (navigateSafelyRef.current) return;
      navigateSafelyRef.current = true;

      void (async () => {
        try {
          if (isRecording) {
            await stopRecording();
          }
        } catch (e) {
          console.warn("stopRecording while navigating failed", e);
        }
        nav();
      })();
    },
    [isRecording, stopRecording]
  );

  const { recognizeModel, disabled: modelRecognizeDisabled } =
    useModelRecognition({
      sourceKind,
      uploadedAudioPath,
      sentenceHash,
      lang: sentence.lang,
      sentenceAudioUrl: sentence.audioUrl,
      waitingModel,
      modelText,
      setModelText: setModelTextState,
      setWaitingModel: setWaitingModelState,
      setIsTranscribing: setIsTranscribingState,
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
    setWaitingModel: (v) => setWaitingModelState(v),
    setIsTranscribing: (v) => setIsTranscribingState(v),
    setModelText: (v) => setModelTextState(v),
    setDisplayText,
    setRecognizing,
    setTranscripts,
  });

  const recognizeRecording = async (rec: Recording) => {
    if (status !== "ready") return;
    if (recognizing[rec.path]) return;

    setRecognizing((prev) => ({ ...prev, [rec.path]: true }));
    setIsTranscribingState(true);
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
      setIsTranscribingState(false);
      message.error("音声認識の開始に失敗しました: " + String(e));
    }
  };

  useLoadRecordingsTranscripts({
    recordings,
    transcripts,
    setTranscripts,
    recognizing,
  });

  const hadRecordingRecognizingRef = useRef(false);

  useEffect(() => {
    if (!isTranscribing) return;
    if (waitingModel) return;

    const recognizingKeys = Object.keys(recognizing);
    if (recognizingKeys.length > 0) {
      hadRecordingRecognizingRef.current = true;
    } else if (hadRecordingRecognizingRef.current) {
      hadRecordingRecognizingRef.current = false;
      setIsTranscribingState(false);
      return;
    } else {
      // uploaded/model など「recognizing で追えない」文字起こしはここで落とさない
      return;
    }

    const donePaths = recognizingKeys.filter((p) => transcripts[p]);
    if (donePaths.length === 0) return;

    setRecordingState((prev) => {
      let changed = false;
      const nextRecognizing = { ...prev.recognizing };
      for (const p of donePaths) {
        if (nextRecognizing[p]) {
          delete nextRecognizing[p];
          changed = true;
        }
      }
      if (!changed) return prev;
      return { ...prev, recognizing: nextRecognizing };
    });
  }, [isTranscribing, waitingModel, recognizing, transcripts]);

  useModelTranscriptLoader({
    sentenceHash,
    sourceKind,
    uploadedAudioPath,
    waitingModel,
    setModelText: (v) => setModelTextState(v),
  });

  useEffect(() => {
    if (sourceKind !== "uploaded") return;

    const hasUserProvidedSentenceText = Boolean(sentence.text?.trim());
    const hasDisplayText = Boolean(displayText?.trim());
    const recognizedText = (modelText ?? "").trim();

    if (!hasUserProvidedSentenceText && !hasDisplayText && recognizedText) {
      setDisplayText(recognizedText);
    }

    // transcript-final を取りこぼしても、ファイルから modelText が読めていれば完了扱いにする
    if (
      isTranscribing &&
      !waitingModel &&
      Object.keys(recognizing).length === 0 &&
      recognizedText
    ) {
      setIsTranscribingState(false);
    }
  }, [
    sourceKind,
    sentence.text,
    displayText,
    modelText,
    isTranscribing,
    waitingModel,
    recognizing,
  ]);

  const isRecordingsTranscribing =
    !waitingModel && Object.keys(recognizing).length > 0;
  const showModelAreaTranscribing = isTranscribing && !isRecordingsTranscribing;

  const autoRecognizingUploaded =
    sourceKind === "uploaded" &&
    isTranscribing &&
    !waitingModel &&
    Object.keys(recognizing).length === 0;

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
          onOpenIpaList={() => navigateSafely(onOpenIpaList)}
          onOpenDevelopersMistakes={() =>
            navigateSafely(onOpenDevelopersMistakes)
          }
          onOpenCommonMistakes={() => navigateSafely(onOpenCommonMistakes)}
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
          autoRecognizingUploaded={autoRecognizingUploaded}
          modelRecognizeDisabled={modelRecognizeDisabled}
          sourceKind={sourceKind}
        />

        <ModelTranscriptSection
          isTranscribing={showModelAreaTranscribing}
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
