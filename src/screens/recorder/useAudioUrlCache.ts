import { useCallback, useEffect, useRef, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { guessAudioMimeFromPath, isHttpUrl } from "./audioUtils";
import { isAndroidRuntime } from "../../utils/runtimePlatform";
import { guardAndroidIpcFileSize } from "../../utils/androidFileSizeGuard";

export function useAudioUrlCache() {
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const audioUrlsRef = useRef<Record<string, string>>({});
  const audioLoadInFlightRef = useRef<Map<string, Promise<string | null>>>(
    new Map()
  );

  useEffect(() => {
    audioUrlsRef.current = audioUrls;
  }, [audioUrls]);

  useEffect(() => {
    return () => {
      for (const url of Object.values(audioUrlsRef.current)) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      }
    };
  }, []);

  const ensureBlobAudioUrl = useCallback(
    async (pathOrUrl: string, opts?: { forceReload?: boolean }) => {
    if (!pathOrUrl) return null;
    if (pathOrUrl.startsWith("blob:")) return pathOrUrl;
    if (isHttpUrl(pathOrUrl)) return pathOrUrl;

    if (opts?.forceReload) {
      audioLoadInFlightRef.current.delete(pathOrUrl);
      setAudioUrls((prev) => {
        const existing = prev[pathOrUrl];
        if (existing?.startsWith("blob:")) URL.revokeObjectURL(existing);
        if (!(pathOrUrl in prev)) return prev;
        const next = { ...prev };
        delete next[pathOrUrl];
        return next;
      });
    }

    const cached = audioUrlsRef.current[pathOrUrl];
    if (cached && !opts?.forceReload) return cached;

    const existing = audioLoadInFlightRef.current.get(pathOrUrl);
    if (existing && !opts?.forceReload) return existing;

    const p = (async () => {
      try {
        // Android WebView can be picky about WAV variants (e.g. float WAV).
        // Best-effort: normalize to PCM16 before loading bytes.
        if (isAndroidRuntime() && /\.wav$/i.test(pathOrUrl)) {
          try {
            await invoke("ensure_wav_pcm16", { path: pathOrUrl });
          } catch {
            // ignore; we'll still try to read+play as-is
          }
        }

        await guardAndroidIpcFileSize(pathOrUrl, { label: "audio" });
        const fileBytes = await readFile(pathOrUrl);
        const mime = guessAudioMimeFromPath(pathOrUrl);
        const blob = new Blob([fileBytes], { type: mime });
        const url = URL.createObjectURL(blob);
        setAudioUrls((prev) => ({ ...prev, [pathOrUrl]: url }));
        return url;
      } catch (e) {
        console.error("[useAudioUrlCache] ensureBlobAudioUrl failed", {
          pathOrUrl,
          error: e,
        });
        return null;
      } finally {
        audioLoadInFlightRef.current.delete(pathOrUrl);
      }
    })();

    audioLoadInFlightRef.current.set(pathOrUrl, p);
    return p;
    },
    []
  );

  const toAssetUrl = useCallback((pathOrUrl: string): string => {
    if (!pathOrUrl) return "";
    if (pathOrUrl.startsWith("blob:")) return pathOrUrl;
    if (isHttpUrl(pathOrUrl)) return pathOrUrl;

    // On Android, routing local files through the asset/protocol bridge can
    // trigger huge native allocations (OOM) for large recordings. Prefer Blob
    // URLs (ensureBlobAudioUrl) instead.
    if (isAndroidRuntime()) return "";
    return convertFileSrc(pathOrUrl);
  }, []);

  const resetAudioUrls = useCallback(() => {
    setAudioUrls((prev) => {
      for (const url of Object.values(prev)) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      }
      return {};
    });
  }, []);

  return { audioUrls, ensureBlobAudioUrl, toAssetUrl, resetAudioUrls };
}
