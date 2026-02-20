import { message } from "antd";
import i18next from "i18next";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { isAndroidRuntime } from "../../utils/runtimePlatform";
import { guardAndroidIpcFileSize } from "../../utils/androidFileSizeGuard";

let sharedAudioEl: HTMLAudioElement | null = null;
let sharedPlayId = 0;

let sharedAudioCtx: AudioContext | null = null;
let currentBufferSource: AudioBufferSourceNode | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AnyAudioContext =
    (window as any).AudioContext ?? (window as any).webkitAudioContext;
  if (!AnyAudioContext) return null;
  if (!sharedAudioCtx) sharedAudioCtx = new AnyAudioContext();
  return sharedAudioCtx;
}

function stopCurrentBufferSource(): void {
  if (!currentBufferSource) return;
  try {
    currentBufferSource.stop();
  } catch {
    // ignore
  }
  currentBufferSource = null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

async function loadBytesFromUrlLike(url: string): Promise<Uint8Array> {
  if (url.startsWith("blob:")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch blob failed: ${res.status}`);
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }

  if (isHttpUrl(url)) {
    // Cache to local file first to reduce network/URL-handling inside WebView.
    const audioId = `tatoeba-${await (async () => {
      try {
        const u = new URL(url);
        return u.pathname.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 60) || "audio";
      } catch {
        return "audio";
      }
    })()}`;

    const cachedPath = await invoke<string>("ensure_sentence_audio_cached", {
      audioId,
      url,
    });
    await guardAndroidIpcFileSize(cachedPath, { label: "audio" });
    return await readFile(cachedPath);
  }

  // Treat as local path
  await guardAndroidIpcFileSize(url, { label: "audio" });
  return await readFile(url);
}

async function playBytesWithWebAudio(bytes: Uint8Array): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;

  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  stopCurrentBufferSource();

  try {
    const ab = toArrayBuffer(bytes);
    const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
      const anyCtx = ctx as any;
      const p = anyCtx.decodeAudioData(
        ab.slice(0),
        (buf: AudioBuffer) => resolve(buf),
        (err: unknown) => reject(err),
      );
      if (p && typeof p.then === "function") p.then(resolve, reject);
    });

    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    source.onended = () => {
      if (currentBufferSource === source) currentBufferSource = null;
    };
    currentBufferSource = source;
    source.start();
    return true;
  } catch (e) {
    console.warn("[uiUtils] WebAudio decode failed", e);
    return false;
  }
}

async function playUrlAndroidWebAudio(url: string): Promise<boolean> {
  const bytes = await loadBytesFromUrlLike(url);
  return await playBytesWithWebAudio(bytes);
}

function getSharedAudioEl(): HTMLAudioElement {
  if (!sharedAudioEl) {
    sharedAudioEl = new Audio();
    sharedAudioEl.preload = "auto";
    sharedAudioEl.autoplay = false;
    sharedAudioEl.muted = false;
    sharedAudioEl.volume = 1;
  }
  return sharedAudioEl;
}

export function confirmOverwriteExisting(): Promise<boolean> {
  return new Promise((resolve) => {
    message.info({
      content: i18next.t("screens.recorder.messages.overwriteExistingAutoOk"),
      duration: 1,
      onClick: () => resolve(true),
      onClose: () => resolve(false),
    });
    setTimeout(() => resolve(true), 1000);
  });
}

export async function playAudioUrl(url: string | null) {
  if (!url) {
    message.info(i18next.t("screens.recorder.messages.audioLoading"));
    return;
  }

  try {
    if (isAndroidRuntime()) {
      const ok = await playUrlAndroidWebAudio(url);
      if (!ok) {
        message.error(i18next.t("screens.recorder.messages.audioPlaybackFailed"));
      }
      return;
    }

    const playId = ++sharedPlayId;
    const audio = getSharedAudioEl();

    audio.pause();
    audio.currentTime = 0;
    audio.src = url;
    audio.load();

    const played = audio.play();
    await played;

    // Some WebViews can resolve play() but still never start. If this request
    // is still current and we haven't advanced at all, emit a debug hint.
    await new Promise((r) => setTimeout(r, 250));
    if (playId === sharedPlayId && audio.paused && audio.currentTime === 0) {
      console.warn("Audio.play() did not start (paused at 0s)", {
        url,
        error: audio.error,
        readyState: audio.readyState,
        networkState: audio.networkState,
      });
    }
  } catch (e) {
    console.error("Audio playback failed:", e);
    message.error(i18next.t("screens.recorder.messages.audioPlaybackFailed"));
  }
}

export async function playAudioUrlUntilEnded(
  url: string | null
): Promise<boolean> {
  if (!url) {
    message.info(i18next.t("screens.recorder.messages.audioLoading"));
    return false;
  }

  try {
    if (isAndroidRuntime()) {
      // WebAudio path: we can't reliably await "ended" without extra wiring.
      // For current UX this function is used as a best-effort gate; return true if playback starts.
      const ok = await playUrlAndroidWebAudio(url);
      if (!ok) {
        message.error(i18next.t("screens.recorder.messages.audioPlaybackFailed"));
      }
      return ok;
    }

    const playId = ++sharedPlayId;
    const audio = getSharedAudioEl();

    audio.pause();
    audio.currentTime = 0;
    audio.src = url;
    audio.load();

    await audio.play();

    const ok = await new Promise<boolean>((resolve) => {
      audio.addEventListener("ended", () => resolve(true), { once: true });
      audio.addEventListener("error", () => resolve(false), { once: true });
    });

    if (playId !== sharedPlayId) return false;

    return ok;
  } catch (e) {
    console.error("Audio playback failed:", e);
    message.error(i18next.t("screens.recorder.messages.audioPlaybackFailed"));
    return false;
  }
}
