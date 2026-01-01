import { Button, Space } from "antd";
import type { ModelStatus } from "../../../types/model";

type Props = {
  isRecording: boolean;
  status: ModelStatus;
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
