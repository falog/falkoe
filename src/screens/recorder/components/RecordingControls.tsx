import { Button, Space } from "antd";
import type { ModelStatus } from "../../../types/model";

type Props = {
  isRecording: boolean;
  status: ModelStatus;
  onMimic?: () => void;
  mimicDisabled?: boolean;
  mimicLoading?: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
};

export function RecordingControls({
  isRecording,
  status,
  onMimic,
  mimicDisabled,
  mimicLoading,
  onStartRecording,
  onStopRecording,
}: Props) {
  return (
    <>
      <Space>
        <Button
          type="primary"
          disabled={
            !onMimic ||
            mimicDisabled ||
            mimicLoading ||
            isRecording ||
            status !== "ready"
          }
          loading={mimicLoading}
          onClick={onMimic}
          style={{ width: 120 }}
        >
          Shadowing
        </Button>

        <Button
          type="primary"
          disabled={isRecording || status !== "ready"}
          onClick={onStartRecording}
          style={{ width: 120 }}
        >
          Start Recording
        </Button>

        <Button
          danger
          disabled={!isRecording}
          onClick={onStopRecording}
          style={{ width: 120 }}
        >
          Stop Recording
        </Button>
      </Space>

      {/*isRecording && <Typography.Text>Recording...</Typography.Text>*/}
    </>
  );
}
