import { Button, Space } from "antd";

type Props = {
  isRecording: boolean;
  status: string;
  onStartRecording: () => void;
  onStopRecording: () => void;
};

export function RecordingControls({
  isRecording,
  status,
  onStartRecording,
  onStopRecording,
}: Props) {
  return (
    <>
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

      {/*isRecording && <Typography.Text>Recording...</Typography.Text>*/}
    </>
  );
}
