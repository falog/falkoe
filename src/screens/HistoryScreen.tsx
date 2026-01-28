import { Button, Card, Empty, Input, Select, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import TopNav from "../components/TopNav";
import type { SpeechSource } from "../types/speech";
import type { SentenceAttribution } from "../components/ExampleList";

type HistoryItem = {
  audioId: string;
  lang: string;
  text: string | null;
  attribution: SentenceAttribution | null;
  recordingsCount: number;
  lastRecordingTimestamp: string | null;
  lastRecordingWavPath: string | null;
  modelWavPath: string | null;
  tatoebaMp3Path: string | null;
  uploadedPath: string | null;
  uploadedOriginalFilename: string | null;
};

type HistorySortKey =
  | "recent"
  | "oldest"
  | "takesDesc"
  | "takesAsc"
  | "filenameAsc"
  | "filenameDesc"
  | "textAsc"
  | "textDesc";

type Props = {
  onBack: () => void;
  onOpenIpaList: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  onOpenFromHistory: (source: SpeechSource) => void;
};

export default function HistoryScreen({
  onBack,
  onOpenIpaList,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
  onOpenHistory,
  onOpenSettings,
  onOpenFromHistory,
}: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<HistorySortKey>("recent");

  const collator = useMemo(
    () => new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }),
    [],
  );

  const basename = (p: string): string => {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? p;
  };

  const displayFilename = (it: HistoryItem): string | null => {
    if (it.uploadedOriginalFilename?.trim()) return it.uploadedOriginalFilename;
    if (it.uploadedPath) return basename(it.uploadedPath);
    const headerPath =
      it.tatoebaMp3Path ?? it.modelWavPath ?? it.lastRecordingWavPath;
    if (headerPath) return basename(headerPath);
    return null;
  };

  const canOpenItem = (it: HistoryItem): boolean => {
    return !(
      (it.recordingsCount ?? 0) === 0 &&
      !it.tatoebaMp3Path &&
      !it.modelWavPath &&
      !it.lastRecordingWavPath &&
      !it.uploadedPath
    );
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    invoke<HistoryItem[]>("list_sentence_history")
      .then((res) => {
        if (!cancelled) setItems(res);
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openItem = (it: HistoryItem) => {
    const text = it.text ?? "";

    // Prefer opening as uploaded if we have a persisted uploaded file.
    if (it.uploadedPath) {
      const originalFilename =
        it.uploadedOriginalFilename?.trim() || basename(it.uploadedPath);
      onOpenFromHistory({
        kind: "uploaded",
        savedPath: it.uploadedPath,
        originalFilename,
        sentenceHash: it.audioId,
        text,
        attribution: it.attribution ?? undefined,
        lang: it.lang,
      });
      return;
    }

    // Otherwise, open as recorded. Prefer model.wav, else the latest recorded take.
    const headerPath =
      it.tatoebaMp3Path ?? it.modelWavPath ?? it.lastRecordingWavPath;
    if (headerPath) {
      onOpenFromHistory({
        kind: "recorded",
        filePath: headerPath,
        sentenceHash: it.audioId,
        text,
        attribution: it.attribution ?? undefined,
        lang: it.lang,
      });
      return;
    }
  };

  const filteredAndSortedItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = !q
      ? items
      : items.filter((it) => {
          const filename = displayFilename(it) ?? "";
          const text = it.text ?? "";
          const haystack = [
            it.audioId,
            it.lang,
            filename,
            text,
            `${text} ${filename}`,
          ]
            .join("\n")
            .toLowerCase();
          return haystack.includes(q);
        });

    const withIndex = filtered.map((it, idx) => ({ it, idx }));
    const strOrEmpty = (s: string | null | undefined) => (s ?? "").trim();
    const cmpEmptyLast = (a: string, b: string, dir: 1 | -1) => {
      const aa = a.trim();
      const bb = b.trim();
      const aEmpty = aa.length === 0;
      const bEmpty = bb.length === 0;
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      return collator.compare(aa, bb) * dir;
    };

    withIndex.sort((a, b) => {
      const A = a.it;
      const B = b.it;
      let c = 0;

      switch (sortKey) {
        case "recent": {
          const ta = strOrEmpty(A.lastRecordingTimestamp);
          const tb = strOrEmpty(B.lastRecordingTimestamp);
          c = collator.compare(tb, ta);
          break;
        }
        case "oldest": {
          const ta = strOrEmpty(A.lastRecordingTimestamp);
          const tb = strOrEmpty(B.lastRecordingTimestamp);
          c = collator.compare(ta, tb);
          break;
        }
        case "takesDesc": {
          c = (B.recordingsCount ?? 0) - (A.recordingsCount ?? 0);
          break;
        }
        case "takesAsc": {
          c = (A.recordingsCount ?? 0) - (B.recordingsCount ?? 0);
          break;
        }
        case "filenameAsc": {
          c = cmpEmptyLast(
            displayFilename(A) ?? "",
            displayFilename(B) ?? "",
            1,
          );
          break;
        }
        case "filenameDesc": {
          c = cmpEmptyLast(
            displayFilename(A) ?? "",
            displayFilename(B) ?? "",
            -1,
          );
          break;
        }
        case "textAsc": {
          c = cmpEmptyLast(A.text ?? "", B.text ?? "", 1);
          break;
        }
        case "textDesc": {
          c = cmpEmptyLast(A.text ?? "", B.text ?? "", -1);
          break;
        }
        default: {
          c = 0;
        }
      }

      if (c !== 0) return c;
      // Stable fallback
      const idc = collator.compare(A.audioId, B.audioId);
      if (idc !== 0) return idc;
      return a.idx - b.idx;
    });

    return withIndex.map((x) => x.it);
  }, [items, query, sortKey, collator]);

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <TopNav
        current="history"
        onBack={onBack}
        onOpenIpaList={onOpenIpaList}
        onOpenDevelopersMistakes={onOpenDevelopersMistakes}
        onOpenCommonMistakes={onOpenCommonMistakes}
        onOpenHistory={onOpenHistory}
        onOpenSettings={onOpenSettings}
      />

      <Typography.Title level={4} style={{ margin: 0 }}>
        {t("screens.history.title")}
      </Typography.Title>

      <Space wrap style={{ width: "100%" }}>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("screens.history.searchPlaceholder")}
          allowClear
          style={{ maxWidth: 420 }}
        />
        <Space wrap>
          <Typography.Text type="secondary">
            {t("screens.history.sort.label")}
          </Typography.Text>
          <Select
            value={sortKey}
            onChange={(v) => setSortKey(v)}
            style={{ width: 220 }}
            options={[
              {
                value: "recent",
                label: t("screens.history.sort.recent"),
              },
              {
                value: "oldest",
                label: t("screens.history.sort.oldest"),
              },
              {
                value: "takesDesc",
                label: t("screens.history.sort.takesDesc"),
              },
              {
                value: "takesAsc",
                label: t("screens.history.sort.takesAsc"),
              },
              {
                value: "filenameAsc",
                label: t("screens.history.sort.filenameAsc"),
              },
              {
                value: "filenameDesc",
                label: t("screens.history.sort.filenameDesc"),
              },
              {
                value: "textAsc",
                label: t("screens.history.sort.textAsc"),
              },
              {
                value: "textDesc",
                label: t("screens.history.sort.textDesc"),
              },
            ]}
          />
        </Space>
      </Space>

      {loading && items.length === 0 && (
        <Typography.Text type="secondary">
          {t("screens.history.loading")}
        </Typography.Text>
      )}

      {!loading && filteredAndSortedItems.length === 0 && (
        <Empty description={t("screens.history.empty")} />
      )}

      <Space orientation="vertical" style={{ width: "100%" }}>
        {filteredAndSortedItems.map((it) => (
          <Card
            key={it.audioId}
            size="small"
            title={
              <Space wrap>
                <Typography.Text strong>
                  {it.text?.trim()
                    ? it.text
                    : `${t("screens.history.textNotSaved")} ${displayFilename(it) ?? it.audioId}`}
                </Typography.Text>
                <Typography.Text type="secondary">[{it.lang}]</Typography.Text>
              </Space>
            }
            extra={
              <Button
                type="primary"
                onClick={() => openItem(it)}
                disabled={!canOpenItem(it)}
              >
                {t("screens.history.open")}
              </Button>
            }
          >
            <Space wrap>
              <Typography.Text type="secondary">
                {t("screens.history.takes")}
                {it.recordingsCount ?? 0}
              </Typography.Text>
              {it.lastRecordingTimestamp && (
                <Typography.Text type="secondary">
                  {t("screens.history.last")}
                  {it.lastRecordingTimestamp}
                </Typography.Text>
              )}
            </Space>
          </Card>
        ))}
      </Space>
    </Space>
  );
}
