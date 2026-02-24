import { resolveResource } from "@tauri-apps/api/path";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";

let audioEl: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let audioUnlocked = false;
let playRequestId = 0;
let audioCtx: AudioContext | null = null;
let currentBufferSource: AudioBufferSourceNode | null = null;

function isAndroidRuntime(): boolean {
  const ua =
    typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : "";
  return /Android/i.test(ua);
}

function getAudioContext(): AudioContext | null {
  const Ctor =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  return audioCtx;
}

function stopCurrentBufferSource(): void {
  if (!currentBufferSource) return;
  try {
    currentBufferSource.stop();
  } catch {
    // ignore
  }
  try {
    currentBufferSource.disconnect();
  } catch {
    // ignore
  }
  currentBufferSource = null;
}

function readAscii(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

function tryParsePcm16Wav(bytes: Uint8Array): {
  channels: number;
  sampleRate: number;
  samples: Float32Array[];
} | null {
  const buf = toArrayBuffer(bytes);
  if (buf.byteLength < 44) return null;
  const view = new DataView(buf);

  if (readAscii(view, 0, 4) !== "RIFF") return null;
  if (readAscii(view, 8, 4) !== "WAVE") return null;

  let offset = 12;
  let fmtFound = false;
  let dataOffset = -1;
  let dataSize = 0;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;
    const chunkNext = chunkDataStart + chunkSize + (chunkSize % 2);
    if (chunkNext > view.byteLength) break;

    if (chunkId === "fmt " && chunkSize >= 16) {
      audioFormat = view.getUint16(chunkDataStart, true);
      channels = view.getUint16(chunkDataStart + 2, true);
      sampleRate = view.getUint32(chunkDataStart + 4, true);
      bitsPerSample = view.getUint16(chunkDataStart + 14, true);
      fmtFound = true;
    } else if (chunkId === "data") {
      dataOffset = chunkDataStart;
      dataSize = chunkSize;
    }

    offset = chunkNext;
  }

  if (!fmtFound || dataOffset < 0 || dataSize <= 0) return null;
  if (audioFormat !== 1) return null;
  if (bitsPerSample !== 16) return null;
  if (channels <= 0 || channels > 2) return null;
  if (sampleRate <= 0) return null;

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (channels * bytesPerSample));
  if (frameCount <= 0) return null;

  const samples = Array.from(
    { length: channels },
    () => new Float32Array(frameCount),
  );
  let p = dataOffset;

  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const s = view.getInt16(p, true);
      p += 2;
      samples[ch][i] = Math.max(-1, Math.min(1, s / 32768));
    }
  }

  return { channels, sampleRate, samples };
}

async function playWavWithWebAudio(bytes: Uint8Array): Promise<boolean> {
  const parsed = tryParsePcm16Wav(bytes);
  if (!parsed) return false;

  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  stopCurrentBufferSource();

  const { channels, sampleRate, samples } = parsed;
  const buffer = ctx.createBuffer(channels, samples[0].length, sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    buffer.getChannelData(ch).set(samples[ch]);
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => {
    if (currentBufferSource === source) {
      currentBufferSource = null;
    }
  };
  currentBufferSource = source;
  source.start();
  return true;
}

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
  sampleRate: number = 8000,
): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.max(1, Math.floor((durationMs / 3000) * sampleRate));
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

function isNoSupportedSourceError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const anyErr = e as any;
  const msg = String(anyErr?.message ?? "");
  return /no supported source/i.test(msg);
}

async function playDecodedAudioWithWebAudio(
  bytes: Uint8Array,
): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  stopCurrentBufferSource();

  try {
    const ab = toArrayBuffer(bytes);
    const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
      // Some WebViews still use callback-style decodeAudioData.
      const anyCtx = ctx as any;
      const p = anyCtx.decodeAudioData(
        ab.slice(0),
        (buf: AudioBuffer) => resolve(buf),
        (err: unknown) => reject(err),
      );
      if (p && typeof p.then === "function") {
        p.then(resolve, reject);
      }
    });

    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    source.onended = () => {
      if (currentBufferSource === source) {
        currentBufferSource = null;
      }
    };
    currentBufferSource = source;
    source.start();
    return true;
  } catch {
    return false;
  }
}

