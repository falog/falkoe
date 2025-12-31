import { Button, Space, Typography } from "antd";

interface RecordingControlsProps {
  isRecording: boolean;
  status: string;
  progress: number | null;
  onStartRecording: () => void;
  onStopRecording: () => void;
}

export const RecordingControls = ({
  isRecording,
  status,
  progress,
  onStartRecording,
  onStopRecording,
}: RecordingControlsProps) => {
  return (
    <>
      <Typography.Text type="secondary">Model status: {status}</Typography.Text>

      {status === "downloading" && (
        <Typography.Text type="secondary">
          Downloading model… {progress ?? 0}%
        </Typography.Text>
      )}

      <Space>
        <Button
          type="primary"
          disabled={isRecording || status !== "ready"}
          onClick={onStartRecording}
        >
          Start Recording
        </Button>

        <Button danger disabled={!isRecording} onClick={onStopRecording}>
          Stop Recording
        </Button>
      </Space>

      {isRecording && <Typography.Text>Recording...</Typography.Text>}
    </>
  );
};
