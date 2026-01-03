import { Button, Space, Typography } from "antd";
import type { ModelStatus } from "../../../types/model";

type Props = {
  isRecording: boolean;
  status: ModelStatus;
  onMimic?: () => void;
  mimicDisabled?: boolean;
  mimicLoading?: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  autoStopRemainingMs?: number | null;
};

export function RecordingControls({
  isRecording,
  status,
  onMimic,
  mimicDisabled,
  mimicLoading,
  onStartRecording,
  onStopRecording,
  autoStopRemainingMs,
}: Props) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
      </div>

      {isRecording && autoStopRemainingMs != null && (
        <Typography.Text type="secondary" style={{ marginTop: 8 }}>
          無音です 録音停止まで：{Math.ceil(autoStopRemainingMs / 1000)}
        </Typography.Text>
      )}
    </>
  );
}
