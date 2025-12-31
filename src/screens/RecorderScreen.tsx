import { useEffect, useState, useRef, type ReactNode } from "react";
function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
import { Button, message, Space, Spin, Typography, Radio, theme } from "antd";
import { startRecording, stopRecording } from "tauri-plugin-mic-recorder-api";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PlayCircleOutlined } from "@ant-design/icons";
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
import {
  loadModelTranscript,
  loadTranscript,
  loadUploadedTranscript,
  parseRecording,
} from "./recorder/transcriptUtils";
async function ankiRequest(payload: any) {
  const urls = ["http://127.0.0.1:8765", "http://localhost:8765"];
  let lastError: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      return json;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `AnkiConnectに接続できませんでした（既定: 127.0.0.1:8765）。Ankiを起動し、AnkiConnectアドオンが有効か確認してください。詳細: ${String(lastError)}`
  );
}
import { renderLinkingRust } from "../utils/linkingInvoke";
import type { RenderLinkingResult, DisplayMode } from "../types/linking";
import { loadIpaIndex, type IpaIndex } from "../utils/ipaResources";
import { tokenizeIpa } from "../utils/ipaTokenize";
import {
  playBundledAudio,
  unlockAudioFromUserGesture,
} from "../utils/ipaPlayer";
import TopNav from "../components/TopNav";
import RecordingsList from "../components/RecordingsList";
import type { Recording, Transcript } from "../types/recording";

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

function confirmOverwriteExisting(): Promise<boolean> {
  return new Promise((resolve) => {
    message.info({
      content: "既に保存済みの音声があります。上書きしますか？（自動でOK）",
      duration: 1,
      onClick: () => resolve(true),
      onClose: () => resolve(false),
    });
    setTimeout(() => resolve(true), 1000);
  });
}

type FinalResultPayload = {
  wav_path: string;
  segments: { text: string }[];
};

