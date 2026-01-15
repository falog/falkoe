import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message } from "antd";
import { coerceModelStatus, type ModelStatus } from "../../types/model";
import { useTranslation } from "react-i18next";

export function useModelStatus() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ModelStatus>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const modelMissingShown = useRef(false);

  useEffect(() => {
    let cancelled = false;

    invoke<string>("get_model_status")
      .then((s) => {
        if (cancelled) return;
        setStatus(coerceModelStatus(s));
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("idle");
      });

    const unlistenPromise = listen<string>("model-status", (e) => {
      setStatus(coerceModelStatus(e.payload));
    });

    return () => {
      cancelled = true;
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
      message.info(t("screens.recorder.messages.modelMissingDownloadStart"));
    }
  }, [status, t]);

  return { status, progress };
}
