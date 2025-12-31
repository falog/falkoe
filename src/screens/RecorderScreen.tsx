import { useEffect, useState, useRef } from "react";
function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
import { Button, message, Space, Spin, Typography, theme } from "antd";
import { startRecording, stopRecording } from "tauri-plugin-mic-recorder-api";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type { Sentence } from "../components/ExampleList";
import { sha256 } from "../utils/hash";
import {
  blobToBase64,
  guessAudioMimeFromPath,
  guessExtFromPath,
  isHttpUrl,
} from "./recorder/audioUtils";
import { useAudioUrlCache } from "./recorder/useAudioUrlCache";
import { useHeaderAudioUrl } from "./recorder/useHeaderAudioUrl";
import { useModelStatus } from "./recorder/useModelStatus";
import {
  loadModelTranscript,
  loadTranscript,
  loadUploadedTranscript,
  parseRecording,
} from "./recorder/transcriptUtils";
import { ankiRequest } from "./recorder/ankiConnect";
import { confirmOverwriteExisting } from "./recorder/uiUtils";
import HeaderAudioPlayButton from "./recorder/HeaderAudioPlayButton";
import { renderLinkingRust } from "../utils/linkingInvoke";
import type { RenderLinkingResult, DisplayMode } from "../types/linking";
import { loadIpaIndex, type IpaIndex } from "../utils/ipaResources";
import { unlockAudioFromUserGesture } from "../utils/ipaPlayer";
import TopNav from "../components/TopNav";
import RecordingsList from "../components/RecordingsList";
import type { Recording, Transcript } from "../types/recording";
import LinkingStressArea from "./recorder/LinkingStressArea";
import { useWhisperEvents } from "./recorder/useWhisperEvents";

