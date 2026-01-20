import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SentenceAttribution } from "../../components/ExampleList";

export function useUpsertSentenceManifest(params: {
  sentenceHash: string;
  text: string | null | undefined;
  lang: string | null | undefined;
  attribution?: SentenceAttribution | null | undefined;
}) {
  const { sentenceHash, text, lang, attribution } = params;

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

  const attributionKey = attribution
    ? [
        attribution.provider,
        attribution.sentenceLicense,
        attribution.sentenceOwner ?? "",
        attribution.sentenceUrl,
        attribution.audioLicense,
        attribution.audioAuthor ?? "",
        attribution.audioAttributionUrl ?? "",
        String(attribution.audioId ?? ""),
      ].join("|")
    : "";

  useEffect(() => {
    const l = lang?.trim() ?? "";
    if (!sentenceHash || !l) return;
    if (!attribution || attribution.provider !== "tatoeba") return;

    invoke("upsert_sentence_manifest_attribution", {
      audioId: sentenceHash,
      lang: l,
      attribution,
    }).catch(() => {
      // Non-fatal: credits just won't be shown in History -> open flow.
    });
  }, [sentenceHash, lang, attributionKey]);
}
