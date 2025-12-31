import { useState, useEffect, type RefObject } from "react";
import { message } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const useModelStatus = (modelMissingShown: RefObject<boolean>) => {
  const [status, setStatus] = useState<string>("idle");
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    invoke<string>("get_model_status")
      .then(setStatus)
      .catch(() => setStatus("idle"));

    const unlistenPromise = listen<string>("model-status", (e) => {
      setStatus(e.payload);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<number>("model-progress", (e) => {
      setProgress(e.payload);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (status === "downloading" && !modelMissingShown.current) {
      modelMissingShown.current = true;
      message.info("音声認識モデルがありません。ダウンロードを開始します。");
    }
  }, [status, modelMissingShown]);

  return { status, progress };
};
