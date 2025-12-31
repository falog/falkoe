import { Button, Typography } from "antd";

interface ModelTranscriptSectionProps {
  modelText: string | null;
  waitingModel: boolean;
  uploadedAudioPath: string | null;
  sourceKind: string;
  onRecognize: () => void;
}

export const ModelTranscriptSection = ({
  modelText,
  waitingModel,
  uploadedAudioPath,
  sourceKind,
  onRecognize,
}: ModelTranscriptSectionProps) => {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Button
          onClick={onRecognize}
          loading={waitingModel}
          disabled={
            (sourceKind === "uploaded" && !uploadedAudioPath) ||
            waitingModel ||
            Boolean(modelText?.trim())
          }
        >
          {sourceKind === "uploaded"
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
    </>
  );
};