type RecorderScreenProps = {
  source: any;
  onBack: () => void;
  onOpenIpaList: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

type UploadedAudioInfo = {
  exists: boolean;
  path: string;
};

const RecorderScreen = ({
  source,
  onBack,
  onOpenIpaList,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: RecorderScreenProps) => {
  theme.useToken();
  const isLinux = (() => {
    const ua =
      typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : "";
    const plat =
      typeof navigator !== "undefined"
        ? ((navigator as any).platform ?? "")
        : "";
    return /Linux/i.test(ua) || /Linux/i.test(String(plat));
  })();
  const preferAssetProtocol = !isLinux;

  const uploadedFileRef = useRef<File | null>(null);
  const uploadedFileUrlRef = useRef<string | null>(null);
  const [uploadedFileAudioUrl, setUploadedFileAudioUrl] = useState<string>("");

  useEffect(() => {
    if (source.kind !== "uploaded" || !source.file) {
      if (uploadedFileUrlRef.current) {
        URL.revokeObjectURL(uploadedFileUrlRef.current);
      }
      uploadedFileRef.current = null;
      uploadedFileUrlRef.current = null;
      setUploadedFileAudioUrl("");
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
  }, [source.kind, source.file]);

  useEffect(() => {
    return () => {
      if (uploadedFileUrlRef.current) {
        URL.revokeObjectURL(uploadedFileUrlRef.current);
      }
    };
  }, []);

  const sentence: Sentence = (() => {
    switch (source.kind) {
      case "tatoeba":
        return source.sentence;
      case "uploaded":
        return {
          id: hashText(source.text ?? "uploaded"),
          text: source.text ?? "",
          audioUrl: source.file ? uploadedFileAudioUrl : "",
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
  const [transcripts, setTranscripts] = useState<
    Record<string, Transcript | null>
  >({});
  const { status, progress } = useModelStatus();
  const [modelText, setModelText] = useState<string | null>(null);
  const [waitingModel, setWaitingModel] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recognizing, setRecognizing] = useState<Record<string, boolean>>({});
  const [uploadedAudioPath, setUploadedAudioPath] = useState<string | null>(
    null
  );
  const [displayText, setDisplayText] = useState<string>(sentence.text);
  const [linkingResult, setLinkingResult] =
    useState<RenderLinkingResult | null>(null);
  const [linkingDisplayMode, setLinkingDisplayMode] =
    useState<DisplayMode>("phoneme");
  const [ipaIndex, setIpaIndex] = useState<IpaIndex | null>(null);
  const audioUnlockTriedRef = useRef(false);

  useEffect(() => {
    loadIpaIndex()
      .then((idx) => {
        setIpaIndex(idx);
      })
      .catch((e) => {
        setIpaIndex(null);
        const msg = String((e as any)?.message ?? e);
        message.error(`IPA index 読み込み失敗: ${msg}`);
      });
  }, []);

  const autoStartedRef = useRef(false);
  const { audioUrls, ensureBlobAudioUrl, toAssetUrl, resetAudioUrls } =
    useAudioUrlCache();

  const { headerAudioUrl, isHeaderAudioLoading } = useHeaderAudioUrl({
    sourceKind: source.kind,
    sentenceAudioUrl: sentence.audioUrl,
    uploadedAudioPath,
    preferAssetProtocol,
    ensureBlobAudioUrl,
    toAssetUrl,
    hasUploadedFile: source.kind === "uploaded" && Boolean(source.file),
  });

  useEffect(() => {
    setDisplayText(sentence.text);
  }, [sentence.text]);

  useEffect(() => {
    const text = (displayText || sentence.text || "").trim();
    if (!text || sentence.lang !== "eng") {
      setLinkingResult(null);
      return;
    }

    let cancelled = false;

    renderLinkingRust(text, {
      linkingMode: true,
      displayMode: linkingDisplayMode,
      useDict: true,
    })
      .then((res) => {
        if (cancelled) return;
        setLinkingResult(res);
      })
      .catch((e) => {
        console.warn("render_linking failed", e);
        if (cancelled) return;
        setLinkingResult(null);
      });

    return () => {
      cancelled = true;
    };
  }, [displayText, sentence.text, sentence.lang, linkingDisplayMode]);

  useEffect(() => {
    if (source.kind !== "uploaded" || !sentenceHash || uploadedAudioPath)
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
    setRecordings([]);
    setTranscripts({});
    setModelText(null);
    setWaitingModel(false);
    resetAudioUrls();
    autoStartedRef.current = false;
    refreshFiles();
  }, [sentenceHash]);

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
      console.log("[RecorderScreen] addToAnki start", {
        rec,
        sentence,
        sentenceHash,
      });

      const deckName = getDeckName(sentence.lang);

      await ankiRequest({
        action: "createDeck",
        version: 6,
        params: { deck: deckName },
      });

      const cardText = (displayText || sentence.text || "").trim();

      let modelAudioBase64: string;
      let modelAudioFilename: string;

      if (source.kind === "uploaded") {
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
      message.success("Ankiに追加しました");
    } catch (e) {
      console.error("[RecorderScreen] addToAnki failed" + e, e);
      const details = e instanceof Error ? e.message : String(e);
      message.error({
        content: (
          <span style={{ whiteSpace: "pre-line" }}>
            {`Ankiへの追加に失敗しました：\n${details}`}
          </span>
        ),
      });
    }
  };

  useWhisperEvents({
    sentenceId: sentence.id,
    sourceKind: source.kind,
    sentenceText: sentence.text,
    waitingModel,
    loadTranscript,
    setWaitingModel,
    setIsTranscribing,
    setModelText,
    setDisplayText,
    setRecognizing,
    setTranscripts,
  });

  const recognizeRecording = async (rec: Recording) => {
    if (status !== "ready") return;
    if (recognizing[rec.path]) return;

    setRecognizing((prev) => ({ ...prev, [rec.path]: true }));
    setIsTranscribing(true);
    try {
      await invoke("run_whisper", {
        path: rec.path,
        sentenceHash: sentenceHash,
        lang: sentence.lang,
      });
    } catch (e) {
      setRecognizing((prev) => {
        const next = { ...prev };
        delete next[rec.path];
        return next;
      });
      setIsTranscribing(false);
      message.error("音声認識の開始に失敗しました: " + String(e));
    }
  };

  useEffect(() => {
    const run = async () => {
      for (const rec of recordings) {
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
    if (!sentenceHash) return;
    if (waitingModel) return;

    let cancelled = false;

    const run = async () => {
      try {
        const transcript =
          source.kind === "uploaded"
            ? uploadedAudioPath
              ? await loadUploadedTranscript(uploadedAudioPath)
              : null
            : await loadModelTranscript(sentenceHash);

        if (cancelled) return;

        if (transcript && transcript.segments.length > 0) {
          setModelText(transcript.segments.map((s) => s.text).join(" "));
        } else {
          setModelText(null);
        }
      } catch {
        if (cancelled) return;
        setModelText(null);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [sentenceHash, source.kind, uploadedAudioPath, waitingModel]);

  return (
    <div
      onPointerDown={() => {
        if (audioUnlockTriedRef.current) return;
        audioUnlockTriedRef.current = true;
        void unlockAudioFromUserGesture().catch(() => {});
      }}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <TopNav
          current="record"
          onBack={onBack}
          onOpenIpaList={onOpenIpaList}
          onOpenDevelopersMistakes={onOpenDevelopersMistakes}
          onOpenCommonMistakes={onOpenCommonMistakes}
        />

        {/* Audio Debug Info - コメントアウトして非表示
        {audioDebugInfo && (
          <Typography.Paragraph
            style={{
              fontSize: 11,
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              backgroundColor: "#f5f5f5",
              padding: 8,
              borderRadius: 4,
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            <strong>Audio Debug:</strong>
            <br />
            {audioDebugInfo}
            <br />
            <strong>Current headerAudioUrl:</strong> {headerAudioUrl?.substring(0, 100) || "null"}
          </Typography.Paragraph>
        )}
        */}

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
          <HeaderAudioPlayButton
            url={headerAudioUrl}
            loading={isHeaderAudioLoading}
            disabled={!headerAudioUrl || isHeaderAudioLoading}
          />
          <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>
            {displayText || sentence.text}
          </Typography.Title>
          <Button
            onClick={async () => {
              console.log("model recognize clicked");

              if (waitingModel) return;

              if (source.kind === "uploaded") {
                if (!uploadedAudioPath) return;
                const cached = await loadUploadedTranscript(uploadedAudioPath);
                if (cached) {
                  const overwrite = await confirmOverwriteExisting();
                  if (!overwrite) {
                    setModelText(cached.segments.map((s) => s.text).join(" "));
                    return;
                  }
                }
              } else {
                const cached = await loadModelTranscript(sentenceHash);
                if (cached) {
                  const overwrite = await confirmOverwriteExisting();
                  if (!overwrite) {
                    setModelText(cached.segments.map((s) => s.text).join(" "));
                    return;
                  }
                }
              }

              setWaitingModel(true);
              setIsTranscribing(true);

              if (source.kind === "uploaded" && uploadedAudioPath) {
                invoke("run_whisper_uploaded", {
                  uploadedPath: uploadedAudioPath,
                  sentenceHash: sentenceHash,
                  lang: sentence.lang,
                });
              } else {
                invoke("run_whisper_model", {
                  url: sentence.audioUrl,
                  sentenceHash: sentenceHash,
                  lang: sentence.lang,
                });
              }
            }}
            loading={waitingModel}
            disabled={
              (source.kind === "uploaded" && !uploadedAudioPath) ||
              waitingModel ||
              Boolean(modelText?.trim())
            }
          >
            {source.kind === "uploaded"
              ? "アップロード音声を音声認識する"
              : "模範音声を音声認識する"}
          </Button>
        </div>
        <Typography.Paragraph>
          <strong>Model transcript:</strong>
          <br />
          {modelText ? (
            modelText
          ) : (
            <Typography.Text type="secondary">
              音声認識されていません
            </Typography.Text>
          )}
        </Typography.Paragraph>
        {linkingResult?.joined && (
          <LinkingStressArea
            linkingResult={linkingResult}
            linkingDisplayMode={linkingDisplayMode}
            setLinkingDisplayMode={setLinkingDisplayMode}
            ipaIndex={ipaIndex}
          />
        )}
        <Typography.Text type="secondary">
          Model status: {status}
        </Typography.Text>

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

              setRecognizing((prev) => ({
                ...prev,
                [movedPath]: true,
              }));
              setTranscripts((prev) => ({
                ...prev,
                [movedPath]: null,
              }));
              setIsTranscribing(true);

              try {
                await invoke("run_whisper", {
                  path: movedPath,
                  sentenceHash: sentenceHash,
                  lang: sentence.lang,
                });
              } catch {
                setRecognizing((prev) => {
                  if (!prev[movedPath]) return prev;
                  const next = { ...prev };
                  delete next[movedPath];
                  return next;
                });
                setIsTranscribing(false);
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
        <RecordingsList
          recordings={recordings}
          transcripts={transcripts}
          recognizing={recognizing}
          recognizeRecording={recognizeRecording}
          audioUrls={audioUrls}
          preferAssetProtocol={preferAssetProtocol}
          toAssetUrl={toAssetUrl}
          ensureBlobAudioUrl={ensureBlobAudioUrl}
          addToAnki={addToAnki}
        />
      </Space>
    </div>
  );
};
export default RecorderScreen;
