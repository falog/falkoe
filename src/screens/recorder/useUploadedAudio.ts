import { useEffect, useRef, useState } from "react";
import { message } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { confirmOverwriteExisting } from "./uiUtils";

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
            message.info("既存の保存済み音声を使用します");
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
        message.success("音声ファイルを保存しました");
      } catch (e) {
        message.error("音声ファイルの保存に失敗しました: " + String(e));
      }
    };

    void saveUploadedFile();
  }, [source, sentenceHash, uploadedAudioPath, sentenceText, lang]);

  return { uploadedFileAudioUrl, uploadedAudioPath, setUploadedAudioPath };
}
