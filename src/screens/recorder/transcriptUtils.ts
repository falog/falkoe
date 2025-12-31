import { BaseDirectory, readTextFile } from "@tauri-apps/plugin-fs";
import type { Recording, Transcript } from "../../types/recording";

export function parseRecording(str: string): Recording {
  const [path, fileName, timestamp, dateLabel] = str.split("|");
  return { path, fileName, timestamp, dateLabel } as Recording;
}

export async function loadTranscript(
  wavPath: string
): Promise<Transcript | null> {
  try {
    const jsonPath = wavPath.replace(/\.wav$/i, ".json");
    const text = await readTextFile(jsonPath);
    return JSON.parse(text) as Transcript;
  } catch {
    return null;
  }
}

export async function loadModelTranscript(
  sentenceHash: string
): Promise<Transcript | null> {
  try {
    const basePath = `falkoe/sentences/${sentenceHash}/model`;

    const candidates = [
      `${basePath}/model.json`,
      `${basePath}/transcript.json`,
    ];
    for (const path of candidates) {
      try {
        const text = await readTextFile(path, {
          baseDir: BaseDirectory.Document,
        });
        return JSON.parse(text) as Transcript;
      } catch {}
    }

    return null;
  } catch {
    return null;
  }
}

export async function loadUploadedTranscript(
  uploadedPath: string
): Promise<Transcript | null> {
  try {
    const dir = uploadedPath.replace(/[/\\][^/\\]+$/, "");
    const text = await readTextFile(`${dir}/uploaded.json`);
    return JSON.parse(text) as Transcript;
  } catch {
    return null;
  }
}
