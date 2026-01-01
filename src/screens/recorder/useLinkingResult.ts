import { useEffect, useState } from "react";
import { renderLinkingRust } from "../../utils/linkingInvoke";
import type { DisplayMode, RenderLinkingResult } from "../../types/linking";

type Args = {
  displayText: string;
  sentenceText: string;
  lang: string;
  linkingDisplayMode: DisplayMode;
};

export function useLinkingResult({
  displayText,
  sentenceText,
  lang,
  linkingDisplayMode,
}: Args): RenderLinkingResult | null {
  const [linkingResult, setLinkingResult] =
    useState<RenderLinkingResult | null>(null);

  useEffect(() => {
    const text = (displayText || sentenceText || "").trim();
    if (!text || lang !== "eng") {
      setLinkingResult(null);
      return;
    }

    let cancelled = false;

    renderLinkingRust(text, {
      linkingMode: true,
      displayMode: linkingDisplayMode,
      useDict: true,
    })
      .then((res) => {
        if (cancelled) return;
        setLinkingResult(res);
      })
      .catch((e) => {
        console.warn("render_linking failed", e);
        if (cancelled) return;
        setLinkingResult(null);
      });

    return () => {
      cancelled = true;
    };
  }, [displayText, sentenceText, lang, linkingDisplayMode]);

  return linkingResult;
}
