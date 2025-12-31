import { useCallback, useEffect, useRef, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { convertFileSrc } from "@tauri-apps/api/core";
import { guessAudioMimeFromPath, isHttpUrl } from "./audioUtils";

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

  const ensureBlobAudioUrl = useCallback(async (pathOrUrl: string) => {
    if (!pathOrUrl) return null;
    if (pathOrUrl.startsWith("blob:")) return pathOrUrl;
    if (isHttpUrl(pathOrUrl)) return pathOrUrl;

    const cached = audioUrlsRef.current[pathOrUrl];
    if (cached) return cached;

    const existing = audioLoadInFlightRef.current.get(pathOrUrl);
    if (existing) return existing;

    const p = (async () => {
      try {
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
  }, []);

  const toAssetUrl = useCallback((pathOrUrl: string): string => {
    if (!pathOrUrl) return "";
    if (pathOrUrl.startsWith("blob:")) return pathOrUrl;
    if (isHttpUrl(pathOrUrl)) return pathOrUrl;
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
