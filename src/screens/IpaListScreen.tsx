import { Button, message, Space, Spin, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadIpaIndex, type IpaIndexEntry } from "../utils/ipaResources";
import {
  playBundledAudio,
  unlockAudioFromUserGesture,
} from "../utils/ipaPlayer";
import TopNav from "../components/TopNav";

type Props = {
  onBack: () => void;
  onOpenDevelopersMistakes: (focus?: "j" | "r" | "oo") => void;
  onOpenCommonMistakes: () => void;
};

type GroupedEntry = {
  entry: IpaIndexEntry;
  keys: string[];
};

function categoryForEntry(
  entry: IpaIndexEntry
): "consonants" | "vowels" | "others" {
  const p = (entry.audio ?? entry.explainAudio ?? "").toLowerCase();
  if (p.includes("/consonants/")) return "consonants";
  if (p.includes("/vowels/")) return "vowels";
  return "others";
}

function titleForCategory(cat: "consonants" | "vowels" | "others"): string {
  switch (cat) {
    case "consonants":
      return "Consonants（子音）";
    case "vowels":
      return "Vowels（母音）";
    case "others":
      return "Others（その他）";
  }
}

export default function IpaListScreen({
  onBack,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<GroupedEntry[]>([]);
  const unlockTriedRef = useRef(false);

  useEffect(() => {
    setLoading(true);
    setError(null);

    loadIpaIndex()
      .then((idx) => {
        const grouped = new Map<
          string,
          { entry: IpaIndexEntry; keys: Set<string> }
        >();

        for (const [k, entry] of Object.entries(idx)) {
          const id = entry.ipa;
          const cur = grouped.get(id);
          if (cur) {
            cur.keys.add(k);
          } else {
            grouped.set(id, { entry, keys: new Set([k]) });
          }
        }

        const list: GroupedEntry[] = Array.from(grouped.values()).map((g) => ({
          entry: g.entry,
          keys: Array.from(g.keys).sort((a, b) => a.localeCompare(b)),
        }));

        list.sort((a, b) => a.entry.ipa.localeCompare(b.entry.ipa));
        setEntries(list);
      })
      .catch((e) => {
        setEntries([]);
        setError(String((e as any)?.message ?? e));
      })
      .finally(() => setLoading(false));
  }, []);

  const byCategory = useMemo(() => {
    const consonants: GroupedEntry[] = [];
    const vowels: GroupedEntry[] = [];
    const others: GroupedEntry[] = [];

    for (const item of entries) {
      const cat = categoryForEntry(item.entry);
      if (cat === "consonants") consonants.push(item);
      else if (cat === "vowels") vowels.push(item);
      else others.push(item);
    }

    return { consonants, vowels, others };
  }, [entries]);

  async function play(tok: string, resourcePath: string) {
    try {
      await playBundledAudio(resourcePath);
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      if (/user gesture|required/i.test(msg)) {
        message.info("最初に画面を1回クリックして音声を有効化してください");
      } else {
        message.error(`再生に失敗: ${tok} (${msg})`);
      }
    }
  }

  function renderSection(items: GroupedEntry[], title: string) {
    return (
      <Space orientation="vertical" style={{ width: "100%" }} size={6}>
        <Typography.Title level={5} style={{ margin: "8px 0 0" }}>
          {title}
        </Typography.Title>

        {items.length === 0 ? null : (
          <div
            style={{
              border: "1px solid var(--ant-color-border)",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {items.map(({ entry, keys }, idx) => {
              const hoverAudio = entry.audio;
              const explainAudio = entry.explainAudio;
              const aliases = keys.filter((k) => k !== entry.ipa);

              const description = entry.description
                ? entry.description
                : entry.examples && entry.examples.length > 0
                  ? entry.examples.join(", ")
                  : "—";

              return (
                <div key={`ipa-list-${entry.ipa}`}>
                  <div
                    style={{
                      padding: "12px 16px",
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                      <div>
                        <Typography.Text strong style={{ fontSize: 18 }}>
                          {entry.ipa}
                        </Typography.Text>
                        {aliases.length > 0 && (
                          <Typography.Text
                            type="secondary"
                            style={{ marginLeft: 8 }}
                          >
                            ({aliases.join(", ")})
                          </Typography.Text>
                        )}
                      </div>
                      <Typography.Text
                        type={description === "—" ? "secondary" : undefined}
                      >
                        {description}
                      </Typography.Text>
                    </div>

                    <Space size={8} wrap style={{ flex: "0 0 auto" }}>
                      <Button
                        icon={<PlayCircleOutlined />}
                        disabled={!hoverAudio}
                        onClick={() =>
                          hoverAudio && void play(entry.ipa, hoverAudio)
                        }
                      >
                        Pronounce
                      </Button>
                      <Button
                        icon={<PlayCircleOutlined />}
                        disabled={!explainAudio}
                        onClick={() =>
                          explainAudio && void play(entry.ipa, explainAudio)
                        }
                      >
                        Explain
                      </Button>
                    </Space>
                  </div>

                  {idx < items.length - 1 && (
                    <div
                      style={{ borderTop: "1px solid var(--ant-color-split)" }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Space>
    );
  }

  return (
    <div
      onPointerDown={() => {
        if (unlockTriedRef.current) return;
        unlockTriedRef.current = true;
        void unlockAudioFromUserGesture().catch(() => {
          // not fatal
        });
      }}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <TopNav
          current="ipa"
          onBack={onBack}
          onOpenIpaList={() => {
            // already here
          }}
          onOpenDevelopersMistakes={() => onOpenDevelopersMistakes()}
          onOpenCommonMistakes={onOpenCommonMistakes}
        />
        <Typography.Title level={4} style={{ margin: 0 }}>
          IPA 発音一覧
        </Typography.Title>
        <Typography.Text type="secondary">
          Pronounce は通常発音、Explain は解説音声（ある場合）です。
        </Typography.Text>

        {loading && (
          <Space>
            <Spin size="small" />
            <Typography.Text type="secondary">読み込み中…</Typography.Text>
          </Space>
        )}

        {error && (
          <Typography.Text type="danger">読み込み失敗: {error}</Typography.Text>
        )}

        {!loading && !error && (
          <Space orientation="vertical" style={{ width: "100%" }}>
            {renderSection(
              byCategory.consonants,
              titleForCategory("consonants")
            )}
            {renderSection(byCategory.vowels, titleForCategory("vowels"))}
            {renderSection(byCategory.others, titleForCategory("others"))}
          </Space>
        )}
      </Space>
    </div>
  );
}
