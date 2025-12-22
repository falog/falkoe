import { Button, message, Space, Typography } from "antd";
import { useEffect, useState, useRef } from "react";
import { startRecording, stopRecording } from "tauri-plugin-mic-recorder-api";
import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PlayCircleOutlined } from "@ant-design/icons";
import type { Sentence } from "../components/ExampleList";
import RecordingItem from "../components/RecordingItem";

type RecorderScreenProps = {
  sentence: Sentence;
  onBack: () => void;
};

type Recording = {
  path: string; // フルパス（唯一のキー）
  fileName: string;
  timestamp: string;
  dateLabel: string;
};

type Segment = {
  start: number;
  end: number;
  text: string;
};

type Transcript = {
  segments: Segment[];
};

type FinalResultPayload = {
  status: "final";
  wav_path: string;
  segments: Segment[];
  score: number;
};

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result === "string") {
        // data:audio/wav;base64,XXXX を除去
        resolve(result.split(",")[1]);
      } else {
        reject(new Error("Failed to convert blob to base64"));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

const parseRecording = (path: string): Recording => {
  const name = path.split(/[/\\]/).pop() ?? "";

  const m = name.match(/^(\d{8})_(\d{1,6})/);

  let dateLabel = "";
  let timestamp = "";

  if (m) {
    const y = m[1].slice(0, 4);
    const mo = m[1].slice(4, 6);
    const d = m[1].slice(6, 8);

    const t = m[2].padStart(6, "0");
    const hh = t.slice(0, 2);
    const mm = t.slice(2, 4);
    const ss = t.slice(4, 6);

    dateLabel = `${y}/${mo}/${d} ${hh}:${mm}:${ss}`;
    timestamp = `${m[1]}_${t}`;
  }

  return {
    path,
    fileName: name,
    timestamp,
    dateLabel,
  };
};

async function loadTranscript(wavPath: string): Promise<Transcript | null> {
  try {
    const jsonPath = wavPath.replace(/\.wav$/i, ".json");
    const text = await readTextFile(jsonPath);
    return JSON.parse(text) as Transcript;
  } catch {
    return null;
  }
}

async function ankiRequest(payload: any) {
  const res = await fetch("http://127.0.0.1:8765", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

const RecorderScreen = ({ sentence, onBack }: RecorderScreenProps) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [transcripts, setTranscripts] = useState<
    Record<string, Transcript | null>
  >({});
  const [status, setStatus] = useState<string>("idle");
  const modelMissingShown = useRef(false);
  const [progress, setProgress] = useState<number | null>(null);

  /** sentence 切り替え時にリセット */
  useEffect(() => {
    setRecordings([]);
    setAudioUrls({});
    setTranscripts({});
    refreshFiles();
  }, [sentence.id]);

  /** model status (pull once + push) */
  useEffect(() => {
    // 起動時に pull
    invoke<string>("get_model_status")
      .then(setStatus)
      .catch(() => setStatus("idle"));

    // 以降は push
    const unlistenPromise = listen<string>("model-status", (e) => {
      setStatus(e.payload);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
  /** model download progress */
  useEffect(() => {
    const unlistenPromise = listen<number>("model-progress", (e) => {
      setProgress(e.payload);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
  /** downloading に入った瞬間に理由を表示 */
  useEffect(() => {
    if (status === "downloading" && !modelMissingShown.current) {
      modelMissingShown.current = true;
      message.info("音声認識モデルがありません。ダウンロードを開始します。");
    }
  }, [status]);

  const refreshFiles = async () => {
    const list = await invoke<string[]>("list_recordings", {
      sentenceId: sentence.id,
    });

    const parsed = list.map(parseRecording).sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return b.timestamp.localeCompare(a.timestamp);
    });

    setRecordings(parsed);
  };

  const langToDeckSegment: Record<string, string> = {
    eng: "English",
    jpn: "Japanese",
  };

  function getDeckName(lang: string) {
    const langName = langToDeckSegment[lang] ?? lang;
    return `Falkoe::${langName}::Pronunciation`;
  }

  const addToAnki = async (rec: Recording) => {
    try {
      const deckName = getDeckName(sentence.lang);

      // デッキを保証
      await ankiRequest({
        action: "createDeck",
        version: 6,
        params: { deck: deckName },
      });

      const modelAudioFilename = `model_${sentence.id}.wav`;

      const modelAudioBase64 = await invoke<string>("fetch_audio_base64", {
        url: sentence.audioUrl,
      });

      await ankiRequest({
        action: "storeMediaFile",
        version: 6,
        params: {
          filename: modelAudioFilename,
          data: modelAudioBase64,
        },
      });

      const bytes = await readFile(rec.path);
      const blob = new Blob([bytes], { type: "audio/wav" });
      const audioBase64 = await blobToBase64(blob);
      const filename = `sentence_${sentence.id}_${rec.timestamp}.wav`;

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
              Front: `Model pronunciation<br>[sound:${modelAudioFilename}]<br><br>${sentence.text}`,
              Back: `Your pronunciation<br>[sound:${filename}]`,
            },
            tags: ["falkoe", "pronunciation", sentence.lang],
          },
        },
      });

      console.log("added note id:", res);
      message.success("Ankiに追加しました");
    } catch (e) {
      message.error("Ankiへの追加に失敗しました");
    }
  };

  const loadAudio = async (path: string) => {
    if (audioUrls[path]) return;

    try {
      const bytes = await readFile(path);
      const blob = new Blob([bytes], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);

      setAudioUrls((prev) => ({
        ...prev,
        [path]: url,
      }));
    } catch (e) {
      message.error(String(e));
    }
  };

  /** transcript started */
  useEffect(() => {
    const unlisten = listen<string>("transcript-started", (e) => {
      const wavPath = e.payload;
      setTranscripts((prev) => ({
        ...prev,
        [wavPath]: null,
      }));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  /** transcript ready */
  useEffect(() => {
    const unlisten = listen<string>("transcript-ready", async (e) => {
      const wavPath = e.payload;
      if (!wavPath.includes(`/tatoeba/${sentence.id}/`)) return;

      const transcript = await loadTranscript(wavPath);
      setTranscripts((prev) => ({
        ...prev,
        [wavPath]: transcript,
      }));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [sentence.id]);

  useEffect(() => {
    const unlistenPromise = listen<FinalResultPayload>(
      "transcript-final",
      (e) => {
        const result = e.payload;

        setTranscripts((prev) => ({
          ...prev,
          [result.wav_path]: { segments: result.segments },
        }));
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  /** recordings が変わったら audio / transcript をロード */
  useEffect(() => {
    const run = async () => {
      for (const rec of recordings) {
        // await loadAudio(rec.path);

        if (transcripts[rec.path] === undefined) {
          const transcript = await loadTranscript(rec.path);
          setTranscripts((prev) => ({
            ...prev,
            [rec.path]: transcript,
          }));
        }
      }
    };
    run();
  }, [recordings]);

  useEffect(() => {
    return () => {
      Object.values(audioUrls).forEach(URL.revokeObjectURL);
    };
  }, []);

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Button onClick={onBack}>← 戻る</Button>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Button
          type="text"
          icon={<PlayCircleOutlined />}
          onClick={() => new Audio(sentence.audioUrl).play()}
          style={{ opacity: 0.7 }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
        />
        <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>
          {sentence.text}
        </Typography.Title>
      </div>
      <Typography.Text type="secondary">Model status: {status}</Typography.Text>

      {status === "downloading" && (
        <Typography.Text type="secondary">
          Downloading model… {progress ?? 0}%
        </Typography.Text>
      )}
      <Space>
        <Button
          type="primary"
          disabled={isRecording || status !== "ready"}
          onClick={async () => {
            try {
              await startRecording();
              setIsRecording(true);
            } catch (e) {
              message.error(String(e));
            }
          }}
        >
          Start Recording
        </Button>

        <Button
          danger
          disabled={!isRecording}
          onClick={async () => {
            setIsRecording(false);
            let movedPath: string;

            try {
              const recordedPath = await stopRecording();
              movedPath = await invoke<string>("move_recorded_audio", {
                srcPath: recordedPath,
                sentenceId: sentence.id,
              });
            } catch (e) {
              message.error("録音の保存に失敗しました");
              await refreshFiles();
              return;
            }

            try {
              await invoke("run_whisper", {
                path: movedPath,
                sentenceId: sentence.id,
                lang: sentence.lang,
              });
            } catch {
              message.info(
                "録音は保存されました（文字起こしは後で実行できます）"
              );
            }

            await refreshFiles();
          }}
        >
          Stop Recording
        </Button>
      </Space>

      {isRecording && <Typography.Text>Recording...</Typography.Text>}

      <Typography.Title level={5}>Recordings</Typography.Title>

      <Space orientation="vertical" style={{ width: "100%" }}>
        {recordings.length === 0 && (
          <Typography.Text type="secondary">No recordings yet</Typography.Text>
        )}

        {recordings.map((rec, i) => (
          <RecordingItem
            key={rec.path}
            rec={rec}
            index={i}
            total={recordings.length}
            transcript={transcripts[rec.path]}
            audioUrl={audioUrls[rec.path]}
            loadAudio={loadAudio}
            addToAnki={addToAnki}
          />
        ))}
      </Space>
    </Space>
  );
};

export default RecorderScreen;
