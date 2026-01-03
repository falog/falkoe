import { useEffect, useMemo, useState } from "react";
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

  // Keyed state prevents a brief window where the previous sentence's audio URL
  // is still visible (and clickable) after switching sentences.
  const headerAudioKey = useMemo(() => {
    return [
      sourceKind,
      sentenceAudioUrl,
      sentenceHash,
      uploadedAudioPath ?? "",
      preferAssetProtocol ? "1" : "0",
      hasUploadedFile ? "1" : "0",
    ].join("|");
  }, [
    sourceKind,
    sentenceAudioUrl,
    sentenceHash,
    uploadedAudioPath,
    preferAssetProtocol,
    hasUploadedFile,
  ]);

  type HeaderAudioOwner = "none" | "self" | "cache";
  const [state, setState] = useState<{
    key: string;
    url: string | null;
    loading: boolean;
    owner: HeaderAudioOwner;
  }>(() => ({ key: headerAudioKey, url: null, loading: false, owner: "none" }));

  const headerAudioUrl = state.key === headerAudioKey ? state.url : null;
  const isHeaderAudioLoading =
    state.key === headerAudioKey ? state.loading : true;

  useEffect(() => {
    let cancelled = false;

    // Immediately mark as loading for the new key.
    setState((prev) => {
      if (prev.key === headerAudioKey) {
        return { ...prev, loading: true };
      }
      return { key: headerAudioKey, url: null, loading: true, owner: "none" };
    });

    const init = async () => {
      try {
        if (sourceKind === "uploaded") {
          if (hasUploadedFile) {
            if (!cancelled) {
              setState({
                key: headerAudioKey,
                url: sentenceAudioUrl,
                loading: false,
                owner: "none",
              });
            }
            return;
          }

          if (uploadedAudioPath) {
            if (preferAssetProtocol) {
              if (!cancelled) {
                setState({
                  key: headerAudioKey,
                  url: toAssetUrl(uploadedAudioPath),
                  loading: false,
                  owner: "none",
                });
              }
              return;
            }
            const blobUrl = await ensureBlobAudioUrl(uploadedAudioPath);
            if (!cancelled) {
              setState({
                key: headerAudioKey,
                url: blobUrl,
                loading: false,
                owner: "cache",
              });
            }
            return;
          }

          if (!cancelled) {
            setState({
              key: headerAudioKey,
              url: null,
              loading: false,
              owner: "none",
            });
          }
          return;
        }

        if (sourceKind === "recorded") {
          const blobUrl = await ensureBlobAudioUrl(sentenceAudioUrl);
          if (!cancelled) {
            setState({
              key: headerAudioKey,
              url: blobUrl,
              loading: false,
              owner: "cache",
            });
          }
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
                if (!cancelled) {
                  setState({
                    key: headerAudioKey,
                    url: toAssetUrl(cachedPath),
                    loading: false,
                    owner: "none",
                  });
                }
                return;
              }

              const blobUrl = await ensureBlobAudioUrl(cachedPath);
              if (!cancelled) {
                setState({
                  key: headerAudioKey,
                  url: blobUrl,
                  loading: false,
                  owner: "cache",
                });
              }
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

            if (!cancelled) {
              setState({
                key: headerAudioKey,
                url: blobUrl,
                loading: false,
                owner: "self",
              });
            }
            return;
          } catch (fetchError) {
            console.warn(
              "[useHeaderAudioUrl] fetch_audio_base64 failed; fallback to direct URL",
              fetchError
            );
            if (!cancelled) {
              setState({
                key: headerAudioKey,
                url: sentenceAudioUrl,
                loading: false,
                owner: "none",
              });
            }
            return;
          }
        }

        const blobUrl = await ensureBlobAudioUrl(sentenceAudioUrl);
        if (!cancelled) {
          setState({
            key: headerAudioKey,
            url: blobUrl,
            loading: false,
            owner: "cache",
          });
        }
      } catch (e) {
        console.error("[useHeaderAudioUrl] Failed:", e);
        if (!cancelled) {
          message.error("音声の読み込みに失敗しました: " + String(e));
          setState({
            key: headerAudioKey,
            url: null,
            loading: false,
            owner: "none",
          });
        }
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
    headerAudioKey,
  ]);

  useEffect(() => {
    return () => {
      // Only revoke blob URLs created by this hook (base64 fetch path).
      // Blob URLs from the shared audio cache are managed by that cache.
      if (state.owner === "self" && state.url?.startsWith("blob:")) {
        URL.revokeObjectURL(state.url);
      }
    };
  }, [state.owner, state.url]);

  return { headerAudioUrl, isHeaderAudioLoading };
}
