import { useEffect, useState, useRef } from "react";
import { Button, message, Space, Spin, Typography } from "antd";
import { invoke } from "@tauri-apps/api/core";
//import { listen } from "@tauri-apps/api/event";
import type { Sentence } from "../components/ExampleList";
import { sha256 } from "../utils/hash";
import { loadIpaIndex, type IpaIndex } from "../utils/ipaResources";
import {
  playBundledAudio,
  unlockAudioFromUserGesture,
} from "../utils/ipaPlayer";
import TopNav from "../components/TopNav";
import RecordingsList from "../components/RecordingsList";
import type { Recording, Transcript } from "../types/recording";
import { useRecording } from "../hooks/useRecording";
import { RecordingControls } from "../components/RecordingControls";
import { ModelTranscriptSection } from "../components/ModelTranscriptSection";

/*
import { useTranscription } from "../hooks/useTranscription";
import { useAudio } from "../hooks/useAudio";
import { useLinking } from "../hooks/useLinking";
import { useModelStatus } from "../hooks/useModelStatus";
import { useUploadedAudio } from "../hooks/useUploadedAudio";
import { useModelTranscript } from "../hooks/useModelTranscript";
import { SentenceHeader } from "../components/SentenceHeader";
import { LinkingDisplay } from "../components/LinkingDisplay";
*/

//import { addToAnki } from "../services/ankiService";
//import { loadTranscript } from "../utils/transcriptUtils";

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function parseRecording(str: string): Recording {
  const [path, fileName, timestamp, dateLabel] = str.split("|");
  return { path, fileName, timestamp, dateLabel } as Recording;
}

