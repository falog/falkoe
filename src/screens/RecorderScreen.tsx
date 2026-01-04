import { useRef } from "react";
import { Button, Space, Row, Col } from "antd";
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
  const audioUnlockTriedRef = useRef(false);

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
        <Row align="top" gutter={12} wrap={false}>
          <Col flex="auto" style={{ minWidth: 0 }}>
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

          <Col style={{ flexShrink: 0 }}>
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
