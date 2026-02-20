import { useCallback } from "react";
import { message } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import type { Recording } from "../../types/recording";
import { ankiRequest } from "./ankiConnect";
import {
  blobToBase64,
  guessAudioMimeFromPath,
  guessExtFromPath,
  isHttpUrl,
} from "./audioUtils";
import { useTranslation } from "react-i18next";
import { guardAndroidIpcFileSize } from "../../utils/androidFileSizeGuard";
import { isAndroidRuntime } from "../../utils/runtimePlatform";
import {
  ankidroidAddNote,
  ankidroidRequestPermission,
  ankidroidStatus,
} from "../../utils/ankiDroidInvoke";

type SentenceLike = {
  text: string;
  audioUrl: string;
  lang: string;
};

type Params = {
  sourceKind: string;
  sentence: SentenceLike;
  sentenceHash: string;
  uploadedAudioPath: string | null;
  displayText: string;
};

export function useAddToAnki({
  sourceKind,
  sentence,
  sentenceHash,
  uploadedAudioPath,
  displayText,
}: Params) {
  const { t } = useTranslation();
  const addToAnki = useCallback(
    async (rec: Recording) => {
      try {
        console.log("[RecorderScreen] addToAnki start", {
          rec,
          sentence,
          sentenceHash,
        });

        const langToDeckSegment: Record<string, string> = {
          eng: "English",
          jpn: "Japanese",
        };

        const getDeckName = (lang: string) => {
          const langName = langToDeckSegment[lang] ?? lang;
          return `Falkoe::${langName}::Pronunciation`;
        };

        const deckName = getDeckName(sentence.lang);
        const cardText = (displayText || sentence.text || "").trim();

        // -- Prepare model audio ---------------------------------------------
        let modelAudioBase64: string;
        let modelAudioFilename: string;

        if (sourceKind === "uploaded") {
          if (!uploadedAudioPath) {
            throw new Error("uploaded audio path is not ready");
          }
          await guardAndroidIpcFileSize(uploadedAudioPath, {
            label: "uploaded audio",
          });
          const bytes = await readFile(uploadedAudioPath);
          const blob = new Blob([bytes], {
            type: guessAudioMimeFromPath(uploadedAudioPath),
          });
          modelAudioBase64 = await blobToBase64(blob);
          const ext = guessExtFromPath(uploadedAudioPath);
          modelAudioFilename = `model_${sentenceHash}.${ext}`;
        } else if (isHttpUrl(sentence.audioUrl)) {
          modelAudioBase64 = await invoke<string>("fetch_audio_base64", {
            url: sentence.audioUrl,
          });
          modelAudioFilename = `model_${sentenceHash}.mp3`;
        } else {
          await guardAndroidIpcFileSize(sentence.audioUrl, {
            label: "model audio",
          });
          const bytes = await readFile(sentence.audioUrl);
          const blob = new Blob([bytes], {
            type: guessAudioMimeFromPath(sentence.audioUrl),
          });
          modelAudioBase64 = await blobToBase64(blob);
          const ext = guessExtFromPath(sentence.audioUrl);
          modelAudioFilename = `model_${sentenceHash}.${ext}`;
        }

        // -- Prepare recording audio -----------------------------------------
        await guardAndroidIpcFileSize(rec.path, { label: "recording audio" });
        const recBytes = await readFile(rec.path);
        const recBlob = new Blob([recBytes], {
          type: guessAudioMimeFromPath(rec.path),
        });
        const recAudioBase64 = await blobToBase64(recBlob);
        const recFilename = `sentence_${sentenceHash}_${rec.timestamp}.wav`;

        const frontHtml = `Model pronunciation<br>[sound:${modelAudioFilename}]<br><br>${cardText}`;
        const backHtml = `Your pronunciation<br>[sound:${recFilename}]`;
        const tags = ["falkoe", "pronunciation", sentence.lang];

        // -- Send to AnkiDroid (Android) or AnkiConnect (desktop) ------------
        if (isAndroidRuntime()) {
          // Check AnkiDroid availability and permissions
          const status = await ankidroidStatus();
          if (!status.installed) {
            throw new Error(
              "AnkiDroidがインストールされていません。Google PlayストアからAnkiDroidをインストールしてください。",
            );
          }
          if (!status.permissionGranted) {
            const alreadyGranted = await ankidroidRequestPermission();
            if (!alreadyGranted) {
              throw new Error(
                "AnkiDroidのデータベース権限が必要です。表示されたダイアログで許可してから、もう一度お試しください。",
              );
            }
          }

          const res = await ankidroidAddNote({
            deckName,
            modelName: "Basic",
            fields: [frontHtml, backHtml],
            tags: tags.join(" "),
            mediaNames: [modelAudioFilename, recFilename],
            mediaDatasBase64: [modelAudioBase64, recAudioBase64],
          });
          console.log("AnkiDroid note id:", res.noteId);
        } else {
          await ankiRequest({
            action: "createDeck",
            version: 6,
            params: { deck: deckName },
          });

          await ankiRequest({
            action: "storeMediaFile",
            version: 6,
            params: {
              filename: modelAudioFilename,
              data: modelAudioBase64,
            },
          });

          await ankiRequest({
            action: "storeMediaFile",
            version: 6,
            params: { filename: recFilename, data: recAudioBase64 },
          });

          const res = await ankiRequest({
            action: "addNote",
            version: 6,
            params: {
              note: {
                deckName,
                modelName: "Basic",
                fields: {
                  Front: frontHtml,
                  Back: backHtml,
                },
                tags,
              },
            },
          });
          console.log("AnkiConnect note id:", res);
        }

        message.success(t("screens.recorder.messages.ankiAdded"));
      } catch (e) {
        console.error("[RecorderScreen] addToAnki failed" + e, e);
        const details = e instanceof Error ? e.message : String(e);
        message.error({
          content: (
            <span style={{ whiteSpace: "pre-line" }}>
              {t("screens.recorder.messages.ankiAddFailed")}
              {details}
            </span>
          ),
        });
      }
    },
    [displayText, sentence, sentenceHash, sourceKind, uploadedAudioPath, t],
  );

  return { addToAnki };
}
