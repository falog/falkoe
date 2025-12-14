import { Button, message, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import { startRecording, stopRecording } from "tauri-plugin-mic-recorder-api";
import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Segment = {
  start: number;
  end: number;
  text: string;
};

type Transcript = {
  segments: Segment[];
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

const App = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [transcripts, setTranscripts] = useState<
    Record<string, Transcript | null>
  >({});
  const [status, setStatus] = useState<string>("idle");

  useEffect(() => {
    const unlisten = listen<string>("model-status", (e) => {
      setStatus(e.payload);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    invoke<string>("get_model_status")
      .then((s) => setStatus(s))
      .catch(() => setStatus("idle"));
  }, []);

  const refreshFiles = async () => {
    try {
      const list = await invoke<string[]>("list_recordings");

      const sorted = [...list].sort((a, b) => {
        const fa = a.split("/").pop()!;
        const fb = b.split("/").pop()!;
        return fb.localeCompare(fa);
      });

      setFiles(sorted);
    } catch (e) {
      message.error(String(e));
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

  useEffect(() => {
    refreshFiles();
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("model-status", (e) => {
      setStatus(e.payload);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("transcript-started", (e) => {
      const path = e.payload;

      setTranscripts((prev) => ({
        ...prev,
        [path]: null,
      }));
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("transcript-ready", async (e) => {
      const path = e.payload;

      const transcript = await loadTranscript(path);
      setTranscripts((prev) => ({
        ...prev,
        [path]: transcript,
      }));
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    files.forEach(async (path) => {
      await loadAudio(path);

      if (transcripts[path] !== undefined) return;

      const transcript = await loadTranscript(path);
      setTranscripts((prev) => ({
        ...prev,
        [path]: transcript,
      }));
    });
  }, [files]);

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Typography.Title level={4}>Audio Recorder</Typography.Title>

      <Typography.Text type="secondary">Model status: {status}</Typography.Text>

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

            let movedPath: string | null = null;

            try {
              const recordedPath = await stopRecording();

              movedPath = await invoke<string>("move_recorded_audio", {
                srcPath: recordedPath,
              });
            } catch (e) {
              message.error("録音の保存に失敗しました");
              console.error(e);
              await refreshFiles();
              return;
            }

            try {
              await invoke("run_whisper", {
                path: movedPath,
              });
            } catch (e) {
              console.warn("whisper failed:", e);
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
        {files.length === 0 && (
          <Typography.Text type="secondary">No recordings yet</Typography.Text>
        )}

        {files.map((path) => {
          const fileName = path.split("/").pop();
          const transcript = transcripts[path];

          return (
            <div key={path} style={{ marginBottom: 12 }}>
              <div>{fileName}</div>

              <audio controls src={audioUrls[path]} style={{ width: "100%" }} />

              {transcript && transcript.segments.length > 0 && (
                <div style={{ fontSize: 14, marginTop: 4 }}>
                  {transcript.segments.map((s, i) => (
                    <div key={i}>{s.text.trim()}</div>
                  ))}
                </div>
              )}

              {transcript && transcript.segments.length === 0 && (
                <div style={{ fontSize: 12, color: "#888" }}>
                  （音声が検出されませんでした）
                </div>
              )}

              {transcript === null && (
                <div style={{ fontSize: 12, color: "#888" }}>
                  （文字起こし中…）
                </div>
              )}
            </div>
          );
        })}
      </Space>
    </Space>
  );
};

export default App;