type RecorderScreenProps = {
  source: any;
  onBack: () => void;
  onOpenIpaList: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

const RecorderScreen = ({
  source,
  onBack,
  onOpenIpaList,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: RecorderScreenProps) => {
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

  const [sentenceHash, setSentenceHash] = useState<string>("");
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [displayText, setDisplayText] = useState<string>(sentence.text);
  const [ipaIndex, setIpaIndex] = useState<IpaIndex | null>(null);
  const [ipaIndexError, setIpaIndexError] = useState<string | null>(null);
  const [ipaHoverDebug, setIpaHoverDebug] = useState<any>(null);

  const audioUnlockTriedRef = useRef(false);
  const hoverTimerRef = useRef<number | null>(null);
  const lastHoverRef = useRef<{ tok: string; ts: number } | null>(null);
  const modelMissingShown = useRef(false);

  useEffect(() => {
    if (source.kind === "uploaded" && source.sentenceHash) {
      setSentenceHash(source.sentenceHash);
      return;
    }
    sha256(sentence.text, sentence.lang).then(setSentenceHash);
  }, [source, sentence.text, sentence.lang]);

  useEffect(() => {
    setDisplayText(sentence.text);
  }, [sentence.text]);

  // Custom hooks
  const { status, progress } = useModelStatus(modelMissingShown);
  const { uploadedAudioPath } = useUploadedAudio(
    source,
    sentenceHash,
    sentence
  );
  const {
    modelText,
    setModelText,
    waitingModel,
    setWaitingModel,
    handleRecognizeModel,
  } = useModelTranscript(
    source,
    sentenceHash,
    sentence.lang,
    uploadedAudioPath,
    sentence.audioUrl
  );

  const {
    isRecording,
    isTranscribing,
    setIsTranscribing,
    handleStartRecording,
    handleStopRecording,
  } = useRecording(sentenceHash, sentence.lang);

  const {
    transcripts,
    setTranscripts,
    recognizing,
    setRecognizing,
    recognizeRecording,
  } = useTranscription(
    sentenceHash,
    sentence.lang,
    waitingModel,
    setWaitingModel,
    setModelText,
    setDisplayText,
    source.kind === "uploaded",
    !sentence.text || sentence.text.trim() === ""
  );

  const {
    audioUrls,
    setAudioUrls,
    headerAudioUrl,
    isHeaderAudioLoading,
    ensureBlobAudioUrl,
    toAssetUrl,
  } = useAudio(
    sentence.audioUrl,
    source.kind,
    uploadedAudioPath,
    preferAssetProtocol
  );

  const { linkingResult, linkingDisplayMode, setLinkingDisplayMode } =
    useLinking(displayText, sentence.text, sentence.lang);

  // IPA resources
  useEffect(() => {
    loadIpaIndex()
      .then((idx) => {
        setIpaIndex(idx);
        setIpaIndexError(null);
      })
      .catch((e) => {
        setIpaIndex(null);
        const msg = String((e as any)?.message ?? e);
        setIpaIndexError(msg);
        message.error(`IPA index 読み込み失敗: ${msg}`);
      });
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };
  }, []);

  // IPA playback functions
  async function playIpaTok(
    tok: string,
    audioPath: string,
    event: "enter" | "click"
  ) {
    setIpaHoverDebug({ ts: Date.now(), tok, event, result: "started" });
    try {
      await playBundledAudio(audioPath);
      setIpaHoverDebug({ ts: Date.now(), tok, event, result: "ok" });
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      setIpaHoverDebug({
        ts: Date.now(),
        tok,
        event,
        result: "failed",
        message: msg,
      });
      if (event === "click") {
        if (/user gesture|required/i.test(msg)) {
          message.info("最初に画面を1回クリックして音声を有効化してください");
        } else {
          message.error(`再生に失敗: ${tok} (${msg})`);
        }
      }
    }
  }

  function requestPlayIpaTok(
    tok: string,
    audioPath: string,
    event: "enter" | "click"
  ) {
    if (event === "enter") {
      const now = Date.now();
      const last = lastHoverRef.current;
      if (last && now - last.ts < 120) return;
      lastHoverRef.current = { tok, ts: now };

      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }

      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        void playIpaTok(tok, audioPath, event);
      }, 60);
      return;
    }

    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    void playIpaTok(tok, audioPath, event);
  }

  // Recordings management
  const refreshFiles = async () => {
    const list = await invoke<string[]>("list_recordings", { sentenceHash });
    const parsed = list.map(parseRecording).sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return b.timestamp.localeCompare(a.timestamp);
    });
    setRecordings(parsed);
  };

  useEffect(() => {
    setRecordings([]);
    setTranscripts({});
    setModelText(null);
    setWaitingModel(false);
    setAudioUrls((prev) => {
      for (const url of Object.values(prev)) {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      }
      return {};
    });
    refreshFiles();
  }, [sentenceHash]);

  useEffect(() => {
    const run = async () => {
      for (const rec of recordings) {
        if (transcripts[rec.path] === undefined) {
          const transcript = await loadTranscript(rec.path);
          setTranscripts((prev) => ({ ...prev, [rec.path]: transcript }));
        }
      }
    };
    run();
  }, [recordings]);

  const handleAddToAnki = async (rec: Recording) => {
    try {
      await addToAnki(
        rec,
        displayText || sentence.text,
        sentence.audioUrl,
        sentenceHash,
        sentence.lang,
        source.kind,
        uploadedAudioPath
      );
      message.success("Ankiに追加しました");
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e);
      message.error({
        content: (
          <span
            style={{ whiteSpace: "pre-line" }}
          >{`Ankiへの追加に失敗しました：\n${details}`}</span>
        ),
      });
    }
  };

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

        {isTranscribing && (
          <Space>
            <Spin size="small" />
            <Typography.Text type="secondary">文字起こし中…</Typography.Text>
          </Space>
        )}

        <SentenceHeader
          displayText={displayText}
          sentenceText={sentence.text}
          headerAudioUrl={headerAudioUrl}
          isHeaderAudioLoading={isHeaderAudioLoading}
        />

        <ModelTranscriptSection
          modelText={modelText}
          waitingModel={waitingModel}
          uploadedAudioPath={uploadedAudioPath}
          sourceKind={source.kind}
          onRecognize={() => handleRecognizeModel(setIsTranscribing)}
        />

        {linkingResult?.joined && (
          <LinkingDisplay
            linkingResult={linkingResult}
            linkingDisplayMode={linkingDisplayMode}
            setLinkingDisplayMode={setLinkingDisplayMode}
            ipaIndex={ipaIndex}
            ipaIndexError={ipaIndexError}
            ipaHoverDebug={ipaHoverDebug}
            requestPlayIpaTok={requestPlayIpaTok}
          />
        )}

        <RecordingControls
          isRecording={isRecording}
          status={status}
          progress={progress}
          onStartRecording={handleStartRecording}
          onStopRecording={() =>
            handleStopRecording(
              (movedPath) => {
                setRecognizing((prev) => ({ ...prev, [movedPath]: true }));
                setTranscripts((prev) => ({ ...prev, [movedPath]: null }));
                refreshFiles();
              },
              () => refreshFiles()
            )
          }
        />

        <Typography.Title level={5}>Recordings</Typography.Title>
        <RecordingsList
          recordings={recordings}
          transcripts={transcripts}
          recognizing={recognizing}
          recognizeRecording={(rec) =>
            recognizeRecording(rec, status).catch((e) => {
              setIsTranscribing(false);
              message.error("音声認識の開始に失敗しました: " + String(e));
            })
          }
          audioUrls={audioUrls}
          preferAssetProtocol={preferAssetProtocol}
          toAssetUrl={toAssetUrl}
          ensureBlobAudioUrl={ensureBlobAudioUrl}
          addToAnki={handleAddToAnki}
        />
      </Space>
    </div>
  );
};

export default RecorderScreen;
