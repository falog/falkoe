import { BaseDirectory, readTextFile } from "@tauri-apps/plugin-fs";
import type { Recording, Transcript } from "../../types/recording";

export function parseRecording(str: string): Recording {
  // Backward-compatible: older builds returned "path|fileName|timestamp|dateLabel".
  // Current build returns just the wav path.
  if (str.includes("|")) {
    const [path, fileName, timestamp, dateLabel] = str.split("|");
    return {
      path: path ?? "",
      fileName: fileName ?? "",
      timestamp: timestamp ?? "",
      dateLabel: dateLabel ?? "",
    };
  }

  const path = str;
  const fileName =
    path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";

  const base = fileName.replace(/\.[^.]+$/, "");
  const tsMatch = base.match(/^(\d{8})_(\d{6})$/);
  const timestamp = tsMatch ? `${tsMatch[1]}_${tsMatch[2]}` : base;

  const dateLabel = (() => {
    if (!tsMatch) return "";
    const d = tsMatch[1];
    const t = tsMatch[2];
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
  })();

  return { path, fileName, timestamp, dateLabel };
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
