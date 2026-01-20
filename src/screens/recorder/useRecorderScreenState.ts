import { useEffect, useRef, useState } from "react";
import { theme } from "antd";

import { useAudioUrlCache } from "./useAudioUrlCache";
import { useHeaderAudioUrl } from "./useHeaderAudioUrl";
import { useModelStatus } from "./useModelStatus";
import { loadTranscript } from "./transcriptUtils";
import type { DisplayMode } from "../../types/linking";
import type { SpeechSource } from "../../types/speech";
import type { ModelStatus } from "../../types/model";

import { useWhisperEvents } from "./useWhisperEvents";
import { useRecordingControls } from "./useRecordingControls";
import { useModelRecognition } from "./useModelRecognition";
import { useAddToAnki } from "./useAddToAnki";
import { useAutoTranscribeUploaded } from "./useAutoTranscribeUploaded";
import { useLoadRecordingsTranscripts } from "./useLoadRecordingsTranscripts";
import { useModelTranscriptLoader } from "./useModelTranscriptLoader";
import { useSentenceContext } from "./useSentenceContext";
import { useShadowingRecorder } from "./useShadowingRecorder";
import { useTranscriptionCompletion } from "./useTranscriptionCompletion";
import { usePreferAssetProtocol } from "./usePreferAssetProtocol";
import { useIpaIndex } from "./useIpaIndex";
import { useLinkingResult } from "./useLinkingResult";
import { useRecordingsState } from "./useRecordingsState";
import { useModelUiState } from "./useModelUiState";
import { useSafeNavigation } from "./useSafeNavigation";
import { useExportVideo } from "./useExportVideo";
import { useRecognizeRecording } from "./useRecognizeRecording";
import { useUpsertSentenceManifest } from "./useUpsertSentenceManifest";
import {
  extractSentenceHashFromSentenceWavPath,
  useBackgroundTranscription,
} from "../../state/backgroundTranscription";

export function useRecorderScreenState(source: SpeechSource) {
  const { token } = theme.useToken();
  const preferAssetProtocol = usePreferAssetProtocol();

  const {
    sourceKind,
    sentenceHash,
    sentence,
    uploadedAudioPath,
    hasUploadedFile,
  } = useSentenceContext(source);

  useUpsertSentenceManifest({
    sentenceHash,
    text: sentence.text,
    lang: sentence.lang,
    attribution: sentence.attribution,
  });

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

  const { jobs: backgroundJobs } = useBackgroundTranscription();
  const backgroundActiveForSentence = Boolean(
    sentenceHash &&
    backgroundJobs.some((j) => {
      if (j.key.startsWith(sentenceHash + ":")) return true;
      const hash = extractSentenceHashFromSentenceWavPath(j.key);
      return hash === sentenceHash;
    }),
  );

  const backgroundRecognizingForSentence: Record<string, boolean> = sentenceHash
    ? Object.fromEntries(
        backgroundJobs
          .filter((j) => {
            if (j.kind !== "recording") return false;
            if (!j.key.endsWith(".wav")) return false;
            const hash = extractSentenceHashFromSentenceWavPath(j.key);
            return hash === sentenceHash;
          })
          .map((j) => [j.key, true] as const),
      )
    : {};

  const effectiveRecognizing = {
    ...recognizing,
    ...backgroundRecognizingForSentence,
  };

  const effectiveIsTranscribing = isTranscribing || backgroundActiveForSentence;

  const [displayText, setDisplayText] = useState<string>(sentence.text);
  const [linkingDisplayMode, setLinkingDisplayMode] =
    useState<DisplayMode>("phoneme");
  const ipaIndex = useIpaIndex();

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

  const {
    isRecording,
    startRecording,
    stopRecording,
    pendingRecordedPath,
    savePendingRecording,
    discardPendingRecording,
  } = useRecordingControls({
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

  const { recognizeRecording } = useRecognizeRecording({
    status,
    sentenceHash,
    lang: sentence.lang,
    recognizing: effectiveRecognizing,
    setRecognizing,
    setIsTranscribing: (v) => setIsTranscribing(v),
  });

  useLoadRecordingsTranscripts({
    recordings,
    transcripts,
    setTranscripts,
    recognizing: effectiveRecognizing,
  });

  const { showModelAreaTranscribing, autoRecognizingUploaded } =
    useTranscriptionCompletion({
      sourceKind,
      sentenceText: sentence.text,
      displayText,
      modelText,
      isTranscribing: effectiveIsTranscribing,
      waitingModel,
      recognizing: effectiveRecognizing,
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

  const { handleExportVideo, isExportingVideo } = useExportVideo({
    sentenceHash,
    sentenceText: sentence.text,
    sentenceLang: sentence.lang,
    sentenceAudioUrl: sentence.audioUrl,
    sentenceAttribution: sentence.attribution,
    sourceKind,
    uploadedAudioPath,
    recordings,
    transcripts,
    token,
    recognizeModel,
  });

  return {
    preferAssetProtocol,
    sourceKind,
    sentenceHash,
    sentence,
    uploadedAudioPath,
    recordings,
    transcripts,
    recognizing: effectiveRecognizing,
    modelText,
    waitingModel,
    displayText,
    setDisplayText,
    linkingDisplayMode,
    setLinkingDisplayMode,
    ipaIndex,
    audioUrls,
    ensureBlobAudioUrl,
    toAssetUrl,
    headerAudioUrl,
    isHeaderAudioLoading,
    status,
    progress,
    recognizeModel,
    modelRecognizeDisabled,
    addToAnki,
    recognizeRecording,
    showModelAreaTranscribing,
    autoRecognizingUploaded,
    isRecording,
    pendingRecordedPath,
    savePendingRecording,
    discardPendingRecording,
    shadowingRecorder,
    navigateSafely,
    handleExportVideo,
    isExportingVideo,
    linkingResult,
  };
}

export function useAudioUnlockOnce() {
  const audioUnlockTriedRef = useRef(false);

  return {
    audioUnlockTriedRef,
  };
}
