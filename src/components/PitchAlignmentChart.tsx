import { Collapse, Typography, theme } from "antd";
import type { PitchAnalysis, SegmentPitch, WordPitch } from "../types/pitch";

type Props = {
  analysis: PitchAnalysis;
  words?: Array<WordPitch | SegmentPitch> | null;
  height?: number;
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function PitchAlignmentChart({ analysis, words, height = 320 }: Props) {
  const { token } = theme.useToken();

  // Render wider than the container to keep dense word overlays readable.
  // The wrapper enables horizontal scrolling when needed.
  const renderWidthPx = 770;

  const f0 = analysis.f0_rel;
  const voiced = f0.filter((v): v is number => typeof v === "number");

  if (voiced.length < 2) {
    return (
      <Typography.Text type="secondary">
        ピッチが検出できませんでした
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

  if (overlayWords.length > 0) {
    windowStart = Math.min(...overlayWords.map((w) => w.start));
    windowEnd = Math.max(...overlayWords.map((w) => w.end));
  } else {
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
    if (firstVoiced >= 0 && lastVoiced >= firstVoiced) {
      windowStart = firstVoiced * analysis.time_step;
      windowEnd = lastVoiced * analysis.time_step;
    }
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
              Pitch × Whisper Alignment
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
                  Time (s)
                </text>
                <text
                  x={14}
                  y={padY + plotH / 2}
                  transform={`rotate(-90 14 ${padY + plotH / 2})`}
                  textAnchor="middle"
                  fill={token.colorTextSecondary}
                  fontSize={18}
                >
                  Pitch (f0 rel.)
                </text>

                {/* word regions */}
                {overlayWords.map((w, idx) => {
                  const x0 = xForTime(w.start);
                  const x1 = xForTime(w.end);
                  const left = Math.min(x0, x1);
                  const width = Math.max(1, Math.abs(x1 - x0));
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
                        {w.label ? (
                          <tspan
                            x={left + width / 2}
                            dy={14}
                            fill={token.colorTextSecondary}
                            fontSize={11}
                          >
                            [{w.label}]
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
                  stroke={token.colorBorder}
                  strokeDasharray="6 4"
                />

                {/* pitch curve */}
                <path
                  d={pathD}
                  fill="none"
                  stroke={token.colorPrimary}
                  strokeWidth={2}
                />
              </svg>
            </div>
          ),
        },
      ]}
    />
  );
}
