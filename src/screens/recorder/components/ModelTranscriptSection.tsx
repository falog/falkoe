import { Space, Spin, Typography } from "antd";
import type { RenderLinkingResult, DisplayMode } from "../../../types/linking";
import type { IpaIndex } from "../../../utils/ipaResources";
import LinkingStressArea from "../LinkingStressArea";

type Props = {
  isTranscribing: boolean;
  modelText: string | null;
  linkingResult: RenderLinkingResult | null;
  linkingDisplayMode: DisplayMode;
  setLinkingDisplayMode: (mode: DisplayMode) => void;
  ipaIndex: IpaIndex | null;
  status: string;
  progress: number | null;
};

export function ModelTranscriptSection({
  isTranscribing,
  modelText,
  linkingResult,
  linkingDisplayMode,
  setLinkingDisplayMode,
  ipaIndex,
  status,
  progress,
}: Props) {
  return (
    <>
      {isTranscribing && (
        <Space>
          <Spin size="small" />
          <Typography.Text type="secondary">文字起こし中…</Typography.Text>
        </Space>
      )}

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

      {linkingResult?.joined && (
        <LinkingStressArea
          linkingResult={linkingResult}
          linkingDisplayMode={linkingDisplayMode}
          setLinkingDisplayMode={setLinkingDisplayMode}
          ipaIndex={ipaIndex}
        />
      )}

      <Typography.Text type="secondary">Model status: {status}</Typography.Text>

      {status === "downloading" && (
        <Typography.Text type="secondary">
          Downloading model… {progress ?? 0}%
        </Typography.Text>
      )}
    </>
  );
}
