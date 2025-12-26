import { Button, message, Modal, Space, Spin, Typography } from "antd";
import { useEffect, useState, useRef } from "react";
import { startRecording, stopRecording } from "tauri-plugin-mic-recorder-api";
import { readFile, readTextFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PlayCircleOutlined } from "@ant-design/icons";
import type { Sentence } from "../components/ExampleList";
import RecordingItem from "../components/RecordingItem";
import type { SpeechSource } from "../types/speech";
import { sha256 } from "../utils/hash";

type RecorderScreenProps = {
  source: SpeechSource;
  onBack: () => void;
};

type Recording = {
  path: string;
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

type UploadedAudioInfo = {
  exists: boolean;
  path: string;
};

function confirmOverwriteExisting(): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: "既に保存済みの音声があります",
      content: "同じIDのアップロード音声が既に存在します。上書きしますか？",
      okText: "上書きする",
      cancelText: "上書きしない",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function confirmOverwriteTranscript(): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: "既に文字起こし結果があります",
      content:
        "保存済みのテキスト(JSON)を上書きするために、もう一度音声認識しますか？",
      okText: "上書きする",
      cancelText: "上書きしない",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function hashText(text: string) {
  return Math.abs(
    Array.from(text).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result === "string") {
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
    // jsonPath は絶対パスなので baseDir は指定しない
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

const RecorderScreen = ({ source, onBack }: RecorderScreenProps) => {
  const sentence: Sentence = (() => {
    switch (source.kind) {
      case "tatoeba":
        return source.sentence;

      case "uploaded":
        return {
          id: hashText(source.text ?? "uploaded"),
          text: source.text ?? "",
          audioUrl: source.file ? URL.createObjectURL(source.file) : "",
          lang: source.lang,
        };

      case "recorded":
        return {
          id: hashText(source.text ?? "recorded"),
          text: source.text ?? "",
          audioUrl: source.filePath,
          lang: source.lang,
        };
    }
  })();

  // sentenceの text + lang からハッシュを生成
  const [sentenceHash, setSentenceHash] = useState<string>("");

  useEffect(() => {
    if (source.kind === "uploaded" && source.sentenceHash) {
      setSentenceHash(source.sentenceHash);
      return;
    }
    sha256(sentence.text, sentence.lang).then(setSentenceHash);
  }, [source, sentence.text, sentence.lang]);

  const [isRecording, setIsRecording] = useState(false);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [transcripts, setTranscripts] = useState<
    Record<string, Transcript | null>
  >({});
  const [status, setStatus] = useState<string>("idle");
  const modelMissingShown = useRef(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [modelText, setModelText] = useState<string | null>(null);
  const [waitingModel, setWaitingModel] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [uploadedAudioPath, setUploadedAudioPath] = useState<string | null>(
    null
  );
  const [displayText, setDisplayText] = useState<string>(sentence.text);
  const autoStartedRef = useRef(false);
  const [headerAudioUrl, setHeaderAudioUrl] = useState<string | null>(
    source.kind === "uploaded" && source.file
      ? sentence.audioUrl
      : source.kind === "recorded"
        ? sentence.audioUrl
        : null
  );

  // sentence.text が変わったらタイトル用テキストも更新（手動入力の反映）
  useEffect(() => {
    setDisplayText(sentence.text);
  }, [sentence.text]);

  /** アップロード音声を保存 or 既存保存パスの適用 */
  useEffect(() => {
    if (source.kind !== "uploaded" || !sentenceHash || uploadedAudioPath)
      return;

    const applySavedPath = async (p: string) => {
      setUploadedAudioPath(p);
      // 再生用URLを作成
      try {
        const bytes = await readFile(p);
        const blob = new Blob([bytes]);
        const url = URL.createObjectURL(blob);
        setHeaderAudioUrl(url);
      } catch {
        // ignore
      }
    };

    // 既に savedPath が渡っている場合は保存をスキップ
    if (source.savedPath) {
      applySavedPath(source.savedPath);
      return;
    }

    // File から保存
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

        // 永続化（戻った際の復元用）
        try {
          sessionStorage.setItem("falkoe.uploadedSavedPath", savedPath);
          sessionStorage.setItem(
            "falkoe.uploadedFilename",
            source.file?.name ?? "uploaded"
          );
          sessionStorage.setItem("falkoe.useSpeech", "true");
          sessionStorage.setItem(
            "falkoe.useRecognition",
            String(!sentence.text || sentence.text.trim() === "")
          );
          sessionStorage.setItem("falkoe.manualText", sentence.text ?? "");
          sessionStorage.setItem("falkoe.lang", sentence.lang);
        } catch {}

        await applySavedPath(savedPath);
        message.success("音声ファイルを保存しました");
      } catch (e) {
        message.error("音声ファイルの保存に失敗しました: " + String(e));
      }
    };

    saveUploadedFile();
  }, [source, sentenceHash, uploadedAudioPath]);

  useEffect(() => {
    return () => {
      if (source.kind === "uploaded" && source.file && sentence.audioUrl) {
        URL.revokeObjectURL(sentence.audioUrl);
      }
    };
  }, []);

  /** sentence 切り替え時にリセット */
  useEffect(() => {
    setRecordings([]);
    setAudioUrls({});
    setTranscripts({});
    autoStartedRef.current = false;
    refreshFiles();
  }, [sentenceHash]);

  // cleanup header audio url when changed/unmounted
  useEffect(() => {
    return () => {
      if (headerAudioUrl) URL.revokeObjectURL(headerAudioUrl);
    };
  }, [headerAudioUrl]);

  // アップロード音声で text が空（= 自動認識モード）の場合、初回に自動で音声認識を実行
  useEffect(() => {
    if (
      source.kind !== "uploaded" ||
      !(!sentence.text || sentence.text.trim() === "") ||
      !uploadedAudioPath ||
      status !== "ready" ||
      autoStartedRef.current
    ) {
      return;
    }

    autoStartedRef.current = true;

    let cancelled = false;

    const run = async () => {
      // 既に transcript があれば再認識しない
      const cached = await loadUploadedTranscript(uploadedAudioPath);
      if (cancelled) return;
      if (cached) {
        const joined = cached.segments
          .map((s) => s.text)
          .join(" ")
          .trim();
        setDisplayText((prev) => prev || joined);
        return;
      }

      invoke("run_whisper_uploaded", {
        uploadedPath: uploadedAudioPath,
        sentenceHash: sentenceHash,
        lang: sentence.lang,
      });

      setIsTranscribing(true);
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [
    source,
    sentence.text,
    uploadedAudioPath,
    status,
    sentenceHash,
    sentence.lang,
  ]);

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
      sentenceHash,
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
      if (!wavPath.endsWith(".wav")) return;

      const transcript = await loadTranscript(wavPath);
      setWaitingModel(false);
      setIsTranscribing(false);
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
        setIsTranscribing(false);
        const result = e.payload;

        if (waitingModel) {
          setModelText(result.segments.map((s) => s.text).join(" "));
          setWaitingModel(false);
          return;
        }

        // アップロード音声の自動認識結果はタイトルにも表示（初回のみ）
        const joined = result.segments
          .map((s) => s.text)
          .join(" ")
          .trim();
        if (
          source.kind === "uploaded" &&
          (!sentence.text || sentence.text.trim() === "")
        ) {
          setDisplayText((prev) => prev || joined);
          try {
            sessionStorage.setItem("falkoe.recognizedText", joined);
          } catch {}
        }

        setTranscripts((prev) => ({
          ...prev,
          [result.wav_path]: { segments: result.segments },
        }));
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [waitingModel]);

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

  async function loadModelTranscript(
    sentenceHash: string
  ): Promise<Transcript | null> {
    try {
      const basePath = `falkoe/sentences/${sentenceHash}/model`;

      // 新しいフォルダ構造では model フォルダ内に transcript.json がある
      const text = await readTextFile(`${basePath}/transcript.json`, {
        baseDir: BaseDirectory.Document,
      });
      return JSON.parse(text) as Transcript;
    } catch {
      return null;
    }
  }

  async function loadUploadedTranscript(
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

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Button onClick={onBack}>← 戻る</Button>

      {isTranscribing && (
        <Space>
          <Spin size="small" />
          <Typography.Text type="secondary">文字起こし中…</Typography.Text>
        </Space>
      )}

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
          onClick={() => new Audio(headerAudioUrl ?? sentence.audioUrl).play()}
          style={{ opacity: 0.7 }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
        />
        <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>
          {displayText || sentence.text}
        </Typography.Title>
        <Button
          onClick={async () => {
            console.log("model recognize clicked");

            if (source.kind === "uploaded") {
              if (!uploadedAudioPath) return;
              const cached = await loadUploadedTranscript(uploadedAudioPath);
              if (cached) {
                const overwrite = await confirmOverwriteTranscript();
                if (!overwrite) {
                  setModelText(cached.segments.map((s) => s.text).join(" "));
                  return;
                }
              }
            } else {
              const cached = await loadModelTranscript(sentenceHash);
              if (cached) {
                const overwrite = await confirmOverwriteTranscript();
                if (!overwrite) {
                  setModelText(cached.segments.map((s) => s.text).join(" "));
                  return;
                }
              }
            }

            setWaitingModel(true);
            setIsTranscribing(true);

            if (source.kind === "uploaded" && uploadedAudioPath) {
              // アップロード音声の場合は保存済みパスを使用
              invoke("run_whisper_uploaded", {
                uploadedPath: uploadedAudioPath,
                sentenceHash: sentenceHash,
                lang: sentence.lang,
              });
            } else {
              // Tatoeba等のURL音声の場合
              invoke("run_whisper_model", {
                url: sentence.audioUrl,
                sentenceHash: sentenceHash,
                lang: sentence.lang,
              });
            }
          }}
          disabled={source.kind === "uploaded" && !uploadedAudioPath}
        >
          {source.kind === "uploaded"
            ? "アップロード音声を音声認識する"
            : "模範音声を音声認識する"}
        </Button>
      </div>
      {modelText && (
        <Typography.Paragraph>
          <strong>Model transcript:</strong>
          <br />
          {modelText}
        </Typography.Paragraph>
      )}
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
                sentenceHash: sentenceHash,
              });
            } catch (e) {
              message.error("録音の保存に失敗しました");
              await refreshFiles();
              return;
            }

            try {
              await invoke("run_whisper", {
                path: movedPath,
                sentenceHash: sentenceHash,
                lang: sentence.lang,
              });

              setIsTranscribing(true);
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
