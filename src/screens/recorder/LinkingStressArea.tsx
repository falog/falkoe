import { Radio, Space, Typography, message, theme } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { tokenizeIpa } from "../../utils/ipaTokenize";
import { playBundledAudio } from "../../utils/ipaPlayer";
import type { RenderLinkingResult, DisplayMode } from "../../types/linking";
import type { IpaIndex } from "../../utils/ipaResources";

type Props = {
  linkingResult: RenderLinkingResult;
  linkingDisplayMode: DisplayMode;
  setLinkingDisplayMode: (mode: DisplayMode) => void;
  ipaIndex: IpaIndex | null;
};

export default function LinkingStressArea({
  linkingResult,
  linkingDisplayMode,
  setLinkingDisplayMode,
  ipaIndex,
}: Props) {
  const { token: antdToken } = theme.useToken();

  const [lastHoveredTok, setLastHoveredTok] = useState<string | null>(null);
  //const [lastHoveredHasDetails, setLastHoveredHasDetails] = useState(false);

  const hoverTimerRef = useRef<number | null>(null);
  const lastHoverRef = useRef<{ tok: string; ts: number } | null>(null);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };
  }, []);

  async function playIpaTok(
    tok: string,
    audioPath: string,
    event: "enter" | "click"
  ) {
    try {
      await playBundledAudio(audioPath);
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      if (event === "click") {
        if (/user gesture|required/i.test(msg)) {
          message.info("最初に画面を1回クリックして音声を有効化してください");
        } else {
          message.error(`再生に失敗: ${tok} (${msg})`);
        }
      }
      console.warn(`IPA play failed (${event}): ${tok} (${msg})`, e);
    }
  }

  function requestPlayIpaTok(
    tok: string,
    audioPath: string,
    event: "enter" | "click"
  ) {
    if (event === "enter") {
      const now = Date.now();
      const last = lastHoverRef.current;
      if (last && now - last.ts < 120) return;
      lastHoverRef.current = { tok, ts: now };

      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }

      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        void playIpaTok(tok, audioPath, event);
      }, 60);
      return;
    }

    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    void playIpaTok(tok, audioPath, event);
  }

  function renderTokenizedIpa(ipa: string, keys: string[]): ReactNode {
    const tokens = tokenizeIpa(ipa, keys);

    const vowels = new Set(Array.from("iɪeɛæaɑɒɔoʊuʌəɜɞɵøyʉɯɐɶœɨʏɤɘɚɝ"));

    function colorForTok(tok: string): string | undefined {
      if (tok === "ˈ") return antdToken.colorErrorText;
      if (tok === "ˌ") return antdToken.colorWarningText;
      if (tok.trim() === "") return undefined;
      if (tok.includes("̩")) return antdToken.colorSuccessText;
      if (Array.from(tok).some((ch) => vowels.has(ch))) {
        return antdToken.colorSuccessText;
      }
      if (/^[.ːˑ‿\-–—'']+$/.test(tok)) {
        return antdToken.colorTextSecondary;
      }
      return antdToken.colorInfoText;
    }

    return (
      <>
        {tokens.map((tok, j) => {
          const entry = ipaIndex?.[tok];
          const color = colorForTok(tok);

          const hoverAudio = entry?.audio;
          const clickAudio = entry?.explainAudio ?? entry?.audio;
          const isInteractive = Boolean(hoverAudio || clickAudio);
          //const hasDetails = Boolean(entry?.explainAudio);

          if (!entry || !isInteractive) {
            return (
              <span key={`ipa-tok-${j}`} style={{ color }}>
                {tok}
              </span>
            );
          }

          return (
            <span
              key={`ipa-tok-${j}`}
              style={{
                cursor: "pointer",
                textDecoration: "underline",
                color,
              }}
              onPointerEnter={() => {
                setLastHoveredTok(tok);
                //setLastHoveredHasDetails(hasDetails);
                if (!hoverAudio) return;
                requestPlayIpaTok(tok, hoverAudio, "enter");
              }}
              onClick={() => {
                if (!clickAudio) return;
                requestPlayIpaTok(tok, clickAudio, "click");
              }}
            >
              {tok}
            </span>
          );
        })}
      </>
    );
  }

  function renderLegend(): ReactNode {
    if (linkingDisplayMode === "phoneme") {
      return (
        <Typography.Text type="secondary" style={{ display: "block" }}>
          <Typography.Text style={{ color: antdToken.colorErrorText }}>
            ˈ 強勢
          </Typography.Text>
          {" / "}
          <Typography.Text style={{ color: antdToken.colorWarningText }}>
            ˌ 副強勢
          </Typography.Text>
          {" / "}
          <Typography.Text style={{ color: antdToken.colorSuccessText }}>
            母音
          </Typography.Text>
          {" / "}
          <Typography.Text style={{ color: antdToken.colorInfoText }}>
            子音
          </Typography.Text>
          {" / "}
          <Typography.Text type="secondary">記号</Typography.Text>
        </Typography.Text>
      );
    }

    return (
      <Typography.Text type="secondary" style={{ display: "block" }}>
        <Typography.Text style={{ color: antdToken.colorErrorText }}>
          ˈ 強勢
        </Typography.Text>
        {" / "}
        <Typography.Text style={{ color: antdToken.colorWarningText }}>
          ˌ 副強勢
        </Typography.Text>
        {" / "}
        <Typography.Text type="secondary">弱</Typography.Text>
      </Typography.Text>
    );
  }

  function stressType(mark: string): "danger" | "warning" | "secondary" {
    switch (mark) {
      case "▲":
        return "danger";
      case "△":
        return "warning";
      default:
        return "secondary";
    }
  }

  function renderStressColored(text: string): ReactNode {
    const marks = new Set(["▲", "△", "▽"]);

    function renderMarkedInline(s: string, fontSize: number): ReactNode {
      const stops = new Set(["▲", "△", "▽"]);
      const out: ReactNode[] = [];
      let i = 0;

      while (i < s.length) {
        const ch = s[i];
        if (marks.has(ch)) {
          const start = i;
          i += 1;
          const segStart = i;
          while (i < s.length && !stops.has(s[i])) i += 1;
          const seg = s.slice(segStart, i);

          const sym = ch === "▲" ? "ˈ" : ch === "△" ? "ˌ" : "";
          out.push(
            <Typography.Text
              key={`m-${start}`}
              type={stressType(ch)}
              style={{ fontSize }}
            >
              {sym}
              {seg}
            </Typography.Text>
          );
          continue;
        }

        const start = i;
        i += 1;
        while (i < s.length && !marks.has(s[i])) i += 1;
        const seg = s.slice(start, i).replace(/[▲△▽]/g, "");
        out.push(
          <span key={`u-${start}`} style={{ fontSize }}>
            {seg}
          </span>
        );
      }

      return out;
    }

    if (linkingDisplayMode === "kana") {
      const parts = text.split(/(\|)/g);

      return (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "flex-end",
          }}
        >
          {parts
            .map((p) => p)
            .filter((p) => p !== "")
            .map((part, idx) => {
              if (part === "|") {
                return (
                  <div
                    key={`sep-k-${idx}`}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                    }}
                  >
                    <div style={{ minHeight: 18 }} />
                    <Typography.Text style={{ fontSize: 18, lineHeight: 1.2 }}>
                      |
                    </Typography.Text>
                  </div>
                );
              }

              const raw = part;
              if (!raw.trim()) return null;

              const bracketMatches = raw.match(/\([^)]*\)|（[^）]*）/g) ?? [];
              const firstBracket = bracketMatches[0];
              const kanaText = firstBracket ? firstBracket.slice(1, -1) : "";

              const mainText = raw
                .replace(/\([^)]*\)/g, "")
                .replace(/（[^）]*）/g, "")
                .replace(/[▲△▽]/g, "")
                .trim();

              const displayKana = kanaText
                ? renderMarkedInline(kanaText, 14)
                : null;

              return (
                <div
                  key={`k-${idx}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      display: "block",
                      lineHeight: 1.2,
                      minHeight: 18,
                      whiteSpace: "pre",
                    }}
                  >
                    {displayKana}
                  </div>
                  <Typography.Text style={{ fontSize: 18, lineHeight: 1.2 }}>
                    {mainText}
                  </Typography.Text>
                </div>
              );
            })}
        </div>
      );
    }

    if (linkingDisplayMode !== "phoneme" || !ipaIndex) {
      return <span style={{ fontSize: 18 }}>{text.replace(/[▲△▽]/g, "")}</span>;
    }

    const keys = Object.keys(ipaIndex);
    const parts = text.split(/(\|)/g);

    return (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "flex-end",
        }}
      >
        {parts
          .map((p) => p)
          .filter((p) => p !== "")
          .map((part, idx) => {
            if (part === "|") {
              return (
                <div
                  key={`sep-${idx}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <div style={{ minHeight: 18 }} />
                  <Typography.Text style={{ fontSize: 18, lineHeight: 1.2 }}>
                    |
                  </Typography.Text>
                </div>
              );
            }

            const rawWithMarks = part;
            if (!rawWithMarks.trim()) return null;

            const bracketMatches =
              rawWithMarks.match(/\([^)]*\)|（[^）]*）/g) ?? [];
            const firstBracket = bracketMatches[0];
            const ipaTextRaw = firstBracket ? firstBracket.slice(1, -1) : "";

            const ipaWithStress = ipaTextRaw
              .replace(/▲/g, "ˈ")
              .replace(/△/g, "ˌ")
              .replace(/▽/g, "")
              .trim();

            const mainText = rawWithMarks
              .replace(/\([^)]*\)/g, "")
              .replace(/（[^）]*）/g, "")
              .replace(/[▲△▽]/g, "")
              .trim();

            const displayIpa = ipaWithStress
              ? renderTokenizedIpa(ipaWithStress, keys)
              : null;

            return (
              <div
                key={`w-${idx}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    display: "block",
                    fontSize: 18,
                    lineHeight: 1.2,
                    minHeight: 18,
                    whiteSpace: "pre",
                  }}
                >
                  {displayIpa}
                </div>
                <Typography.Text style={{ fontSize: 18, lineHeight: 1.2 }}>
                  {mainText}
                </Typography.Text>
              </div>
            );
          })}
      </div>
    );
  }

  function extractStressWords(res: RenderLinkingResult): {
    primary: string[];
    secondary: string[];
  } {
    const stopwords = new Set([
      "a",
      "an",
      "the",
      "to",
      "of",
      "and",
      "or",
      "but",
      "for",
      "nor",
      "so",
      "yet",
      "in",
      "on",
      "at",
      "by",
      "from",
      "with",
      "as",
      "about",
      "into",
      "over",
      "after",
      "before",
      "under",
      "between",
      "through",
      "during",
      "without",
      "within",
      "do",
      "did",
      "does",
      "done",
      "is",
      "am",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "will",
      "would",
      "can",
      "could",
      "shall",
      "should",
      "may",
      "might",
      "must",
      "i",
      "you",
      "we",
      "they",
      "he",
      "she",
      "it",
      "me",
      "him",
      "her",
      "us",
      "them",
      "my",
      "your",
      "his",
      "their",
      "our",
      "this",
      "that",
      "these",
      "those",
    ]);

    const normalize = (w: string) =>
      w.toLowerCase().replace(/^[^a-z']+|[^a-z']+$/gi, "");

    const pickRepresentativeWord = (words: string[]): string => {
      const cleaned = words.map((w) => w.trim()).filter(Boolean);
      if (cleaned.length === 0) return "";
      for (let i = cleaned.length - 1; i >= 0; i--) {
        const norm = normalize(cleaned[i]);
        if (!norm) continue;
        if (!stopwords.has(norm)) return cleaned[i];
      }
      return cleaned[cleaned.length - 1];
    };

    const primary = new Set<string>();
    const secondary = new Set<string>();

    for (const c of res.chunks) {
      const rendered = c.rendered ?? "";
      const hasPrimary = rendered.includes("▲") || rendered.includes("ˈ");
      const hasSecondary = rendered.includes("△") || rendered.includes("ˌ");
      if (!hasPrimary && !hasSecondary) continue;

      const rep = pickRepresentativeWord(c.words ?? []);
      if (!rep) continue;

      if (hasPrimary) primary.add(rep);
      if (hasSecondary) secondary.add(rep);
    }

    return {
      primary: Array.from(primary),
      secondary: Array.from(secondary),
    };
  }

  const { primary, secondary } = extractStressWords(linkingResult);
  const p = primary.length ? primary.join(" / ") : "なし";
  const s = secondary.length ? secondary.join(" / ") : "なし";

  const ipaKeysCount = ipaIndex ? Object.keys(ipaIndex).length : 0;
  const hasParens = /\(|\)|（|）/.test(linkingResult.joined ?? "");

  return (
    <>
      <Space
        size={8}
        wrap
        style={{ display: "flex", alignItems: "center", marginBottom: 8 }}
      >
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
        {linkingDisplayMode === "phoneme" && (
          <Typography.Text type="secondary">
            {`IPA audio: ${ipaKeysCount} keys | mode: ${linkingDisplayMode} | parens: ${
              hasParens ? "yes" : "no"
            }`}
            {lastHoveredTok ? ` | last: ${lastHoveredTok}` : ""}
            {/*lastHoveredTok && lastHoveredHasDetails
              ? " | Click for details"
              : ""*/}
          </Typography.Text>
        )}
      </Space>

      <div style={{ marginBottom: 6, lineHeight: 1.7 }}>{renderLegend()}</div>

      {(linkingDisplayMode === "phoneme" || linkingDisplayMode === "kana") && (
        <Typography.Text
          type="secondary"
          style={{ display: "block", marginBottom: 10, lineHeight: 1.7 }}
        >
          {`強勢: ${p} / 副強勢: ${s}`}
        </Typography.Text>
      )}

      <div style={{ display: "block", fontSize: 18, lineHeight: 1.9 }}>
        {renderStressColored(linkingResult.joined)}
      </div>
    </>
  );
}
