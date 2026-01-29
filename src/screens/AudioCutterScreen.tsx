import {
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Tooltip,
  Typography,
  message,
} from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { InfoCircleOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import TopNav from "../components/TopNav";
import AudioUpload from "../components/AudioUpload";
import { LANG_OPTIONS } from "../data/langOptions";
import { useAudioUrlCache } from "./recorder/useAudioUrlCache";

type Segment = {
  start: number;
  end: number;
  text: string;
};

type CutterDetectProgressPayload = {
  cutterId: string;
  progress: number;
};

type SavedCutterAudio = {
  id: string;
  path: string;
  originalFilename: string;
};

type Props = {
  lang: string;
  setLang: (lang: string) => void;
  onBack: () => void;
  onOpenHistory: () => void;
  onOpenIpaList: () => void;
  onOpenAudioCutter: () => void;
  onOpenSettings: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

export default function AudioCutterScreen({
  lang,
  setLang,
  onBack,
  onOpenHistory,
  onOpenIpaList,
  onOpenAudioCutter,
  onOpenSettings,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: Props) {
  const { t } = useTranslation();

  // Rarely used; keep the implementation but hide the UI for now.
  const SHOW_MANUAL_SPLIT = false;

  const fileUrlRef = useRef<string | null>(null);

  const { ensureBlobAudioUrl, resetAudioUrls } = useAudioUrlCache();

  const previewAudioRefs = useRef<Record<number, HTMLAudioElement | null>>({});

  const [file, setFile] = useState<File | null>(null);
  const [saved, setSaved] = useState<SavedCutterAudio | null>(null);

  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [detectUiProgress, setDetectUiProgress] = useState<number>(0);
  const detectStartAtRef = useRef<number | null>(null);
  const gotRealDetectProgressRef = useRef(false);

  const busyDetectRef = useRef(false);
  const busyExportRef = useRef(false);

  const [cancelingDetect, setCancelingDetect] = useState(false);

  const [segments, setSegments] = useState<Segment[]>([]);
  const [selected, setSelected] = useState<boolean[]>([]);

  const [fullText, setFullText] = useState<string>("");

  const [useRawSegments, setUseRawSegments] = useState<boolean>(false);

  const [splitIndex, setSplitIndex] = useState<number>(0);
  const [splitAt, setSplitAt] = useState<number>(0);

  const [marginBefore, setMarginBefore] = useState<number>(0.1);
  const [marginAfter, setMarginAfter] = useState<number>(0.1);
  const [silenceSec, setSilenceSec] = useState<number>(0.1);

  const [previewingIndex, setPreviewingIndex] = useState<number | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!detecting) {
      detectStartAtRef.current = null;
      setDetectUiProgress(0);
      gotRealDetectProgressRef.current = false;
      return;
    }

    detectStartAtRef.current = Date.now();
    setDetectUiProgress(1);
    gotRealDetectProgressRef.current = false;

    const timer = window.setInterval(() => {
      if (gotRealDetectProgressRef.current) {
        return;
      }

      const startedAt = detectStartAtRef.current;
      const elapsedSec = startedAt ? (Date.now() - startedAt) / 1000 : 0;

      // Fake progress to reassure the user during long Whisper runs.
      // Ease-out curve: fast at first, then slows down and caps below 95%.
      const eased = 100 * (1 - Math.exp(-elapsedSec / 18));
      const target = Math.min(95, Math.max(2, Math.floor(eased)));

      setDetectUiProgress((cur) => (cur >= target ? cur : target));
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [detecting]);

  useEffect(() => {
    const cutterId = saved?.id;
    if (!cutterId) return;

    const unlistenPromise = listen<CutterDetectProgressPayload>(
      "cutter-detect-progress",
      (e) => {
        const payload = e.payload;
        if (!payload) return;
        if (payload.cutterId !== cutterId) return;

        gotRealDetectProgressRef.current = true;
        const p = Math.max(0, Math.min(100, Math.floor(payload.progress)));
        setDetectUiProgress(p);
      },
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [saved?.id]);

  const selectedSegments = useMemo(() => {
    const out: Segment[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (selected[i]) out.push(segments[i]);
    }
    return out;
  }, [segments, selected]);

  useEffect(() => {
    return () => {
      if (fileUrlRef.current) {
        URL.revokeObjectURL(fileUrlRef.current);
        fileUrlRef.current = null;
      }
    };
  }, []);

  const resetForNewFile = (next: File | null) => {
    if (fileUrlRef.current) {
      URL.revokeObjectURL(fileUrlRef.current);
      fileUrlRef.current = null;
    }

    setFile(next);
    setSaved(null);
    setSegments([]);
    setSelected([]);
    setFullText("");
    setSplitIndex(0);
    setSplitAt(0);
    setPreviewUrls({});
    setPreviewingIndex(null);
    resetAudioUrls();

    if (!next) {
      return;
    }

    // Keep a URL only for proper revocation; we don't render an audio bar on this screen.
    fileUrlRef.current = URL.createObjectURL(next);
  };

  const saveToBackend = async (f: File) => {
    setSaving(true);
    try {
      const arrayBuffer = await f.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      const info = await invoke<SavedCutterAudio>("save_cutter_audio", {
        fileData: Array.from(bytes),
        originalFilename: f.name,
      });

      setSaved(info);
      message.success(t("screens.audioCutter.messages.saved"));
    } catch (e) {
      console.error(e);
      message.error(
        `${t("screens.audioCutter.messages.saveFailed")}${String(e)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const detectSegments = async () => {
    if (!saved) return;
    if (busyDetectRef.current) return;
    busyDetectRef.current = true;
    setDetecting(true);
    setCancelingDetect(false);

    // Let the UI paint the modal/spinner before starting the heavy work.
    await new Promise<void>((r) => setTimeout(r, 0));
    try {
      const cmd = useRawSegments
        ? "cutter_suggest_segments_raw"
        : "cutter_suggest_segments";

      const segs = await invoke<Segment[]>(cmd, {
        cutterId: saved.id,
        inputPath: saved.path,
        lang,
      });
      setSegments(segs);
      setSelected(segs.map(() => true));
      setFullText(segs.map((s) => s.text).join("\n"));
      setSplitIndex(0);
      setSplitAt(segs[0]?.start ?? 0);
      setPreviewUrls({});
      setPreviewingIndex(null);
      resetAudioUrls();
      message.success(t("screens.audioCutter.messages.detected"));
    } catch (e) {
      console.error(e);
      const err = String(e);
      if (err.includes("cancelled")) {
        message.info(t("screens.audioCutter.messages.cancelled"));
      } else {
        message.error(
          `${t("screens.audioCutter.messages.detectFailed")}${err}`,
        );
      }
    } finally {
      setDetectUiProgress(100);
      setDetecting(false);
      busyDetectRef.current = false;
      setCancelingDetect(false);
    }
  };

  const cancelDetect = async () => {
    if (!saved) return;
    if (cancelingDetect) return;

    setCancelingDetect(true);
    try {
      await invoke("cutter_cancel_detect", {
        cutterId: saved.id,
      });
      message.info(t("screens.audioCutter.messages.cancelRequested"));
    } catch (e) {
      console.error(e);
      message.error(
        `${t("screens.audioCutter.messages.cancelFailed")}${String(e)}`,
      );
      setCancelingDetect(false);
    }
  };

  const invalidatePreviews = () => {
    setPreviewUrls({});
    setPreviewingIndex(null);
    resetAudioUrls();
  };

  const updateSegmentTime = (
    idx: number,
    patch: Partial<Pick<Segment, "start" | "end">>,
  ) => {
    setSegments((prev) => {
      const next = prev.slice();
      const cur = next[idx];
      if (!cur) return prev;

      const start = Math.max(0, Number(patch.start ?? cur.start));
      const end = Math.max(0, Number(patch.end ?? cur.end));

      // Keep invariant: end > start
      const safeEnd = end <= start ? start + 0.01 : end;

      next[idx] = { ...cur, start, end: safeEnd };
      return next;
    });
    invalidatePreviews();
  };

  const splitSegmentAtTime = () => {
    const idx = Math.floor(splitIndex);
    const at = Number(splitAt);
    const seg = segments[idx];
    if (!seg) return;
    if (!(at > seg.start && at < seg.end)) {
      message.warning(
        t("screens.audioCutter.messages.splitOutOfRange", {
          start: seg.start.toFixed(2),
          end: seg.end.toFixed(2),
        }),
      );
      return;
    }

    const a: Segment = {
      start: seg.start,
      end: at,
      text: seg.text,
    };
    const b: Segment = {
      start: at,
      end: seg.end,
      text: seg.text,
    };

    const nextSegs = segments
      .slice(0, idx)
      .concat([a, b], segments.slice(idx + 1));
    setSegments(nextSegs);
    setSelected(nextSegs.map(() => true));
    setFullText(nextSegs.map((s) => s.text).join("\n"));
    invalidatePreviews();
    message.success(t("screens.audioCutter.messages.splitOk"));
  };

  const applyFullTextToCuts = () => {
    const lines = fullText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      message.warning(t("screens.audioCutter.messages.textEmpty"));
      return;
    }
    if (segments.length === 0) return;

    if (lines.length > segments.length) {
      message.warning(
        t("screens.audioCutter.messages.textTooManyLines", {
          lines: lines.length,
          segs: segments.length,
        }),
      );
      return;
    }

    // Same count: just replace labels.
    if (lines.length === segments.length) {
      setSegments((prev) => prev.map((s, i) => ({ ...s, text: lines[i] })));
      setSelected(lines.map(() => true));
      invalidatePreviews();
      message.success(
        t("screens.audioCutter.messages.textApplied", { count: lines.length }),
      );
      return;
    }

    // Fewer lines: merge adjacent segments in-order.
    const segLens = segments.map((s) => {
      const n = (s.text ?? "").trim().length;
      return n > 0 ? n : 1;
    });
    const totalSegLen = segLens.reduce((a, b) => a + b, 0);
    const totalLineLen = lines.reduce((a, b) => a + b.length, 0);

    let segIndex = 0;
    const merged: Segment[] = [];
    for (let li = 0; li < lines.length; li++) {
      const remainingLines = lines.length - li;
      if (li === lines.length - 1) {
        const group = segments.slice(segIndex);
        if (group.length === 0) break;
        merged.push({
          start: group[0].start,
          end: group[group.length - 1].end,
          text: lines[li],
        });
        break;
      }

      const lineLen = lines[li].length;
      const target =
        totalLineLen > 0
          ? Math.max(1, Math.round((totalSegLen * lineLen) / totalLineLen))
          : Math.max(1, Math.round(totalSegLen / lines.length));

      const startIdx = segIndex;
      let taken = 0;
      // Ensure we leave at least 1 segment for each remaining line.
      while (
        segIndex < segments.length - remainingLines &&
        (taken < target || segIndex === startIdx)
      ) {
        taken += segLens[segIndex] ?? 1;
        segIndex += 1;
      }

      const group = segments.slice(startIdx, segIndex);
      if (group.length === 0) {
        // Fallback: take one segment.
        const s = segments[startIdx];
        if (!s) break;
        merged.push({ start: s.start, end: s.end, text: lines[li] });
        segIndex = startIdx + 1;
      } else {
        merged.push({
          start: group[0].start,
          end: group[group.length - 1].end,
          text: lines[li],
        });
      }
    }

    setSegments(merged);
    setSelected(merged.map(() => true));
    invalidatePreviews();
    setFullText(merged.map((s) => s.text).join("\n"));
    message.success(
      t("screens.audioCutter.messages.textApplied", { count: merged.length }),
    );
  };

  const exportSelected = async () => {
    if (!saved) return;
    if (busyExportRef.current) return;
    busyExportRef.current = true;
    if (selectedSegments.length === 0) {
      message.info(t("screens.audioCutter.messages.nothingSelected"));
      busyExportRef.current = false;
      return;
    }

    setExporting(true);
    try {
      const paths = await invoke<string[]>("cutter_export_segments", {
        cutterId: saved.id,
        inputPath: saved.path,
        segments: selectedSegments,
        marginBefore,
        marginAfter,
        silenceSec,
      });

      const head = paths[0] ?? "";
      message.success(
        t("screens.audioCutter.messages.exported", {
          count: paths.length,
          head,
        }),
      );
    } catch (e) {
      console.error(e);
      message.error(
        `${t("screens.audioCutter.messages.exportFailed")}${String(e)}`,
      );
    } finally {
      setExporting(false);
      busyExportRef.current = false;
    }
  };

  const previewSegment = async (idx: number, seg: Segment) => {
    if (!saved) return;

    const existing = previewUrls[idx];
    if (existing) {
      const el = previewAudioRefs.current[idx];
      if (el) {
        try {
          el.currentTime = 0;
          await el.play();
        } catch {
          // ignore
        }
      }
      return;
    }

    setPreviewingIndex(idx);
    try {
      const previewPath = await invoke<string>("cutter_preview_segment", {
        cutterId: saved.id,
        inputPath: saved.path,
        segmentIndex: idx,
        segment: seg,
        marginBefore,
        marginAfter,
        silenceSec,
      });

      const url = await ensureBlobAudioUrl(previewPath);
      if (!url) {
        throw new Error("preview audio load failed");
      }
      setPreviewUrls((prev) => ({ ...prev, [idx]: url }));

      // Try to start playback after the audio element mounts.
      setTimeout(() => {
        const el = previewAudioRefs.current[idx];
        if (!el) return;
        try {
          el.currentTime = 0;
          void el.play();
        } catch {
          // ignore
        }
      }, 30);
    } catch (e) {
      console.error(e);
      message.error(
        `${t("screens.audioCutter.messages.previewFailed")}${String(e)}`,
      );
    } finally {
      setPreviewingIndex((cur) => (cur === idx ? null : cur));
    }
  };

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Modal
        open={detecting}
        centered
        closable={false}
        maskClosable={false}
        footer={null}
        width={520}
      >
        <Space orientation="vertical" style={{ width: "100%" }} size={12}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {t("screens.audioCutter.detectModal.title")}
          </Typography.Title>

          <Space align="center">
            <Spin />
            <Typography.Text type="secondary">
              {t("screens.audioCutter.detectModal.body")}
            </Typography.Text>
          </Space>

          <Progress
            percent={detectUiProgress}
            status={detectUiProgress >= 100 ? "success" : "active"}
            showInfo={false}
          />

          <Typography.Text type="secondary">
            {t("screens.audioCutter.detectModal.note")}
          </Typography.Text>

          <Space style={{ width: "100%", justifyContent: "flex-end" }}>
            <Button
              danger
              onClick={() => void cancelDetect()}
              loading={cancelingDetect}
            >
              {t("screens.audioCutter.detectModal.cancel")}
            </Button>
          </Space>
        </Space>
      </Modal>

      <TopNav
        current="cutter"
        onBack={onBack}
        onOpenHistory={onOpenHistory}
        onOpenAudioCutter={onOpenAudioCutter}
        onOpenIpaList={onOpenIpaList}
        onOpenSettings={onOpenSettings}
        onOpenDevelopersMistakes={onOpenDevelopersMistakes}
        onOpenCommonMistakes={onOpenCommonMistakes}
      />

      <Typography.Title level={4} style={{ margin: 0 }}>
        {t("screens.audioCutter.title")}
      </Typography.Title>
      <Typography.Text type="secondary">
        {t("screens.audioCutter.description")}
      </Typography.Text>

      <Space wrap align="center">
        <Typography.Text>{t("screens.audioCutter.lang")}</Typography.Text>
        <Select
          value={lang}
          onChange={(v) => setLang(v)}
          style={{ width: 260, maxWidth: "100%" }}
          showSearch
          optionFilterProp="label"
          options={LANG_OPTIONS}
        />
      </Space>

      <Space wrap align="center">
        <AudioUpload
          disabled={saving || detecting || exporting}
          onUpload={(f) => {
            resetForNewFile(f);
            void saveToBackend(f);
          }}
          onUploadFiles={(files) => {
            const first = files?.[0];
            if (!first) return;
            resetForNewFile(first);
            void saveToBackend(first);
          }}
        />

        {saving && (
          <Space>
            <Spin size="small" />
            <Typography.Text type="secondary">
              {t("screens.audioCutter.saving")}
            </Typography.Text>
          </Space>
        )}
      </Space>

      {/* No main audio bar on this screen; preview via buttons */}

      {saved && (
        <Typography.Text type="secondary">
          {t("screens.audioCutter.savedPath")}: {saved.path}
        </Typography.Text>
      )}

      <Space wrap align="center">
        <Button
          type="primary"
          disabled={!saved || saving || detecting || exporting}
          loading={detecting}
          onClick={() => void detectSegments()}
        >
          {t("screens.audioCutter.buttons.detect")}
        </Button>

        <Checkbox
          checked={useRawSegments}
          disabled={!saved || saving || detecting || exporting}
          onChange={(e) => setUseRawSegments(e.target.checked)}
        >
          <Space size={6}>
            <span>{t("screens.audioCutter.options.rawSegments")}</span>
            <Tooltip title={t("screens.audioCutter.options.rawSegmentsHelp")}>
              <InfoCircleOutlined />
            </Tooltip>
          </Space>
        </Checkbox>

        <Typography.Text type="secondary">
          {t("screens.audioCutter.found", { count: segments.length })}
        </Typography.Text>
      </Space>

      {segments.length > 0 && (
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Text strong>
            {t("screens.audioCutter.fullText.label")}
          </Typography.Text>
          <Input.TextArea
            value={fullText}
            onChange={(e) => setFullText(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 10 }}
            placeholder={t("screens.audioCutter.fullText.placeholder")}
          />
          <Space wrap>
            <Button
              size="small"
              disabled={detecting || exporting || segments.length === 0}
              onClick={() => applyFullTextToCuts()}
            >
              {t("screens.audioCutter.fullText.apply")}
            </Button>
            <Tooltip title={t("screens.audioCutter.fullText.applyHelp")}>
              <InfoCircleOutlined />
            </Tooltip>
            <Button
              size="small"
              disabled={segments.length === 0}
              onClick={() =>
                setFullText(segments.map((s) => s.text).join("\n"))
              }
            >
              {t("screens.audioCutter.fullText.reset")}
            </Button>
            <Tooltip title={t("screens.audioCutter.fullText.resetHelp")}>
              <InfoCircleOutlined />
            </Tooltip>
            <Typography.Text type="secondary">
              {t("screens.audioCutter.fullText.hint")}
            </Typography.Text>
          </Space>

          {SHOW_MANUAL_SPLIT && (
            <Space wrap align="center">
              <Typography.Text>
                {t("screens.audioCutter.manualSplit.label")}
              </Typography.Text>
              <Select
                value={splitIndex}
                onChange={(v) => {
                  const idx = Number(v ?? 0);
                  setSplitIndex(idx);
                  const seg = segments[idx];
                  if (seg) setSplitAt(Math.max(seg.start + 0.01, seg.start));
                }}
                style={{ width: 120 }}
                options={segments.map((_, i) => ({
                  value: i,
                  label: `#${i + 1}`,
                }))}
              />
              <Typography.Text>
                <Space size={6}>
                  <span>{t("screens.audioCutter.manualSplit.at")}</span>
                  <Tooltip title={t("screens.audioCutter.manualSplit.atHelp")}>
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              </Typography.Text>
              <InputNumber
                min={0}
                step={0.05}
                value={splitAt}
                onChange={(v) => setSplitAt(Number(v ?? 0))}
              />
              <Button
                size="small"
                disabled={segments.length === 0 || detecting || exporting}
                onClick={() => splitSegmentAtTime()}
              >
                {t("screens.audioCutter.manualSplit.split")}
              </Button>
              <Typography.Text type="secondary">
                {t("screens.audioCutter.manualSplit.hint")}
              </Typography.Text>
            </Space>
          )}
        </Space>
      )}

      <Space wrap align="center">
        <Typography.Text>
          <Space size={6}>
            <span>{t("screens.audioCutter.marginBefore")}</span>
            <Tooltip title={t("screens.audioCutter.marginBeforeHelp")}>
              <InfoCircleOutlined />
            </Tooltip>
          </Space>
        </Typography.Text>
        <InputNumber
          min={0}
          step={0.05}
          value={marginBefore}
          onChange={(v) => setMarginBefore(Number(v ?? 0))}
        />
        <Typography.Text>
          <Space size={6}>
            <span>{t("screens.audioCutter.marginAfter")}</span>
            <Tooltip title={t("screens.audioCutter.marginAfterHelp")}>
              <InfoCircleOutlined />
            </Tooltip>
          </Space>
        </Typography.Text>
        <InputNumber
          min={0}
          step={0.05}
          value={marginAfter}
          onChange={(v) => setMarginAfter(Number(v ?? 0))}
        />
        <Typography.Text>
          <Space size={6}>
            <span>{t("screens.audioCutter.silence")}</span>
            <Tooltip title={t("screens.audioCutter.silenceHelp")}>
              <InfoCircleOutlined />
            </Tooltip>
          </Space>
        </Typography.Text>
        <InputNumber
          min={0}
          step={0.05}
          value={silenceSec}
          onChange={(v) => setSilenceSec(Number(v ?? 0))}
        />
      </Space>

      {segments.length > 0 && (
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Space wrap>
            <Button
              size="small"
              onClick={() => setSelected(segments.map(() => true))}
            >
              {t("screens.audioCutter.buttons.selectAll")}
            </Button>
            <Button
              size="small"
              onClick={() => setSelected(segments.map(() => false))}
            >
              {t("screens.audioCutter.buttons.selectNone")}
            </Button>
          </Space>

          {segments.map((s, idx) => (
            <Space
              key={`seg-${idx}`}
              align="start"
              style={{
                width: "100%",
                padding: 8,
                border: "1px solid var(--ant-color-split)",
                borderRadius: 6,
              }}
            >
              <Checkbox
                checked={selected[idx] ?? false}
                onChange={(e) => {
                  const next = selected.slice();
                  next[idx] = e.target.checked;
                  setSelected(next);
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Typography.Text strong>
                  {s.start.toFixed(2)}–{s.end.toFixed(2)}
                </Typography.Text>

                <Space wrap align="center" style={{ marginTop: 6 }}>
                  <Typography.Text type="secondary">
                    {t("screens.audioCutter.manualTime.start")}
                  </Typography.Text>
                  <InputNumber
                    min={0}
                    step={0.05}
                    value={s.start}
                    onChange={(v) =>
                      updateSegmentTime(idx, { start: Number(v ?? 0) })
                    }
                  />
                  <Typography.Text type="secondary">
                    {t("screens.audioCutter.manualTime.end")}
                  </Typography.Text>
                  <InputNumber
                    min={0}
                    step={0.05}
                    value={s.end}
                    onChange={(v) =>
                      updateSegmentTime(idx, { end: Number(v ?? 0) })
                    }
                  />
                </Space>

                <div style={{ whiteSpace: "pre-wrap" }}>{s.text}</div>

                <Space wrap style={{ marginTop: 6 }}>
                  <Button
                    size="small"
                    icon={<PlayCircleOutlined />}
                    disabled={!saved || previewingIndex !== null}
                    loading={previewingIndex === idx}
                    onClick={() => void previewSegment(idx, s)}
                  >
                    {t("screens.audioCutter.buttons.preview")}
                  </Button>
                  {previewUrls[idx] && (
                    <audio
                      src={previewUrls[idx]}
                      ref={(el) => {
                        previewAudioRefs.current[idx] = el;
                      }}
                      preload="metadata"
                      style={{ display: "none" }}
                    />
                  )}
                </Space>
              </div>
            </Space>
          ))}
        </Space>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button
          type="primary"
          disabled={!saved || selectedSegments.length === 0 || exporting}
          loading={exporting}
          onClick={() => void exportSelected()}
        >
          {t("screens.audioCutter.buttons.export")}
        </Button>
      </div>

      {!file && (
        <Typography.Text type="secondary">
          {t("screens.audioCutter.hint")}
        </Typography.Text>
      )}
    </Space>
  );
}
