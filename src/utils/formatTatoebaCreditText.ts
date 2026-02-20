import type { TFunction } from "i18next";

export type TatoebaAttributionForCredit = {
  provider: "tatoeba";
  sentenceLicense: string;
  sentenceOwner?: string | null;
  audioLicense: string;
  audioAuthor?: string | null;
};

export function formatTatoebaCreditText(
  attribution: TatoebaAttributionForCredit,
  t: TFunction,
): string {
  const prefix = t("tatoeba.creditPrefix");
  const sentenceLabel = t("tatoeba.creditSentenceLabel");
  const audioLabel = t("tatoeba.creditAudioLabel");

  const owner = (attribution.sentenceOwner ?? "?").trim() || "?";
  const author = (attribution.audioAuthor ?? "?").trim() || "?";

  return (
    `${prefix} ${sentenceLabel}: ${owner} (${attribution.sentenceLicense})` +
    ` / ${audioLabel}: ${author} (${attribution.audioLicense})`
  );
}
