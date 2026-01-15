import { Collapse, Typography, theme } from "antd";
import { useTranslation } from "react-i18next";
import type { PitchAnalysis, SegmentPitch, WordPitch } from "../types/pitch";

export type PitchChartSvgOptions = {
  analysis: PitchAnalysis;
  words?: Array<WordPitch | SegmentPitch> | null;
  height?: number;
  showLabels?: boolean;
  token: {
    colorBorderSecondary: string;
    borderRadius: number;
    colorBgContainer: string;
    colorTextSecondary: string;
    colorText: string;
    colorFillTertiary: string;
    colorBorder: string;
    colorPrimary: string;
  };
};

export type PitchChartSvgResult = {
  svg: string;
  viewBoxW: number;
  viewBoxH: number;
  padX: number;
  padY: number;
  plotW: number;
  plotH: number;
  renderWidthPx: number;
  renderHeightPx: number;
};

type Props = {
  analysis: PitchAnalysis;
  words?: Array<WordPitch | SegmentPitch> | null;
  height?: number;
  showLabels?: boolean;
  playheadTime?: number | null;
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function escapeXml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatAccentLabel(label: unknown): string {
  const s = String(label ?? "");
  if (!s) return "";
  // Keep UI label naming consistent with the reference Python plot.
  if (s === "Nakadaka") return "Nakada";
  return s;
}

function normalizeWordForSuffixRule(text: unknown): string {
  return (
    String(text ?? "")
      .trim()
      .replace(/[\s\u3000]+$/g, "")
      // strip common trailing punctuation
      .replace(/[\s\u3000。、．，,\.！!？?」』）)】\]]+$/g, "")
  );
}

function applyAccentHeuristicRules(text: unknown, label: unknown): unknown {
  const s = String(label ?? "");
  if (!s) return label;

  // Heuristic: polite endings often carry sentence-level drop; avoid misreading it as word-level Odaka.
  if (s === "Odaka") {
    const t = normalizeWordForSuffixRule(text);
    if (t.endsWith("ます") || t.endsWith("です")) {
      return "Nakadaka";
    }
  }

  return label;
}