function guessContentType(path: string): string {
  const p = (path ?? "").toLowerCase();
  if (p.endsWith(".wav")) return "audio/wav";
  if (p.endsWith(".m4a")) return "audio/mp4";
  if (p.endsWith(".mp3")) return "audio/mpeg";
  if (p.endsWith(".ogg")) return "audio/ogg";
  return "application/octet-stream";
}

function androidAudioFallbackPaths(p: string): string[] {
  if (!isAndroidRuntime()) return [p];
  const s = (p ?? "").trim();
  if (!s) return [p];
  // Prefer MP3 on Android WebView because MP4/AAC demux can be flaky.
  if (s.toLowerCase().endsWith(".m4a")) {
    const mp3 = s.slice(0, -4) + ".mp3";
    return [mp3, s];
  }
  return [s];
}

function bytesLookLikeHtml(bytes: Uint8Array): boolean {
  const max = Math.min(bytes.byteLength, 96);
  let s = "";
  for (let i = 0; i < max; i++) {
    const b = bytes[i];
    // skip leading whitespace
    if (
      s.length === 0 &&
      (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09)
    ) {
      continue;
    }
    if (b === 0) break;
    // keep printable-ish range
    if (b >= 0x20 && b <= 0x7e) s += String.fromCharCode(b);
  }
  const t = s.trim().toLowerCase();
  return (
    t.startsWith("<!doctype") ||
    t.startsWith("<html") ||
    t.startsWith("<head") ||
    t.startsWith("<meta") ||
    t.startsWith("<script")
  );
}