const RecorderScreen = ({
  source,
  onBack,
  onOpenIpaList,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: RecorderScreenProps) => {
  const { token: antdToken } = theme.useToken();
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
  const [status, setStatus] = useState<string>("idle");
  const modelMissingShown = useRef(false);
  const [progress, setProgress] = useState<number | null>(null);
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
  const hoverTimerRef = useRef<number | null>(null);
  const lastHoverRef = useRef<{ tok: string; ts: number } | null>(null);
  const [ipaIndexError, setIpaIndexError] = useState<string | null>(null);
  const [ipaHoverDebug, setIpaHoverDebug] = useState<{
    ts: number;
    tok: string;
    event: "enter" | "click";
    result: "started" | "ok" | "failed";
    message?: string;
  } | null>(null);

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
      console.warn(`IPA play failed (${event}): ${tok} (${msg})`, e);
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

  function renderTokenizedIpa(ipa: string, keys: string[]): ReactNode {
    const tokens = tokenizeIpa(ipa, keys);

    const vowels = new Set(Array.from("iɪeɛæaɑɒɔoʊuʌəɜɞɵøyʉɯɐɶœɨʏɤɘɚɝ"));

    function colorForTok(tok: string): string | undefined {
      if (tok === "ˈ") return antdToken.colorErrorText;
      if (tok === "ˌ") return antdToken.colorWarningText;
      if (tok.trim() === "") return undefined;
      if (tok.includes("̩")) return antdToken.colorSuccessText;
      if (Array.from(tok).some((ch) => vowels.has(ch))) {
        return antdToken.colorSuccessText;
      }
      if (/^[.ːˑ‿\-–—'']+$/.test(tok)) {
        return antdToken.colorTextSecondary;
      }
      return antdToken.colorInfoText;
    }

    return (
      <>
        {tokens.map((tok, j) => {
          const entry = ipaIndex?.[tok];
          const color = colorForTok(tok);

          const hoverAudio = entry?.audio;
          const clickAudio = entry?.explainAudio ?? entry?.audio;
          const isInteractive = Boolean(hoverAudio || clickAudio);

          if (!entry || !isInteractive) {
            return (
              <span key={`ipa-tok-${j}`} style={{ color }}>
                {tok}
              </span>
            );
          }

          return (
            <span
              key={`ipa-tok-${j}`}
              style={{
                cursor: "pointer",
                textDecoration: "underline",
                color,
              }}
              onPointerEnter={() => {
                if (!hoverAudio) return;
                requestPlayIpaTok(tok, hoverAudio, "enter");
              }}
              onClick={() => {
                if (!clickAudio) return;
                requestPlayIpaTok(tok, clickAudio, "click");
              }}
            >
              {tok}
            </span>
          );
        })}
      </>
    );
  }

  function renderLegend(): ReactNode {
    if (linkingDisplayMode === "phoneme") {
      return (
        <Typography.Text type="secondary" style={{ display: "block" }}>
          <Typography.Text style={{ color: antdToken.colorErrorText }}>
            ˈ 強勢
          </Typography.Text>
          {" / "}
          <Typography.Text style={{ color: antdToken.colorWarningText }}>
            ˌ 副強勢
          </Typography.Text>
          {" / "}
          <Typography.Text style={{ color: antdToken.colorSuccessText }}>
            母音
          </Typography.Text>
          {" / "}
          <Typography.Text style={{ color: antdToken.colorInfoText }}>
            子音
          </Typography.Text>
          {" / "}
          <Typography.Text type="secondary">記号</Typography.Text>
        </Typography.Text>
      );
    }

    return (
      <Typography.Text type="secondary" style={{ display: "block" }}>
        <Typography.Text style={{ color: antdToken.colorErrorText }}>
          ˈ 強勢
        </Typography.Text>
        {" / "}
        <Typography.Text style={{ color: antdToken.colorWarningText }}>
          ˌ 副強勢
        </Typography.Text>
        {" / "}
        <Typography.Text type="secondary">弱</Typography.Text>
      </Typography.Text>
    );
  }

  function stressType(mark: string): "danger" | "warning" | "secondary" {
    switch (mark) {
      case "▲":
        return "danger";
      case "△":
        return "warning";
      default:
        return "secondary";
    }
  }

  function renderStressColored(text: string): ReactNode {
    const marks = new Set(["▲", "△", "▽"]);

    function renderMarkedInline(s: string, fontSize: number): ReactNode {
      const stops = new Set(["▲", "△", "▽"]);
      const out: ReactNode[] = [];
      let i = 0;

      while (i < s.length) {
        const ch = s[i];
        if (marks.has(ch)) {
          const start = i;
          i += 1;
          const segStart = i;
          while (i < s.length && !stops.has(s[i])) i += 1;
          const seg = s.slice(segStart, i);

          const sym = ch === "▲" ? "ˈ" : ch === "△" ? "ˌ" : "";
          out.push(
            <Typography.Text
              key={`m-${start}`}
              type={stressType(ch)}
              style={{ fontSize }}
            >
              {sym}
              {seg}
            </Typography.Text>
          );
          continue;
        }

        const start = i;
        i += 1;
        while (i < s.length && !marks.has(s[i])) i += 1;
        const seg = s.slice(start, i).replace(/[▲△▽]/g, "");
        out.push(
          <span key={`u-${start}`} style={{ fontSize }}>
            {seg}
          </span>
        );
      }

      return out;
    }

    if (linkingDisplayMode === "kana") {
      const parts = text.split(/(\|)/g);

      return (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "flex-end",
          }}
        >
          {parts
            .map((p) => p)
            .filter((p) => p !== "")
            .map((part, idx) => {
              if (part === "|") {
                return (
                  <div
                    key={`sep-k-${idx}`}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                    }}
                  >
                    <div style={{ minHeight: 18 }} />
                    <Typography.Text style={{ fontSize: 18, lineHeight: 1.2 }}>
                      |
                    </Typography.Text>
                  </div>
                );
              }

              const raw = part;
              if (!raw.trim()) return null;

              const bracketMatches = raw.match(/\([^)]*\)|（[^）]*）/g) ?? [];
              const firstBracket = bracketMatches[0];
              const kanaText = firstBracket ? firstBracket.slice(1, -1) : "";

              const mainText = raw
                .replace(/\([^)]*\)/g, "")
                .replace(/（[^）]*）/g, "")
                .replace(/[▲△▽]/g, "")
                .trim();

              const displayKana = kanaText
                ? renderMarkedInline(kanaText, 14)
                : null;

              return (
                <div
                  key={`k-${idx}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      display: "block",
                      lineHeight: 1.2,
                      minHeight: 18,
                      whiteSpace: "pre",
                    }}
                  >
                    {displayKana}
                  </div>
                  <Typography.Text style={{ fontSize: 18, lineHeight: 1.2 }}>
                    {mainText}
                  </Typography.Text>
                </div>
              );
            })}
        </div>
      );
    }

    if (linkingDisplayMode !== "phoneme" || !ipaIndex) {
      return <span style={{ fontSize: 18 }}>{text.replace(/[▲△▽]/g, "")}</span>;
    }

    const keys = Object.keys(ipaIndex);
    const parts = text.split(/(\|)/g);

    return (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "flex-end",
        }}
      >
        {parts
          .map((p) => p)
          .filter((p) => p !== "")
          .map((part, idx) => {
            if (part === "|") {
              return (
                <div
                  key={`sep-${idx}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <div style={{ minHeight: 18 }} />
                  <Typography.Text style={{ fontSize: 18, lineHeight: 1.2 }}>
                    |
                  </Typography.Text>
                </div>
              );
            }

            const rawWithMarks = part;
            if (!rawWithMarks.trim()) return null;

            const bracketMatches =
              rawWithMarks.match(/\([^)]*\)|（[^）]*）/g) ?? [];
            const firstBracket = bracketMatches[0];
            const ipaTextRaw = firstBracket ? firstBracket.slice(1, -1) : "";

            const ipaWithStress = ipaTextRaw
              .replace(/▲/g, "ˈ")
              .replace(/△/g, "ˌ")
              .replace(/▽/g, "")
              .trim();

            const mainText = rawWithMarks
              .replace(/\([^)]*\)/g, "")
              .replace(/（[^）]*）/g, "")
              .replace(/[▲△▽]/g, "")
              .trim();

            const displayIpa = ipaWithStress
              ? renderTokenizedIpa(ipaWithStress, keys)
              : null;

            return (
              <div
                key={`w-${idx}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    display: "block",
                    fontSize: 18,
                    lineHeight: 1.2,
                    minHeight: 18,
                    whiteSpace: "pre",
                  }}
                >
                  {displayIpa}
                </div>
                <Typography.Text style={{ fontSize: 18, lineHeight: 1.2 }}>
                  {mainText}
                </Typography.Text>
              </div>
            );
          })}
      </div>
    );
  }

  function extractStressWords(res: RenderLinkingResult): {
    primary: string[];
    secondary: string[];
  } {
    const stopwords = new Set([
      "a",
      "an",
      "the",
      "to",
      "of",
      "and",
      "or",
      "but",
      "for",
      "nor",
      "so",
      "yet",
      "in",
      "on",
      "at",
      "by",
      "from",
      "with",
      "as",
      "about",
      "into",
      "over",
      "after",
      "before",
      "under",
      "between",
      "through",
      "during",
      "without",
      "within",
      "do",
      "did",
      "does",
      "done",
      "is",
      "am",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "will",
      "would",
      "can",
      "could",
      "shall",
      "should",
      "may",
      "might",
      "must",
      "i",
      "you",
      "we",
      "they",
      "he",
      "she",
      "it",
      "me",
      "him",
      "her",
      "us",
      "them",
      "my",
      "your",
      "his",
      "their",
      "our",
      "this",
      "that",
      "these",
      "those",
    ]);

    const normalize = (w: string) =>
      w.toLowerCase().replace(/^[^a-z']+|[^a-z']+$/gi, "");

    const pickRepresentativeWord = (words: string[]): string => {
      const cleaned = words.map((w) => w.trim()).filter(Boolean);
      if (cleaned.length === 0) return "";
      for (let i = cleaned.length - 1; i >= 0; i--) {
        const norm = normalize(cleaned[i]);
        if (!norm) continue;
        if (!stopwords.has(norm)) return cleaned[i];
      }
      return cleaned[cleaned.length - 1];
    };

    const primary = new Set<string>();
    const secondary = new Set<string>();

    for (const c of res.chunks) {
      const rendered = c.rendered ?? "";
      const hasPrimary = rendered.includes("▲") || rendered.includes("ˈ");
      const hasSecondary = rendered.includes("△") || rendered.includes("ˌ");
      if (!hasPrimary && !hasSecondary) continue;

      const rep = pickRepresentativeWord(c.words ?? []);
      if (!rep) continue;

      if (hasPrimary) primary.add(rep);
      if (hasSecondary) secondary.add(rep);
    }

    return {
      primary: Array.from(primary),
      secondary: Array.from(secondary),
    };
  }

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

  useEffect(() => {
    invoke<string>("get_model_status")
      .then(setStatus)
      .catch(() => setStatus("idle"));

    const unlistenPromise = listen<string>("model-status", (e) => {
      setStatus(e.payload);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<number>("model-progress", (e) => {
      setProgress(e.payload);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

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

  useEffect(() => {
    const unlisten = listen<string>("transcript-started", (e) => {
      const wavPath = e.payload;
      setTranscripts((prev) => ({
        ...prev,
        [wavPath]: null,
      }));

      setRecognizing((prev) => ({
        ...prev,
        [wavPath]: true,
      }));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("transcript-ready", async (e) => {
      const wavPath = e.payload;
      if (!wavPath.endsWith(".wav")) return;

      const transcript = await loadTranscript(wavPath);
      setWaitingModel(false);
      setIsTranscribing(false);

      setRecognizing((prev) => {
        if (!prev[wavPath]) return prev;
        const next = { ...prev };
        delete next[wavPath];
        return next;
      });

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

        setRecognizing((prev) => {
          if (!prev[result.wav_path]) return prev;
          const next = { ...prev };
          delete next[result.wav_path];
          return next;
        });

        if (waitingModel) {
          setModelText(result.segments.map((s) => s.text).join(" "));
          setWaitingModel(false);
          return;
        }

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
          [result.wav_path]: {
            segments: (result.segments as any[]).map((seg) => ({
              start: 0, // 必要なら推定値を入れる
              end: 0,
              text: seg.text,
            })),
          },
        }));
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [waitingModel]);

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
          <Button
            type="text"
            icon={<PlayCircleOutlined />}
            disabled={!headerAudioUrl || isHeaderAudioLoading}
            loading={isHeaderAudioLoading}
            onClick={async () => {
              if (!headerAudioUrl) {
                message.info("音声を読み込み中…");
                return;
              }

              try {
                const audio = new Audio(headerAudioUrl);
                await audio.play();
              } catch (e) {
                console.error("Audio playback failed:", e);
                message.error("音声の再生に失敗しました");
              }
            }}
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
          <>
            <Space size={8} style={{ display: "flex" }}>
              <Typography.Text type="secondary">表示:</Typography.Text>
              <Radio.Group
                size="small"
                value={linkingDisplayMode}
                onChange={(e) => setLinkingDisplayMode(e.target.value)}
                options={[
                  { label: "phoneme", value: "phoneme" },
                  { label: "kana", value: "kana" },
                ]}
                optionType="button"
                buttonStyle="solid"
              />

              <Typography.Text type="secondary" style={{ display: "block" }}>
                IPA audio:{" "}
                {ipaIndex
                  ? `${Object.keys(ipaIndex).length} keys`
                  : "not loaded"}
                {ipaIndexError ? ` (error: ${ipaIndexError})` : ""}
                {linkingResult?.joined
                  ? ` | mode: ${linkingDisplayMode} | parens: ${linkingResult.joined.includes("(") || linkingResult.joined.includes("（") ? "yes" : "no"}`
                  : ""}
                {ipaHoverDebug
                  ? ` | last: ${ipaHoverDebug.tok} ${ipaHoverDebug.event} ${ipaHoverDebug.result}` +
                    (ipaHoverDebug.message ? ` (${ipaHoverDebug.message})` : "")
                  : ""}
              </Typography.Text>
            </Space>
            {renderLegend()}
            {(linkingDisplayMode === "phoneme" ||
              linkingDisplayMode === "kana") && (
              <Typography.Text type="secondary" style={{ display: "block" }}>
                {(() => {
                  const { primary, secondary } =
                    extractStressWords(linkingResult);
                  const p = primary.length ? primary.join(" / ") : "なし";
                  const s = secondary.length ? secondary.join(" / ") : "なし";
                  return `強勢: ${p} / 副強勢: ${s}`;
                })()}
              </Typography.Text>
            )}
            <div style={{ display: "block", fontSize: 18, lineHeight: 1.6 }}>
              {renderStressColored(linkingResult.joined)}
            </div>
          </>
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
