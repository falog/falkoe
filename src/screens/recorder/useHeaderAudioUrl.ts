import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { message } from "antd";
import { guessAudioMimeFromPath, isHttpUrl } from "./audioUtils";
import type { SourceKind } from "../../types/speech";

type HeaderAudioArgs = {
  sourceKind: SourceKind;
  sentenceAudioUrl: string;
  sentenceHash: string;
  uploadedAudioPath: string | null;
  preferAssetProtocol: boolean;
  ensureBlobAudioUrl: (pathOrUrl: string) => Promise<string | null>;
  toAssetUrl: (pathOrUrl: string) => string;
  hasUploadedFile: boolean;
};

export function useHeaderAudioUrl(args: HeaderAudioArgs) {
  const {
    sourceKind,
    sentenceAudioUrl,
    sentenceHash,
    uploadedAudioPath,
    preferAssetProtocol,
    ensureBlobAudioUrl,
    toAssetUrl,
    hasUploadedFile,
  } = args;

  const [headerAudioUrl, setHeaderAudioUrl] = useState<string | null>(null);
  const [isHeaderAudioLoading, setIsHeaderAudioLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      setIsHeaderAudioLoading(true);
      try {
        if (sourceKind === "uploaded") {
          if (hasUploadedFile) {
            if (!cancelled) setHeaderAudioUrl(sentenceAudioUrl);
            return;
          }

          if (uploadedAudioPath) {
            if (preferAssetProtocol) {
              if (!cancelled) setHeaderAudioUrl(toAssetUrl(uploadedAudioPath));
              return;
            }
            const blobUrl = await ensureBlobAudioUrl(uploadedAudioPath);
            if (!cancelled) setHeaderAudioUrl(blobUrl);
            return;
          }

          if (!cancelled) setHeaderAudioUrl(null);
          return;
        }

        if (sourceKind === "recorded") {
          const blobUrl = await ensureBlobAudioUrl(sentenceAudioUrl);
          if (!cancelled) setHeaderAudioUrl(blobUrl);
          return;
        }

        // tatoeba
        if (isHttpUrl(sentenceAudioUrl)) {
          try {
            // Prefer caching to local file to avoid repeated network fetches.
            if (sentenceHash) {
              const cachedPath = await invoke<string>(
                "ensure_sentence_audio_cached",
                {
                  audioId: sentenceHash,
                  url: sentenceAudioUrl,
                }
              );

              if (preferAssetProtocol) {
                if (!cancelled) setHeaderAudioUrl(toAssetUrl(cachedPath));
                return;
              }

              const blobUrl = await ensureBlobAudioUrl(cachedPath);
              if (!cancelled) setHeaderAudioUrl(blobUrl);
              return;
            }

            const base64Data = await invoke<string>("fetch_audio_base64", {
              url: sentenceAudioUrl,
            });

            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const blob = new Blob([bytes], {
              type: guessAudioMimeFromPath(sentenceAudioUrl),
            });
            const blobUrl = URL.createObjectURL(blob);

            if (!cancelled) setHeaderAudioUrl(blobUrl);
            return;
          } catch (fetchError) {
            console.warn(
              "[useHeaderAudioUrl] fetch_audio_base64 failed; fallback to direct URL",
              fetchError
            );
            if (!cancelled) setHeaderAudioUrl(sentenceAudioUrl);
            return;
          }
        }

        const blobUrl = await ensureBlobAudioUrl(sentenceAudioUrl);
        if (!cancelled) setHeaderAudioUrl(blobUrl);
      } catch (e) {
        console.error("[useHeaderAudioUrl] Failed:", e);
        if (!cancelled) {
          message.error("音声の読み込みに失敗しました: " + String(e));
          setHeaderAudioUrl(null);
        }
      } finally {
        if (!cancelled) setIsHeaderAudioLoading(false);
      }
    };

    void init();

    return () => {
      cancelled = true;
    };
  }, [
    sourceKind,
    sentenceAudioUrl,
    sentenceHash,
    uploadedAudioPath,
    preferAssetProtocol,
    ensureBlobAudioUrl,
    toAssetUrl,
    hasUploadedFile,
  ]);

  useEffect(() => {
    return () => {
      if (headerAudioUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(headerAudioUrl);
      }
    };
  }, [headerAudioUrl]);

  return { headerAudioUrl, isHeaderAudioLoading };
}
