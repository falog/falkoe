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

        await ankiRequest({
          action: "createDeck",
          version: 6,
          params: { deck: deckName },
        });

        const cardText = (displayText || sentence.text || "").trim();

        let modelAudioBase64: string;
        let modelAudioFilename: string;

        if (sourceKind === "uploaded") {
          if (!uploadedAudioPath) {
            throw new Error("uploaded audio path is not ready");
          }
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
          const bytes = await readFile(sentence.audioUrl);
          const blob = new Blob([bytes], {
            type: guessAudioMimeFromPath(sentence.audioUrl),
          });
          modelAudioBase64 = await blobToBase64(blob);
          const ext = guessExtFromPath(sentence.audioUrl);
          modelAudioFilename = `model_${sentenceHash}.${ext}`;
        }

        await ankiRequest({
          action: "storeMediaFile",
          version: 6,
          params: {
            filename: modelAudioFilename,
            data: modelAudioBase64,
          },
        });

        const bytes = await readFile(rec.path);
        const blob = new Blob([bytes], {
          type: guessAudioMimeFromPath(rec.path),
        });
        const audioBase64 = await blobToBase64(blob);
        const filename = `sentence_${sentenceHash}_${rec.timestamp}.wav`;

        await ankiRequest({
          action: "storeMediaFile",
          version: 6,
          params: { filename, data: audioBase64 },
        });

        const res = await ankiRequest({
          action: "addNote",
          version: 6,
          params: {
            note: {
              deckName,
              modelName: "Basic",
              fields: {
                Front: `Model pronunciation<br>[sound:${modelAudioFilename}]<br><br>${cardText}`,
                Back: `Your pronunciation<br>[sound:${filename}]`,
              },
              tags: ["falkoe", "pronunciation", sentence.lang],
            },
          },
        });

        console.log("added note id:", res);
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
    [displayText, sentence, sentenceHash, sourceKind, uploadedAudioPath, t]
  );

  return { addToAnki };
}