async function loadBundledAudioBytesViaInvoke(
  resourcePath: string,
): Promise<Uint8Array | null> {
  const rel = resourcePath
    .trim()
    .replace(/^\/+/, "")
    .replace(/^resources\//, "");
  if (!rel) return null;

  try {
    const b64 = await invoke<string>("read_bundled_resource_base64", {
      resourcePath: rel,
    });
    if (!b64) return null;

    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    console.warn("[ipaPlayer] invoke read_bundled_resource_base64 failed", {
      resourcePath,
      rel,
      error: msg,
    });
    return null;
  }
}

async function loadBundledAudioBytesViaHttp(
  resourcePath: string,
): Promise<Uint8Array | null> {
  // Android dev builds can route these requests to the frontend dev server
  // (returning index.html) and some WebViews crash inside shouldInterceptRequest.
  // We keep this HTTP loader for non-Android only.
  if (isAndroidRuntime()) return null;

  const rel = resourcePath
    .trim()
    .replace(/^\/+/, "")
    .replace(/^resources\//, "");
  if (!rel) return null;

  const candidates = [
    `http://tauri.localhost/resources/${rel}`,
    `http://tauri.localhost/${rel}`,
    `https://tauri.localhost/resources/${rel}`,
    `https://tauri.localhost/${rel}`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const ct = String(res.headers.get("content-type") ?? "");
      const ab = await res.arrayBuffer();
      if (ab.byteLength <= 0) continue;
      const bytes = new Uint8Array(ab);

      // In dev, the frontend server can return index.html (200 OK) for unknown paths.
      // Don't treat that as audio.
      if (
        /text\/html|application\/json|text\/plain/i.test(ct) ||
        bytesLookLikeHtml(bytes)
      ) {
        continue;
      }

      return bytes;
    } catch {
      continue;
    }
  }

  return null;
}

export async function playBundledAudio(resourcePath: string): Promise<void> {
  const requestId = ++playRequestId;
  const baseCandidates = [
    resourcePath,
    resourcePath.replace(/^resources\//, ""),
    resourcePath.startsWith("resources/")
      ? resourcePath
      : `resources/${resourcePath}`,
  ].filter(Boolean);

  const candidates = Array.from(
    new Set(baseCandidates.flatMap((p) => androidAudioFallbackPaths(p))),
  );

  let bytes: Uint8Array | null = null;
  let loadedPath: string | null = null;
  let lastError: unknown = null;
  const debugTried: string[] = [];

  for (const p of candidates) {
    const viaInvoke = await loadBundledAudioBytesViaInvoke(p);
    if (viaInvoke) {
      bytes = viaInvoke;
      loadedPath = p;
      debugTried.push(`invoke:ok:${p}:${viaInvoke.byteLength}`);
      break;
    }
    debugTried.push(`invoke:miss:${p}`);
  }

  // On Android, reading bundled resources via plugin-fs `readFile(resolveResource(...))`
  // can trigger an OOM crash.  Tauri's FsPlugin.kt uses `openFd()` for uncompressed
  // APK assets, which returns a raw fd pointing to the APK itself while discarding
  // the offset/length.  Rust's `read_to_end()` then reads from the asset position to
  // the END of the APK (e.g. 368 MB for a debug build), instantly exceeding the
  // WebView's 268 MB heap limit.
  //
  // Compressed assets (JSON, MP3) avoid this because `openFd()` throws and the
  // plugin falls back to extracting the file to cache — but uncompressed assets
  // (WAV, etc.) hit the bug directly.
  //
  // Skip this path on Android; the invoke-based loader above is safe.
  if (!bytes && !isAndroidRuntime()) {
    for (const p of candidates) {
      try {
        const absPath = await resolveResource(p);
        const viaFs = await readFile(absPath);
        if (viaFs.byteLength <= 0) {
          debugTried.push(`fs:empty:${p}`);
          continue;
        }
        // Guard: if this is actually HTML/text, treat as miss.
        if (bytesLookLikeHtml(viaFs) || viaFs.byteLength < 1024) {
          debugTried.push(`fs:not-audio:${p}:${viaFs.byteLength}`);
          continue;
        }
        bytes = viaFs;
        loadedPath = p;
        debugTried.push(`fs:ok:${p}:${viaFs.byteLength}`);
        break;
      } catch (e) {
        lastError = e;
        const msg = String((e as any)?.message ?? e);
        debugTried.push(`fs:err:${p}:${msg}`);
      }
    }
  }

  // Intentionally do not use HTTP loader on Android.
  if (!bytes && !isAndroidRuntime()) {
    for (const p of candidates) {
      const viaHttp = await loadBundledAudioBytesViaHttp(p);
      if (viaHttp) {
        bytes = viaHttp;
        loadedPath = p;
        debugTried.push(`http:ok:${p}:${viaHttp.byteLength}`);
        break;
      }
      debugTried.push(`http:miss:${p}`);
    }
  }

  if (!bytes && !isAndroidRuntime()) {
    for (const p of candidates) {
      try {
        const absPath = await resolveResource(p);
        bytes = await readFile(absPath);
        loadedPath = p;
        debugTried.push(`fs:ok:${p}:${bytes.byteLength}`);
        break;
      } catch (e) {
        lastError = e;
        bytes = null;
        loadedPath = null;
        const msg = String((e as any)?.message ?? e);
        debugTried.push(`fs:err:${p}:${msg}`);
      }
    }
  }

  if (!bytes) {
    const detail = debugTried.join(" | ");
    throw new Error(
      `Failed to load bundled resource: ${resourcePath} (${String(lastError)}) [${detail}]`,
    );
  }

  if (bytes.byteLength <= 0) {
    throw new Error(`Empty bundled audio file: ${resourcePath}`);
  }

  // If a newer play request came in while we were loading, drop this one.
  if (requestId !== playRequestId) return;

  const mimeHintPath = loadedPath ?? resourcePath;

  // On Android, prefer WebAudio decode to avoid URL-loading paths that can crash some WebViews.
  if (isAndroidRuntime()) {
    if (/\.wav$/i.test(mimeHintPath)) {
      try {
        const played = await playWavWithWebAudio(bytes);
        if (played) return;
      } catch {
        // fall through
      }
    }
    const played = await playDecodedAudioWithWebAudio(bytes);
    if (played) return;
    // On Android, do NOT fall through to the HTMLAudio Blob-URL path.
    // Some Android WebViews crash (native SIGSEGV) when loading audio from
    // blob: URLs.  If WebAudio decoding also failed, give up gracefully.
    console.warn(
      "[ipaPlayer] Android: WebAudio decode failed, skipping Blob-URL fallback",
      { path: mimeHintPath, bytes: bytes.byteLength },
    );
    throw new Error(
      `Audio decode failed on Android (WebAudio unavailable) [path=${mimeHintPath} bytes=${bytes.byteLength}]`,
    );
  }

  if (bytes && /\.wav$/i.test(mimeHintPath)) {
    try {
      const played = await playWavWithWebAudio(bytes);
      if (played) return;
    } catch {
      // fallback to HTMLAudio path below
    }
  }

  const newUrl = URL.createObjectURL(
    new Blob([toArrayBuffer(bytes)], {
      type: guessContentType(mimeHintPath),
    }),
  );

  // If we got superseded right after creating the URL, clean up.
  if (requestId !== playRequestId) {
    URL.revokeObjectURL(newUrl);
    return;
  }

  const prevUrl = objectUrl;
  objectUrl = newUrl;
  if (prevUrl?.startsWith("blob:")) URL.revokeObjectURL(prevUrl);

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

    // Android WebView can fail to decode with HTMLAudio even when WebAudio works.
    if (isAndroidRuntime() && isNoSupportedSourceError(e)) {
      const played = await playDecodedAudioWithWebAudio(bytes);
      if (played) return;
    }

    if (isAutoplayBlockedError(e)) {
      throw new Error(
        "Audio playback was blocked (user gesture required). Click once on the screen, then try hover again.",
      );
    }

    const msg = String((e as any)?.message ?? e);
    const detail = debugTried.join(" | ");
    throw new Error(
      `Audio decode failed: ${msg} [path=${mimeHintPath} type=${guessContentType(mimeHintPath)} bytes=${bytes.byteLength}] [${detail}]`,
    );
  }
}

export async function bundledResourceExists(
  resourcePath: string,
): Promise<boolean> {
  const baseCandidates = [
    resourcePath,
    resourcePath.replace(/^resources\//, ""),
    resourcePath.startsWith("resources/")
      ? resourcePath
      : `resources/${resourcePath}`,
  ].filter(Boolean);

  const candidates = Array.from(
    new Set(baseCandidates.flatMap((p) => androidAudioFallbackPaths(p))),
  );

  // On Android, prefer the invoke path to avoid the APK-fd-offset OOM bug in
  // plugin-fs (see long comment in playBundledResource above).
  for (const p of candidates) {
    const viaInvoke = await loadBundledAudioBytesViaInvoke(p);
    if (viaInvoke) return true;
  }

  if (isAndroidRuntime()) return false;

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

  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      // ignore and continue with HTMLAudio unlock path
    }
  }

  const bytes = createSilentWavBytes(30);
  const url = URL.createObjectURL(
    new Blob([toArrayBuffer(bytes)], { type: "audio/wav" }),
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
  stopCurrentBufferSource();

  if (audioEl) {
    audioEl.pause();
    audioEl.src = "";
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  audioEl = null;
  if (audioCtx) {
    void audioCtx.close().catch(() => {
      // ignore
    });
    audioCtx = null;
  }
  audioUnlocked = false;
}
