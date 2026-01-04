import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useUpsertSentenceManifest(params: {
  sentenceHash: string;
  text: string | null | undefined;
  lang: string | null | undefined;
}) {
  const { sentenceHash, text, lang } = params;

  // Persist/ensure manifest.json so the History screen can list this sentence reliably.
  useEffect(() => {
    const t = text?.trim() ?? "";
    const l = lang?.trim() ?? "";
    if (!sentenceHash || !t || !l) return;

    invoke("upsert_sentence_manifest_text", {
      audioId: sentenceHash,
      lang: l,
      text: t,
      overwrite: false,
    }).catch(() => {
      // Non-fatal: history listing will just be less informative.
    });
  }, [sentenceHash, text, lang]);
}
