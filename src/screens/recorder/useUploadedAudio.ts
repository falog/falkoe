import { useEffect, useRef, useState } from "react";
import { message } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { confirmOverwriteExisting } from "./uiUtils";
import { useTranslation } from "react-i18next";

type UploadedAudioInfo = {
  exists: boolean;
  path: string;
};

type Params = {
  source: any;
  sentenceHash: string;
  sentenceText: string;
  lang: string;
};

export function useUploadedAudio({
  source,
  sentenceHash,
  sentenceText,
  lang,
}: Params) {
  const { t } = useTranslation();
  const uploadedFileRef = useRef<File | null>(null);
  const uploadedFileUrlRef = useRef<string | null>(null);

  const [uploadedFileAudioUrl, setUploadedFileAudioUrl] = useState<string>("");
  const [uploadedAudioPath, setUploadedAudioPath] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (source?.kind !== "uploaded" || !source?.file) {
      if (uploadedFileUrlRef.current) {
        URL.revokeObjectURL(uploadedFileUrlRef.current);
      }
      uploadedFileRef.current = null;
      uploadedFileUrlRef.current = null;
      setUploadedFileAudioUrl("");
      setUploadedAudioPath(null);
      return;
    }

    if (uploadedFileRef.current === source.file && uploadedFileUrlRef.current) {
      return;
    }

    if (uploadedFileUrlRef.current) {
      URL.revokeObjectURL(uploadedFileUrlRef.current);
    }

    const url = URL.createObjectURL(source.file);
    uploadedFileRef.current = source.file;
    uploadedFileUrlRef.current = url;
    setUploadedFileAudioUrl(url);

    setUploadedAudioPath(null);
  }, [source?.kind, source?.file]);

  useEffect(() => {
    return () => {
      if (uploadedFileUrlRef.current) {
        URL.revokeObjectURL(uploadedFileUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (source?.kind !== "uploaded") return;
    setUploadedAudioPath(null);
  }, [sentenceHash, source?.kind]);

  useEffect(() => {
    if (source?.kind !== "uploaded" || !sentenceHash || uploadedAudioPath)
      return;

    const applySavedPath = async (p: string) => {
      setUploadedAudioPath(p);
    };

    if (source.savedPath) {
      applySavedPath(source.savedPath);
      return;
    }

    const saveUploadedFile = async () => {
      try {
        if (!source.file) return;
        const arrayBuffer = await source.file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        const info = await invoke<UploadedAudioInfo>(
          "get_uploaded_audio_info",
          {
            sentenceHash: sentenceHash,
            originalFilename: source.file.name,
          }
        );

        if (info.exists) {
          const overwrite = await confirmOverwriteExisting();
          if (!overwrite) {
            await applySavedPath(info.path);
            message.info(t("screens.recorder.messages.useExistingSavedAudio"));
            return;
          }
        }

        const savedPath = await invoke<string>("save_uploaded_audio", {
          fileData: Array.from(uint8Array),
          sentenceHash: sentenceHash,
          originalFilename: source.file.name,
          overwrite: true,
        });

        try {
          sessionStorage.setItem("falkoe.uploadedSavedPath", savedPath);
          sessionStorage.setItem(
            "falkoe.uploadedFilename",
            source.file?.name ?? "uploaded"
          );
          sessionStorage.setItem("falkoe.useSpeech", "true");
          sessionStorage.setItem(
            "falkoe.useRecognition",
            String(!sentenceText || sentenceText.trim() === "")
          );
          sessionStorage.setItem("falkoe.manualText", sentenceText ?? "");
          sessionStorage.setItem("falkoe.lang", lang);
        } catch {}

        await applySavedPath(savedPath);
        message.success(t("screens.recorder.messages.savedAudioFile"));
      } catch (e) {
        message.error(
          `${t("screens.recorder.messages.saveAudioFailed")}${String(e)}`
        );
      }
    };

    void saveUploadedFile();
  }, [source, sentenceHash, uploadedAudioPath, sentenceText, lang, t]);

  return { uploadedFileAudioUrl, uploadedAudioPath, setUploadedAudioPath };
}
