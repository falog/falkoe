import { resolveResource } from "@tauri-apps/api/path";
import { readFile } from "@tauri-apps/plugin-fs";

let audioEl: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let audioUnlocked = false;
let playRequestId = 0;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // TS の型定義上、Uint8Array の buffer は ArrayBufferLike (SharedArrayBuffer を含む) になり得る。
  // Blob には ArrayBuffer を渡すことで型/互換性問題を回避する。
  if (bytes.buffer instanceof ArrayBuffer) {
    const start = bytes.byteOffset;
    const end = bytes.byteOffset + bytes.byteLength;
    return start === 0 && end === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(start, end);
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function createSilentWavBytes(
  durationMs: number,
  sampleRate: number = 8000
): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.max(1, Math.floor((durationMs / 1000) * sampleRate));
  const dataSize = numSamples * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++)
      view.setUint8(offset + i, s.charCodeAt(i));
  };

  // RIFF header
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");

  // fmt chunk
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true); // audio format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  // samples are already 0 (silence)

  return new Uint8Array(buffer);
}

function isAutoplayBlockedError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const anyErr = e as any;
  const name = String(anyErr?.name ?? "");
  const msg = String(anyErr?.message ?? "");
  return (
    name === "NotAllowedError" || /user gesture|not allowed|autoplay/i.test(msg)
  );
}

function isPlayInterruptedError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const anyErr = e as any;
  const name = String(anyErr?.name ?? "");
  const msg = String(anyErr?.message ?? "");
  return (
    name === "AbortError" ||
    /interrupted|The play\(\) request was interrupted/i.test(msg)
  );
}

function guessContentType(path: string): string {
  const p = (path ?? "").toLowerCase();
  if (p.endsWith(".wav")) return "audio/wav";
  if (p.endsWith(".mp3")) return "audio/mpeg";
  if (p.endsWith(".ogg")) return "audio/ogg";
  return "application/octet-stream";
}

export async function playBundledAudio(resourcePath: string): Promise<void> {
  const requestId = ++playRequestId;
  const candidates = Array.from(
    new Set(
      [
        resourcePath,
        resourcePath.replace(/^resources\//, ""),
        resourcePath.startsWith("resources/")
          ? resourcePath
          : `resources/${resourcePath}`,
      ].filter(Boolean)
    )
  );

  let bytes: Uint8Array | null = null;
  let absPath: string | null = null;
  let lastError: unknown = null;

  for (const p of candidates) {
    try {
      absPath = await resolveResource(p);
    } catch (e) {
      lastError = e;
      absPath = null;
      continue;
    }

    try {
      bytes = await readFile(absPath);
      break;
    } catch (e) {
      // In dev, resolveResource can return a path that doesn't exist
      // depending on how resources are synced. Try the next candidate.
      lastError = e;
      bytes = null;
      absPath = null;
      continue;
    }
  }

  if (!bytes) {
    throw new Error(
      `Failed to load bundled resource: ${resourcePath} (${String(lastError)})`
    );
  }

  // If a newer play request came in while we were loading, drop this one.
  if (requestId !== playRequestId) return;

  const newUrl = URL.createObjectURL(
    new Blob([toArrayBuffer(bytes)], { type: guessContentType(resourcePath) })
  );

  // If we got superseded right after creating the URL, clean up.
  if (requestId !== playRequestId) {
    URL.revokeObjectURL(newUrl);
    return;
  }

  const prevUrl = objectUrl;
  objectUrl = newUrl;
  if (prevUrl) URL.revokeObjectURL(prevUrl);

  if (!audioEl) audioEl = new Audio();

  audioEl.pause();
  audioEl.currentTime = 0;
  audioEl.src = objectUrl;
  try {
    await audioEl.play();
  } catch (e) {
    // If a newer request took over, treat this as a cancellation.
    if (requestId !== playRequestId) return;
    // Rapid hover can interrupt play() on many WebViews. Not a real error.
    if (isPlayInterruptedError(e)) return;
    if (isAutoplayBlockedError(e)) {
      throw new Error(
        "Audio playback was blocked (user gesture required). Click once on the screen, then try hover again."
      );
    }
    throw e;
  }
}

export async function bundledResourceExists(
  resourcePath: string
): Promise<boolean> {
  const candidates = Array.from(
    new Set(
      [
        resourcePath,
        resourcePath.replace(/^resources\//, ""),
        resourcePath.startsWith("resources/")
          ? resourcePath
          : `resources/${resourcePath}`,
      ].filter(Boolean)
    )
  );

  for (const p of candidates) {
    let absPath: string;
    try {
      absPath = await resolveResource(p);
    } catch {
      continue;
    }

    try {
      await readFile(absPath);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

/**
 * Some WebViews block Audio.play() unless it is triggered from a user gesture.
 * Call this once from a click/pointerdown handler to unlock audio.
 */
export async function unlockAudioFromUserGesture(): Promise<void> {
  if (audioUnlocked) return;
  if (!audioEl) audioEl = new Audio();

  const bytes = createSilentWavBytes(30);
  const url = URL.createObjectURL(
    new Blob([toArrayBuffer(bytes)], { type: "audio/wav" })
  );

  try {
    audioEl.pause();
    audioEl.currentTime = 0;
    audioEl.src = url;
    await audioEl.play();
    audioEl.pause();
    audioEl.currentTime = 0;
    audioUnlocked = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function isAudioUnlocked(): boolean {
  return audioUnlocked;
}

export function disposeBundledAudioPlayer(): void {
  if (audioEl) {
    audioEl.pause();
    audioEl.src = "";
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  audioEl = null;
  audioUnlocked = false;
}
