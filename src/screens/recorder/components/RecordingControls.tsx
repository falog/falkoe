import { Button, Modal, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  pendingSave?: boolean;
  onSavePending?: () => void;
  onDiscardPending?: () => void;
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
  pendingSave,
  onSavePending,
  onDiscardPending,
}: Props) {
  const { t } = useTranslation();
  const [isDecisionModalOpen, setIsDecisionModalOpen] = useState(false);
  const prevPendingSaveRef = useRef<boolean>(false);

  useEffect(() => {
    const prev = prevPendingSaveRef.current;
    prevPendingSaveRef.current = Boolean(pendingSave);
    if (!prev && pendingSave) {
      setIsDecisionModalOpen(true);
    }
  }, [pendingSave]);

  useEffect(() => {
    if (!pendingSave) setIsDecisionModalOpen(false);
  }, [pendingSave]);

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
            {t("screens.recorder.recordingControls.shadowing")}
          </Button>

          <Button
            type="primary"
            disabled={pendingSave || isRecording || status !== "ready"}
            onClick={onStartRecording}
            style={{ width: 120 }}
          >
            {t("screens.recorder.recordingControls.startRecording")}
          </Button>

          <Button
            danger
            disabled={!isRecording}
            onClick={onStopRecording}
            style={{ width: 120 }}
          >
            {t("screens.recorder.recordingControls.stopRecording")}
          </Button>
        </Space>
      </div>

      <Modal
        open={isDecisionModalOpen}
        onCancel={() => setIsDecisionModalOpen(false)}
        title={t("screens.recorder.recordingControls.keepOrDiscard.title")}
        footer={
          <Space>
            <Button
              type="primary"
              onClick={() => {
                setIsDecisionModalOpen(false);
                onSavePending?.();
              }}
            >
              {t("screens.recorder.recordingControls.keep")}
            </Button>
            <Button
              danger
              onClick={() => {
                setIsDecisionModalOpen(false);
                onDiscardPending?.();
              }}
            >
              {t("screens.recorder.recordingControls.discard")}
            </Button>
          </Space>
        }
      >
        {t("screens.recorder.recordingControls.keepOrDiscard.content")}
      </Modal>

      {isRecording && autoStopRemainingMs != null && (
        <Typography.Text type="secondary" style={{ marginTop: 8 }}>
          {`${t("screens.recorder.recordingControls.autoStopCountdown")} ${Math.ceil(
            autoStopRemainingMs / 1000,
          )}`}
        </Typography.Text>
      )}
    </>
  );
}