export function buildPitchAlignmentChartSvg(
  opts: PitchChartSvgOptions
): PitchChartSvgResult {
  const { analysis } = opts;
  const words = opts.words;
  const height = opts.height ?? 320;
  const showLabels = opts.showLabels ?? true;
  const token = opts.token;

  const renderWidthPx = 750;

  const f0 = analysis.f0_rel;
  const voiced = f0.filter((v): v is number => typeof v === "number");
  const minV = voiced.length ? Math.min(...voiced) : 0;
  const maxV = voiced.length ? Math.max(...voiced) : 1;
  const range = Math.max(1e-6, maxV - minV);

  const W = 900;
  const H = height;
  const padX = 36;
  const padY = 18;
  const plotW = W - padX * 2;
  const plotH = H - padY * 2;
  const n = f0.length;

  const yForValue = (v: number) => padY + (1 - (v - minV) / range) * plotH;
  const baselineY = yForValue(clamp(0, minV, maxV));

  const overlayWords = (
    words ??
    analysis.words ??
    analysis.segments ??
    []
  ).filter((w) => typeof w?.start === "number" && typeof w?.end === "number");

  const fullEndTime = (n <= 1 ? 0 : n - 1) * analysis.time_step;
  let windowStart = 0;
  let windowEnd = fullEndTime;

  // Prefer a window that includes both transcript span (if present) and
  // the actual voiced pitch span. This prevents long recordings where
  // transcription stops early from showing only the first part of the pitch.
  let firstVoiced = -1;
  let lastVoiced = -1;
  for (let i = 0; i < n; i++) {
    if (typeof f0[i] === "number") {
      firstVoiced = i;
      break;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    if (typeof f0[i] === "number") {
      lastVoiced = i;
      break;
    }
  }
  const voicedStart =
    firstVoiced >= 0 ? firstVoiced * analysis.time_step : null;
  const voicedEnd =
    lastVoiced >= 0 && lastVoiced >= firstVoiced
      ? lastVoiced * analysis.time_step
      : null;

  const wordStart =
    overlayWords.length > 0
      ? Math.min(...overlayWords.map((w) => w.start))
      : null;
  const wordEnd =
    overlayWords.length > 0
      ? Math.max(...overlayWords.map((w) => w.end))
      : null;

  const candidatesStart = [wordStart, voicedStart].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );
  const candidatesEnd = [wordEnd, voicedEnd].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );

  if (candidatesStart.length > 0 && candidatesEnd.length > 0) {
    windowStart = Math.min(...candidatesStart);
    windowEnd = Math.max(...candidatesEnd);
  } else if (wordStart !== null && wordEnd !== null) {
    windowStart = wordStart;
    windowEnd = wordEnd;
  } else if (voicedStart !== null && voicedEnd !== null) {
    windowStart = voicedStart;
    windowEnd = voicedEnd;
  }

  const padTime = Math.max(analysis.time_step * 3, 0.05);
  windowStart = clamp(windowStart - padTime, 0, fullEndTime);
  windowEnd = clamp(windowEnd + padTime, 0, fullEndTime);
  if (!(windowEnd > windowStart)) {
    windowStart = 0;
    windowEnd = fullEndTime;
  }
  const windowDur = Math.max(analysis.time_step, windowEnd - windowStart);

  const xForTime = (t: number) => {
    const tt = clamp(t, windowStart, windowEnd);
    return padX + ((tt - windowStart) / windowDur) * plotW;
  };

  const parts: string[] = [];
  let drawing = false;
  for (let i = 0; i < n; i++) {
    const t = i * analysis.time_step;
    if (t < windowStart || t > windowEnd) {
      drawing = false;
      continue;
    }
    const v = f0[i];
    if (typeof v !== "number") {
      drawing = false;
      continue;
    }
    const x = xForTime(t);
    const y = yForValue(v);
    if (!drawing) {
      parts.push(`M ${x.toFixed(2)} ${y.toFixed(2)}`);
      drawing = true;
    } else {
      parts.push(`L ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
  }
  const pathD = parts.join(" ");

  const wordSvg = overlayWords
    .map((w, idx) => {
      const x0 = xForTime(w.start);
      const x1 = xForTime(w.end);
      const left = Math.min(x0, x1);
      const width = Math.max(1, Math.abs(x1 - x0));
      const text = escapeXml(String(w.text ?? ""));
      const labelRaw = applyAccentHeuristicRules(w.text, w.label);
      const label =
        showLabels && labelRaw ? escapeXml(formatAccentLabel(labelRaw)) : "";
      return `
<g key="w-${idx}">
  <rect x="${left}" y="${padY}" width="${width}" height="${plotH}" fill="${token.colorFillTertiary}" opacity="0.8" />
  <text x="${left + width / 2}" y="${padY + 14}" text-anchor="middle" fill="${token.colorText}" font-size="12">${text}${
    label
      ? `<tspan x="${left + width / 2}" dy="14" fill="${token.colorTextSecondary}" font-size="11">[${label}]</tspan>`
      : ""
  }</text>
</g>`;
    })
    .join("\n");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${renderWidthPx}" height="${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${token.colorBgContainer}" />
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="${token.colorBorderSecondary}" />

  <text x="${padX + plotW / 2}" y="${H - 4}" text-anchor="middle" fill="${token.colorTextSecondary}" font-size="18">Time (s)</text>
  <text x="14" y="${padY + plotH / 2}" transform="rotate(-90 14 ${padY + plotH / 2})" text-anchor="middle" fill="${token.colorTextSecondary}" font-size="18">Pitch (f0 rel.)</text>

  ${wordSvg}

  <line x1="${padX}" x2="${padX + plotW}" y1="${baselineY}" y2="${baselineY}" stroke="${token.colorTextSecondary}" stroke-dasharray="4 3" />
  <path d="${pathD}" fill="none" stroke="${token.colorPrimary}" stroke-width="2" />
</svg>`;

  return {
    svg,
    viewBoxW: W,
    viewBoxH: H,
    padX,
    padY,
    plotW,
    plotH,
    renderWidthPx,
    renderHeightPx: H,
  };
}

export function PitchAlignmentChart({
  analysis,
  words,
  height = 320,
  showLabels = true,
  playheadTime = null,
}: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  // Render wider than the container to keep dense word overlays readable.
  // The wrapper enables horizontal scrolling when needed.
  const renderWidthPx = 750;

  const f0 = analysis.f0_rel;
  const voiced = f0.filter((v): v is number => typeof v === "number");

  if (voiced.length < 2) {
    return (
      <Typography.Text type="secondary">
        {t("components.pitchAlignmentChart.noPitch")}
      </Typography.Text>
    );
  }

  const minV = Math.min(...voiced);
  const maxV = Math.max(...voiced);
  const range = Math.max(1e-6, maxV - minV);

  const W = 900; // viewBox width
  const H = height;
  const padX = 36;
  const padY = 18;
  const plotW = W - padX * 2;
  const plotH = H - padY * 2;
  const n = f0.length;

  const yForValue = (v: number) => padY + (1 - (v - minV) / range) * plotH;

  const baselineY = yForValue(clamp(0, minV, maxV));

  const overlayWords = (
    words ??
    analysis.words ??
    analysis.segments ??
    []
  ).filter((w) => typeof w?.start === "number" && typeof w?.end === "number");

  // Auto-zoom X range to the actual content span (words first, otherwise voiced span).
  const fullEndTime = (n <= 1 ? 0 : n - 1) * analysis.time_step;
  let windowStart = 0;
  let windowEnd = fullEndTime;

  let firstVoiced = -1;
  let lastVoiced = -1;
  for (let i = 0; i < n; i++) {
    if (typeof f0[i] === "number") {
      firstVoiced = i;
      break;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    if (typeof f0[i] === "number") {
      lastVoiced = i;
      break;
    }
  }
  const voicedStart =
    firstVoiced >= 0 ? firstVoiced * analysis.time_step : null;
  const voicedEnd =
    lastVoiced >= 0 && lastVoiced >= firstVoiced
      ? lastVoiced * analysis.time_step
      : null;

  const wordStart =
    overlayWords.length > 0
      ? Math.min(...overlayWords.map((w) => w.start))
      : null;
  const wordEnd =
    overlayWords.length > 0
      ? Math.max(...overlayWords.map((w) => w.end))
      : null;

  const candidatesStart = [wordStart, voicedStart].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );
  const candidatesEnd = [wordEnd, voicedEnd].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );

  if (candidatesStart.length > 0 && candidatesEnd.length > 0) {
    windowStart = Math.min(...candidatesStart);
    windowEnd = Math.max(...candidatesEnd);
  } else if (wordStart !== null && wordEnd !== null) {
    windowStart = wordStart;
    windowEnd = wordEnd;
  } else if (voicedStart !== null && voicedEnd !== null) {
    windowStart = voicedStart;
    windowEnd = voicedEnd;
  }

  const padTime = Math.max(analysis.time_step * 3, 0.05);
  windowStart = clamp(windowStart - padTime, 0, fullEndTime);
  windowEnd = clamp(windowEnd + padTime, 0, fullEndTime);
  if (!(windowEnd > windowStart)) {
    windowStart = 0;
    windowEnd = fullEndTime;
  }
  const windowDur = Math.max(analysis.time_step, windowEnd - windowStart);

  const xForTime = (t: number) => {
    const tt = clamp(t, windowStart, windowEnd);
    return padX + ((tt - windowStart) / windowDur) * plotW;
  };

  const playheadX =
    typeof playheadTime === "number" && Number.isFinite(playheadTime)
      ? xForTime(playheadTime)
      : null;

  // Build a path that breaks on nulls (and outside the zoom window).
  const parts: string[] = [];
  let drawing = false;
  for (let i = 0; i < n; i++) {
    const t = i * analysis.time_step;
    if (t < windowStart || t > windowEnd) {
      drawing = false;
      continue;
    }
    const v = f0[i];
    if (typeof v !== "number") {
      drawing = false;
      continue;
    }
    const x = xForTime(t);
    const y = yForValue(v);
    if (!drawing) {
      parts.push(`M ${x.toFixed(2)} ${y.toFixed(2)}`);
      drawing = true;
    } else {
      parts.push(`L ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
  }
  const pathD = parts.join(" ");

  return (
    <Collapse
      bordered={false}
      defaultActiveKey={[]}
      items={[
        {
          key: "pitch-alignment",
          label: (
            <Typography.Text type="secondary">
              {t("components.pitchAlignmentChart.title")}
            </Typography.Text>
          ),
          children: (
            <div style={{ width: "100%", overflowX: "auto" }}>
              <svg
                viewBox={`0 0 ${W} ${H}`}
                width={renderWidthPx}
                height={H}
                style={{
                  display: "block",
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: token.borderRadius,
                  background: token.colorBgContainer,
                }}
              >
                {/* axis labels */}
                <text
                  x={padX + plotW / 2}
                  y={H - 4}
                  textAnchor="middle"
                  fill={token.colorTextSecondary}
                  fontSize={18}
                >
                  {t("components.pitchAlignmentChart.axis.timeSeconds")}
                </text>
                <text
                  x={14}
                  y={padY + plotH / 2}
                  transform={`rotate(-90 14 ${padY + plotH / 2})`}
                  textAnchor="middle"
                  fill={token.colorTextSecondary}
                  fontSize={18}
                >
                  {t("components.pitchAlignmentChart.axis.pitchRelative")}
                </text>

                {/* word regions */}
                {overlayWords.map((w, idx) => {
                  const x0 = xForTime(w.start);
                  const x1 = xForTime(w.end);
                  const left = Math.min(x0, x1);
                  const width = Math.max(1, Math.abs(x1 - x0));
                  const labelRaw = applyAccentHeuristicRules(w.text, w.label);
                  return (
                    <g key={`${w.start}-${w.end}-${idx}`}>
                      <rect
                        x={left}
                        y={padY}
                        width={width}
                        height={plotH}
                        fill={token.colorFillTertiary}
                        opacity={0.8}
                      />
                      <text
                        x={left + width / 2}
                        y={padY + 14}
                        textAnchor="middle"
                        fill={token.colorText}
                        fontSize={12}
                      >
                        {w.text}
                        {showLabels && labelRaw ? (
                          <tspan
                            x={left + width / 2}
                            dy={14}
                            fill={token.colorTextSecondary}
                            fontSize={11}
                          >
                            [{formatAccentLabel(labelRaw)}]
                          </tspan>
                        ) : null}
                      </text>
                    </g>
                  );
                })}

                {/* baseline */}
                <line
                  x1={padX}
                  x2={padX + plotW}
                  y1={baselineY}
                  y2={baselineY}
                  stroke={token.colorTextSecondary}
                  strokeDasharray="4 3"
                />

                {/* pitch curve */}
                <path
                  d={pathD}
                  fill="none"
                  stroke={token.colorPrimary}
                  strokeWidth={2}
                />

                {/* playhead */}
                {playheadX !== null && (
                  <line
                    x1={playheadX}
                    x2={playheadX}
                    y1={padY}
                    y2={padY + plotH}
                    stroke="rgba(233, 155, 38, 0.84)"
                    strokeWidth={2}
                    opacity={0.85}
                  />
                )}
              </svg>
            </div>
          ),
        },
      ]}
    />
  );
}
