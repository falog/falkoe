import { Typography, Space, Radio } from "antd";
import type { RenderLinkingResult, DisplayMode } from "../types/linking";
import type { IpaIndex } from "../utils/ipaResources";
import React from "react";
import type { ModelStatus } from "../types/model";

export type ModelAreaProps = {
  modelText: string | null;
  linkingResult: RenderLinkingResult | null;
  linkingDisplayMode: DisplayMode;
  setLinkingDisplayMode: (mode: DisplayMode) => void;
  ipaIndex: IpaIndex | null;
  ipaIndexError: string | null;
  ipaHoverDebug: any;
  renderLegend: () => React.ReactNode;
  extractStressWords: (res: RenderLinkingResult) => {
    primary: string[];
    secondary: string[];
  };
  renderStressColored: (text: string) => React.ReactNode;
  status: ModelStatus;
  progress: number | null;
};

const ModelArea: React.FC<ModelAreaProps> = ({
  modelText,
  linkingResult,
  linkingDisplayMode,
  setLinkingDisplayMode,
  ipaIndex,
  ipaIndexError,
  ipaHoverDebug,
  renderLegend,
  extractStressWords,
  renderStressColored,
  status,
  progress,
}) => (
  <>
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
      <>
        <Space size={8} style={{ display: "flex" }}>
          <Typography.Text type="secondary">表示:</Typography.Text>
          <Radio.Group
            size="small"
            value={linkingDisplayMode}
            onChange={(e) => setLinkingDisplayMode(e.target.value)}
            options={[
              { label: "phoneme", value: "phoneme" },
              { label: "kana", value: "kana" },
            ]}
            optionType="button"
            buttonStyle="solid"
          />
          <Typography.Text type="secondary" style={{ display: "block" }}>
            IPA audio:{" "}
            {ipaIndex ? `${Object.keys(ipaIndex).length} keys` : "not loaded"}
            {ipaIndexError ? ` (error: ${ipaIndexError})` : ""}
            {linkingResult?.joined
              ? ` | mode: ${linkingDisplayMode} | parens: ${linkingResult.joined.includes("(") || linkingResult.joined.includes("（") ? "yes" : "no"}`
              : ""}
            {ipaHoverDebug
              ? ` | last: ${ipaHoverDebug.tok} ${ipaHoverDebug.event} ${ipaHoverDebug.result}` +
                (ipaHoverDebug.message ? ` (${ipaHoverDebug.message})` : "")
              : ""}
          </Typography.Text>
        </Space>
        {renderLegend()}
        {(linkingDisplayMode === "phoneme" ||
          linkingDisplayMode === "kana") && (
          <Typography.Text type="secondary" style={{ display: "block" }}>
            {(() => {
              const { primary, secondary } = extractStressWords(linkingResult);
              const p = primary.length ? primary.join(" / ") : "なし";
              const s = secondary.length ? secondary.join(" / ") : "なし";
              return `強勢: ${p} / 副強勢: ${s}`;
            })()}
          </Typography.Text>
        )}
        <div style={{ display: "block", fontSize: 18, lineHeight: 1.6 }}>
          {renderStressColored(linkingResult.joined)}
        </div>
      </>
    )}
    <Typography.Text type="secondary">Model status: {status}</Typography.Text>
    {status === "downloading" && (
      <Typography.Text type="secondary">
        Downloading model… {progress ?? 0}%
      </Typography.Text>
    )}
  </>
);

export default ModelArea;
