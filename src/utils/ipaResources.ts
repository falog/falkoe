import { resolveResource } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";

export type IpaIndexEntry = {
  ipa: string;
  // Optional because some symbols (e.g. stress marks) may not have audio.
  audio?: string; // e.g. "resources/ipa/audio/p.mp3" or "ipa/audio/p.mp3"
  // Optional: a separate audio clip to play on click (e.g. a short explanation).
  explainAudio?: string;
  examples?: string[];
  description?: string;
};

export type IpaIndex = Record<string, IpaIndexEntry>;

const IPA_INDEX_RESOURCE_PATH = "resources/ipa/index.json";

function normalizeResourcePath(p: string): string {
  const trimmed = (p ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("resources/")) return trimmed;
  return `resources/${trimmed.replace(/^\/+/, "")}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIpaIndexEntry(
  v: unknown
): v is Record<string, unknown> & { ipa: string } {
  return (
    isPlainObject(v) && typeof v.ipa === "string" && v.ipa.trim().length > 0
  );
}

function addEntry(out: IpaIndex, key: string, entry: IpaIndexEntry): void {
  const k = (key ?? "").trim();
  if (!k) return;
  // Don't overwrite an existing mapping (prefer first occurrence).
  if (out[k]) return;
  out[k] = entry;
}

function flattenIndexTree(
  node: unknown,
  out: IpaIndex,
  keyHint?: string
): void {
  if (isIpaIndexEntry(node)) {
    const rawAudio = typeof node.audio === "string" ? node.audio : undefined;
    const rawExplainAudio =
      typeof (node as any).explainAudio === "string"
        ? ((node as any).explainAudio as string)
        : typeof (node as any).clickAudio === "string"
          ? ((node as any).clickAudio as string)
          : undefined;
    const entry: IpaIndexEntry = {
      ipa: node.ipa,
      audio: rawAudio ? normalizeResourcePath(rawAudio) : undefined,
      explainAudio: rawExplainAudio
        ? normalizeResourcePath(rawExplainAudio)
        : undefined,
      examples: Array.isArray(node.examples)
        ? node.examples.filter((x): x is string => typeof x === "string")
        : undefined,
      description:
        typeof node.description === "string" ? node.description : undefined,
    };

    // Primary key should match the actual IPA token in rendered text.
    addEntry(out, entry.ipa, entry);

    // Also accept the JSON key if it differs (e.g. { "r": { ipa: "ɹ" } }).
    if (keyHint && keyHint !== entry.ipa) {
      addEntry(out, keyHint, entry);
    }
    return;
  }

  if (!isPlainObject(node)) return;

  for (const [k, v] of Object.entries(node)) {
    flattenIndexTree(v, out, k);
  }
}

export async function loadIpaIndex(): Promise<IpaIndex> {
  const indexPath = await resolveResource(IPA_INDEX_RESOURCE_PATH);
  const text = await readTextFile(indexPath);
  const parsed = JSON.parse(text) as unknown;

  // Support both the old flat schema (Record<string, entry>) and the new nested schema
  // ({ consonants, vowels, other: { stress, ... } }).
  const out: IpaIndex = {};
  flattenIndexTree(parsed, out);
  return out;
}
