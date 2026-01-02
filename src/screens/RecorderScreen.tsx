import { useEffect, useState, useRef } from "react";
import { message, Space, theme } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { useAudioUrlCache } from "./recorder/useAudioUrlCache";
import { useHeaderAudioUrl } from "./recorder/useHeaderAudioUrl";
import { useModelStatus } from "./recorder/useModelStatus";
import { loadTranscript } from "./recorder/transcriptUtils";
import type { DisplayMode } from "../types/linking";
import { unlockAudioFromUserGesture } from "../utils/ipaPlayer";
import TopNav from "../components/TopNav";
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
  onOpenIpaList: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

const RecorderScreen = ({
  source,
  onBack,
  onOpenIpaList,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: RecorderScreenProps) => {
  theme.useToken();
  const preferAssetProtocol = usePreferAssetProtocol();

  const {
    sourceKind,
    sentenceHash,
    sentence,
    uploadedAudioPath,
    hasUploadedFile,
  } = useSentenceContext(source);

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
          sentenceHash={sentenceHash}
          lang={sentence.lang}
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
          onMimic={() => shadowingRecorder.start({ mode: "mimic" })}
          mimicLoading={shadowingRecorder.isMimicLoading}
          mimicDisabled={!headerAudioUrl || isHeaderAudioLoading}
          onStartRecording={() => shadowingRecorder.start()}
          onStopRecording={shadowingRecorder.stop}
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
