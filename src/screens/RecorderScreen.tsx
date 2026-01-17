import { useRef } from "react";
import { Button, Space, Row, Col } from "antd";
import { useTranslation } from "react-i18next";
import { unlockAudioFromUserGesture } from "../utils/ipaPlayer";
import TopNav from "../components/TopNav";
import { RecorderHeader } from "./recorder/components/RecorderHeader";
import { ModelTranscriptSection } from "./recorder/components/ModelTranscriptSection";
import { RecordingControls } from "./recorder/components/RecordingControls";
import { RecordingsSection } from "./recorder/components/RecordingsSection";
import type { SpeechSource } from "../types/speech";
import { useRecorderScreenState } from "./recorder/useRecorderScreenState";

type RecorderScreenProps = {
  source: SpeechSource;
  onBack: () => void;
  onOpenHistory: () => void;
  onOpenIpaList: () => void;
  onOpenSettings: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

const RecorderScreen = ({
  source,
  onBack,
  onOpenHistory,
  onOpenIpaList,
  onOpenSettings,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: RecorderScreenProps) => {
  const { t } = useTranslation();
  const audioUnlockTriedRef = useRef(false);

  const mimicDisabledForSource =
    source.kind === "recorded" && /[\\/]recorded[\\/]/.test(source.filePath);

  const {
    preferAssetProtocol,
    sourceKind,
    sentenceHash,
    sentence,
    recordings,
    transcripts,
    recognizing,
    modelText,
    waitingModel,
    displayText,
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
  } = useRecorderScreenState(source);

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
          onOpenSettings={() => navigateSafely(onOpenSettings)}
          onOpenDevelopersMistakes={() =>
            navigateSafely(onOpenDevelopersMistakes)
          }
          onOpenCommonMistakes={() => navigateSafely(onOpenCommonMistakes)}
        />
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Row>
            <Col flex="auto" style={{ minWidth: 0 }}>
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
            </Col>
          </Row>

          <ModelTranscriptSection
            isTranscribing={showModelAreaTranscribing}
            modelText={modelText}
            sentenceHash={sentenceHash}
            lang={sentence.lang}
            modelAudioUrl={headerAudioUrl}
            sourceKind={sourceKind}
            linkingResult={linkingResult}
            linkingDisplayMode={linkingDisplayMode}
            setLinkingDisplayMode={setLinkingDisplayMode}
            ipaIndex={ipaIndex}
            status={status}
            progress={progress}
            headerRight={
              <Button
                onClick={handleExportVideo}
                loading={isExportingVideo}
                disabled={isExportingVideo}
              >
                {t("screens.recorder.exportVideo")}
              </Button>
            }
          />
        </Space>
        <RecordingControls
          isRecording={isRecording}
          status={status}
          onMimic={() => shadowingRecorder.start({ mode: "mimic" })}
          mimicLoading={shadowingRecorder.isMimicLoading}
          mimicDisabled={
            mimicDisabledForSource || !headerAudioUrl || isHeaderAudioLoading
          }
          onStartRecording={() => shadowingRecorder.start()}
          onStopRecording={shadowingRecorder.stop}
          autoStopRemainingMs={shadowingRecorder.autoStopRemainingMs}
          pendingSave={Boolean(pendingRecordedPath)}
          onSavePending={() => {
            void savePendingRecording();
          }}
          onDiscardPending={() => {
            void discardPendingRecording();
          }}
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
