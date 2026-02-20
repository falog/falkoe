import {
  Input,
  Space,
  Typography,
  Select,
  Checkbox,
  Button,
  Spin,
  Modal,
  InputNumber,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ExampleList, { Sentence } from "../components/ExampleList";
import AudioUpload from "../components/AudioUpload";
import { invoke } from "@tauri-apps/api/core";
import type { SpeechSource } from "../types/speech";
import { sha256Bytes } from "../utils/hash";
import TopNav from "../components/TopNav";
import { LANG_OPTIONS } from "../data/langOptions";

const NONE_TRANSLATION = "none";

const WORD_COUNT = [
  { value: "1-", label: "1 word or more" },
  { value: "2-", label: "2 words or more" },
  { value: "3-", label: "3 words or more" },
  { value: "4-", label: "4 words or more" },
  { value: "5-", label: "5 words or more" },
  { value: "6-", label: "6 words or more" },
  { value: "7-", label: "7 words or more" },
  { value: "8-", label: "8 words or more" },
  { value: "9-", label: "9 words or more" },
  { value: "10-", label: "10 words or more" },
];

type WordInputScreenProps = {
  lang: string;
  setLang: (lang: string) => void;
  word: string;
  sentences: Sentence[];
  wordcount: string;
  onWordChange: (v: string) => void;
  onSearchResult: (s: Sentence[]) => void;
  onWordcount: (wc: string) => void;
  onSelect: (s: Sentence) => void;
  onUseSpeech: (source: SpeechSource) => void;
  onOpenHistory: () => void;
  onOpenIpaList: () => void;
  onOpenAudioCutter: () => void;
  onOpenSettings: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

type UploadedAudioInfo = {
  exists: boolean;
  path: string;
};

type UploadQueueItem = {
  file: File;
  lang: string;
};

type UploadedItem = {
  originalFilename: string;
  lang: string;
  sentenceHash: string;
  savedPath: string;
};

type UpsertManifestTextResult = {
  status: "created" | "updated" | "conflict";
  manifestPath: string;
  previousText?: string | null;
};

async function fetchExamples(
  word: string,
  lang: string,
  wordcount: string,
  translateTo: string | null,
): Promise<Sentence[]> {
  const showTransLang =
    translateTo && translateTo !== NONE_TRANSLATION && translateTo !== lang
      ? translateTo
      : null;

  const getLangCode = (x: any): string | null => {
    if (!x) return null;
    if (typeof x === "string") return x;
    if (typeof x.code === "string") return x.code;
    return null;
  };

  const fetchJson = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    return await res.json();
  };

  const asStringOrNull = (x: any): string | null =>
    typeof x === "string" && x.trim() ? x : null;

  const asNumberOrNull = (x: any): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;

  const toTatoebaSentence = async (
    s: any,
    translation: string | null,
    langFallback: string,
  ): Promise<Sentence | null> => {
    const id = asNumberOrNull(s?.id);
    const text = asStringOrNull(s?.text);
    const langCode = asStringOrNull(s?.lang) ?? langFallback;
    if (!id || !text) return null;

    const sentenceLicense = asStringOrNull(s?.license);
    const sentenceOwner = asStringOrNull(s?.owner);

    const audios = Array.isArray(s?.audios) ? s.audios : [];
    const a0 = audios.length > 0 ? audios[0] : null;
    let audioId = asNumberOrNull(a0?.id);
    const audioLicense =
      asStringOrNull(a0?.license) ??
      asStringOrNull(a0?.license_name) ??
      asStringOrNull(a0?.licenseName);
    let audioAuthor =
      asStringOrNull(a0?.author) ??
      asStringOrNull(a0?.username) ??
      asStringOrNull(a0?.user) ??
      asStringOrNull(a0?.owner);
    let audioAttributionUrl =
      asStringOrNull(a0?.attribution_url) ??
      asStringOrNull(a0?.attributionUrl) ??
      asStringOrNull(a0?.url);
    if (!sentenceLicense) return null;

    return {
      id,
      text,
      translation,
      audioUrl: `https://audio.tatoeba.org/sentences/${langCode}/${id}.mp3`,
      lang: langCode,
      attribution: {
        provider: "tatoeba",
        sentenceLicense,
        sentenceOwner,
        sentenceUrl: `https://tatoeba.org/en/sentences/show/${id}`,
        audioLicense: audioLicense ?? sentenceLicense,
        audioAuthor,
        audioAttributionUrl,
        audioId,
      },
    };
  };

  const toSentencesFromSameLang = async (data: any): Promise<Sentence[]> => {
    if (!data || !Array.isArray(data.data)) return [];
    const out: Sentence[] = [];
    for (const s of data.data) {
      let translation: string | null = null;
      if (showTransLang && Array.isArray(s?.translations)) {
        const hit = s.translations.find((t: any) => {
          const lc = getLangCode(t?.lang);
          return lc === showTransLang;
        });
        if (hit && typeof hit.text === "string") {
          translation = hit.text;
        }
      }

      const sent = await toTatoebaSentence(s, translation, lang);
      if (sent) out.push(sent);
    }
    return out;
  };

  // 1) 通常: `lang` の文を検索し、必要なら `translateTo` の翻訳を表示
  const primaryUrl =
    `https://api.tatoeba.org/v1/sentences` +
    `?lang=${encodeURIComponent(lang)}` +
    `&q=${encodeURIComponent(word)}` +
    `&word_count=${encodeURIComponent(wordcount)}` +
    `&has_audio=yes` +
    `&sort=relevance` +
    `&include=audios` +
    (showTransLang
      ? `&showtrans:lang=${encodeURIComponent(showTransLang)}` +
        `&showtrans:is_direct=yes`
      : "");

  const primaryData = await fetchJson(primaryUrl);
  const primary = await toSentencesFromSameLang(primaryData);
  if (primary.length > 0 || !showTransLang) {
    return primary;
  }

  // 2) フォールバック: 入力語が翻訳側言語(例: 日本語)の可能性が高い場合
  //    `showTransLang` 側で検索し、`lang` の翻訳（=表示・練習する言語）を結果として返す。
  //    例: showTransLang=jpn で q=「こんにちは」 -> lang=eng の例文を返す
  const fallbackUrl =
    `https://api.tatoeba.org/v1/sentences` +
    `?lang=${encodeURIComponent(showTransLang)}` +
    `&q=${encodeURIComponent(word)}` +
    `&word_count=${encodeURIComponent(wordcount)}` +
    `&trans:lang=${encodeURIComponent(lang)}` +
    `&trans:is_direct=yes` +
    `&trans:has_audio=yes` +
    `&sort=relevance` +
    `&include=audios` +
    `&showtrans:lang=${encodeURIComponent(lang)}` +
    `&showtrans:is_direct=yes`;

  const fallbackData = await fetchJson(fallbackUrl);
  if (!fallbackData || !Array.isArray(fallbackData.data)) return [];

  const out: Sentence[] = [];
  const seen = new Set<number>();

  for (const sourceSentence of fallbackData.data) {
    const sourceText =
      sourceSentence && typeof sourceSentence.text === "string"
        ? sourceSentence.text
        : "";

    const translations = Array.isArray(sourceSentence?.translations)
      ? sourceSentence.translations
      : [];
    for (const t of translations) {
      const lc = getLangCode(t?.lang);
      if (lc !== lang) continue;
      if (typeof t?.id !== "number") continue;
      if (typeof t?.text !== "string") continue;
      if (seen.has(t.id)) continue;

      // showtrans側で検索した元文（=入力語が含まれる可能性が高い）を subtext に出す
      const sent = await toTatoebaSentence(t, sourceText || null, lang);
      if (!sent) continue;
      out.push(sent);
      seen.add(sent.id);
    }
  }

  return out;
}

const WordInputScreen = ({
  lang,
  setLang,
  word,
  sentences,
  wordcount,
  onWordChange,
  onWordcount,
  onSearchResult,
  onSelect,
  onUseSpeech,
  onOpenHistory,
  onOpenIpaList,
  onOpenAudioCutter,
  onOpenSettings,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: WordInputScreenProps) => {
  const { t } = useTranslation();

  function confirmOverwriteRecognizedText(): Promise<boolean> {
    return new Promise((resolve) => {
      Modal.confirm({
        title: t("screens.wordInput.confirmOverwriteRecognizedText.title"),
        content: t("screens.wordInput.confirmOverwriteRecognizedText.content"),
        okText: t("screens.wordInput.confirmOverwriteRecognizedText.ok"),
        cancelText: t(
          "screens.wordInput.confirmOverwriteRecognizedText.cancel",
        ),
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  function confirmOverwriteManualText(): Promise<boolean> {
    return new Promise((resolve) => {
      Modal.confirm({
        title: t("screens.wordInput.confirmOverwriteManualText.title"),
        content: t("screens.wordInput.confirmOverwriteManualText.content"),
        okText: t("screens.wordInput.confirmOverwriteManualText.ok"),
        cancelText: t("screens.wordInput.confirmOverwriteManualText.cancel"),
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  function confirmOverwriteExisting(): Promise<boolean> {
    return new Promise((resolve) => {
      Modal.confirm({
        title: t("screens.wordInput.confirmOverwriteExisting.title"),
        content: t("screens.wordInput.confirmOverwriteExisting.content"),
        okText: t("screens.wordInput.confirmOverwriteExisting.ok"),
        cancelText: t("screens.wordInput.confirmOverwriteExisting.cancel"),
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  function confirmOverwriteManifestText(
    prev: string,
    next: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      Modal.confirm({
        title: t("screens.wordInput.confirmOverwriteManifestText.title"),
        content: (
          <div>
            <div style={{ marginBottom: 8 }}>
              {t("screens.wordInput.confirmOverwriteManifestText.intro")}
            </div>
            <div>
              <Typography.Text strong>
                {t("screens.wordInput.confirmOverwriteManifestText.current")}
              </Typography.Text>
              <div style={{ whiteSpace: "pre-wrap" }}>{prev}</div>
            </div>
            <div style={{ marginTop: 8 }}>
              <Typography.Text strong>
                {t("screens.wordInput.confirmOverwriteManifestText.newInput")}
              </Typography.Text>
              <div style={{ whiteSpace: "pre-wrap" }}>{next}</div>
            </div>
          </div>
        ),
        okText: t("screens.wordInput.confirmOverwriteManifestText.ok"),
        cancelText: t("screens.wordInput.confirmOverwriteManifestText.cancel"),
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  function warnManualNeedsText(): void {
    Modal.warning({
      title: t("screens.wordInput.warnManualNeedsText.title"),
      content: t("screens.wordInput.warnManualNeedsText.content"),
      okText: t("screens.wordInput.warnManualNeedsText.ok"),
    });
  }

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [useSpeech, setUseSpeech] = useState(false);
  const [sentence, setSentence] = useState("");
  const [useRecognition, setUseRecognition] = useState(true);
  const [recognizedText, setRecognizedText] = useState<string>("");
  const [manualTextWord, setManualTextWord] = useState<string>("");
  const manualOverwritePromptedRef = useRef(false);
  const [savedUploadedPath, setSavedUploadedPath] = useState<string | null>(
    null,
  );
  const [savedUploadedFilename, setSavedUploadedFilename] = useState<
    string | null
  >(null);
  const [savedUploadedSentenceHash, setSavedUploadedSentenceHash] = useState<
    string | null
  >(null);
  const [savingUpload, setSavingUpload] = useState(false);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadDone, setUploadDone] = useState(0);
  const [queuedCount, setQueuedCount] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);
  const [selectedUploadIndex, setSelectedUploadIndex] = useState(0);
  const [uploadPaused, setUploadPaused] = useState(false);
  const [followLatest, setFollowLatest] = useState(true);
  const [uploadSearch, setUploadSearch] = useState("");
  const [uploadSearchMessage, setUploadSearchMessage] = useState<string | null>(
    null,
  );
  const lastSearchIndexRef = useRef(-1);
  const [currentUploadFilename, setCurrentUploadFilename] = useState<
    string | null
  >(null);
  const uploadQueueRef = useRef<UploadQueueItem[]>([]);
  const processedRef = useRef<UploadedItem[]>([]);
  const batchModeRef = useRef(false);
  const persistedAfterBatchRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);

  const isBatchImportActive = savingUpload || queuedCount > 0;

  function confirmLeaveDuringBatchImport(): Promise<boolean> {
    return new Promise((resolve) => {
      Modal.confirm({
        title: t("screens.wordInput.batchUpload.leaveDuringImport.title"),
        content: t("screens.wordInput.batchUpload.leaveDuringImport.content"),
        okText: t("screens.wordInput.batchUpload.leaveDuringImport.ok"),
        cancelText: t("screens.wordInput.batchUpload.leaveDuringImport.cancel"),
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  const guardedNavigate = (fn: () => void) => async () => {
    if (!isBatchImportActive) {
      fn();
      return;
    }
    const ok = await confirmLeaveDuringBatchImport();
    if (!ok) return;
    fn();
  };
  const [translateTo, setTranslateTo] = useState<string>(NONE_TRANSLATION);
  const translateOptions = [
    { value: NONE_TRANSLATION, label: "None" },
    ...LANG_OPTIONS,
  ];

  const filterLangOption = (input: string, option?: any) => {
    const label = typeof option?.label === "string" ? option.label : "";
    return label.toLowerCase().includes(input.toLowerCase());
  };

  // restore persisted selections
  useEffect(() => {
    try {
      const sp = sessionStorage.getItem("falkoe.uploadedSavedPath");
      const fn = sessionStorage.getItem("falkoe.uploadedFilename");
      const sh = sessionStorage.getItem("falkoe.uploadedSentenceHash");
      const us = sessionStorage.getItem("falkoe.useSpeech");
      const ur = sessionStorage.getItem("falkoe.useRecognition");
      const txt = sessionStorage.getItem("falkoe.manualText");
      const rt = sessionStorage.getItem("falkoe.recognizedText");
      const mtw = sessionStorage.getItem("falkoe.manualTextWord");
      const lg = sessionStorage.getItem("falkoe.lang");
      const tr = sessionStorage.getItem("falkoe.translateTo");

      if (sp) setSavedUploadedPath(sp);
      if (fn) setSavedUploadedFilename(fn);
      if (sh) setSavedUploadedSentenceHash(sh);
      if (us) setUseSpeech(us === "true");
      if (ur) setUseRecognition(ur === "true");
      if (txt) setSentence(txt);
      if (rt) setRecognizedText(rt);
      if (mtw) setManualTextWord(mtw);
      if (lg) setLang(lg);
      if (tr) setTranslateTo(tr);
    } catch {}
    setHydrated(true);
  }, [setLang]);

  // persist manual text and flags on change
  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem("falkoe.manualText", sentence);
      sessionStorage.setItem("falkoe.manualTextWord", manualTextWord);
      sessionStorage.setItem("falkoe.useSpeech", String(useSpeech));
      sessionStorage.setItem("falkoe.useRecognition", String(useRecognition));
      sessionStorage.setItem("falkoe.lang", lang);
      sessionStorage.setItem("falkoe.translateTo", translateTo);
    } catch {}
  }, [
    hydrated,
    sentence,
    manualTextWord,
    useSpeech,
    useRecognition,
    lang,
    translateTo,
  ]);

  const persistUploadedSelection = (
    savedPath: string,
    originalFilename: string,
    sentenceHash: string,
  ) => {
    try {
      sessionStorage.setItem("falkoe.uploadedSavedPath", savedPath);
      sessionStorage.setItem("falkoe.uploadedFilename", originalFilename);
      sessionStorage.setItem("falkoe.uploadedSentenceHash", sentenceHash);
      sessionStorage.setItem("falkoe.useSpeech", "true");
      sessionStorage.setItem("falkoe.useRecognition", String(useRecognition));
      sessionStorage.setItem("falkoe.manualText", sentence);
      sessionStorage.setItem("falkoe.lang", lang);
    } catch {}
  };

  const applyUploadedItemAsSelected = (
    item: UploadedItem,
    opts?: { persist?: boolean },
  ) => {
    setAudioFile(null);
    setSavedUploadedFilename(item.originalFilename);
    setSavedUploadedPath(item.savedPath);
    setSavedUploadedSentenceHash(item.sentenceHash);

    if (opts?.persist !== false) {
      persistUploadedSelection(
        item.savedPath,
        item.originalFilename,
        item.sentenceHash,
      );
    }
  };

  const selectProcessedIndex = (idx: number) => {
    const safe = Math.min(Math.max(idx, 0), processedRef.current.length - 1);
    const item = processedRef.current[safe];
    if (!item) return false;
    setFollowLatest(false);
    setSelectedUploadIndex(safe);
    applyUploadedItemAsSelected(item, { persist: true });
    return true;
  };

  const findInProcessed = (term: string, start: number) => {
    const q = term.trim().toLowerCase();
    if (!q) return -1;
    const items = processedRef.current;
    if (items.length === 0) return -1;

    const clampStart = Math.min(Math.max(start, 0), items.length - 1);
    for (let i = clampStart; i < items.length; i++) {
      if (items[i].originalFilename.toLowerCase().includes(q)) return i;
    }
    for (let i = 0; i < clampStart; i++) {
      if (items[i].originalFilename.toLowerCase().includes(q)) return i;
    }
    return -1;
  };

  const prioritizeInQueue = (term: string) => {
    const q = term.trim().toLowerCase();
    if (!q) return false;
    const qlist = uploadQueueRef.current;
    if (qlist.length === 0) return false;

    const idx = qlist.findIndex((x) => x.file.name.toLowerCase().includes(q));
    if (idx < 0) return false;
    const [hit] = qlist.splice(idx, 1);
    qlist.unshift(hit);
    // queuedCount は表示用なので、ref更新後に同期
    setQueuedCount(qlist.length);
    return true;
  };

  const startNewBatch = (files: File[]) => {
    if (!files || files.length === 0) return;
    batchModeRef.current = files.length > 1;
    persistedAfterBatchRef.current = false;

    uploadQueueRef.current = files.map((f) => ({ file: f, lang }));
    processedRef.current = [];

    setUploadPaused(false);
    setFollowLatest(true);
    setUploadTotal(files.length);
    setUploadDone(0);
    setQueuedCount(files.length);
    setProcessedCount(0);
    setSelectedUploadIndex(0);
    setCurrentUploadFilename(null);

    setUploadSearch("");
    setUploadSearchMessage(null);
    lastSearchIndexRef.current = -1;

    setAudioFile(null);
    setSavedUploadedFilename(null);
    setSavedUploadedPath(null);
    setSavedUploadedSentenceHash(null);
  };

  const processUpload = async (item: UploadQueueItem) => {
    const f = item.file;
    try {
      setSavingUpload(true);
      setCurrentUploadFilename(f.name);
      setAudioFile(f);
      setSavedUploadedFilename(f.name);
      setSavedUploadedPath(null);

      const arrayBuffer = await f.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // 保存先IDは常に audio_id (=音声バイト由来hash) に統一
      const sentenceHash = await sha256Bytes(bytes, item.lang);

      const info = await invoke<UploadedAudioInfo>("get_uploaded_audio_info", {
        sentenceHash,
        originalFilename: f.name,
      });

      if (info.exists) {
        // バッチ時は「同一バイト列=同一hash」なので、既存ファイルをそのまま利用してOK
        const overwrite = batchModeRef.current
          ? false
          : await confirmOverwriteExisting();

        if (!overwrite) {
          setSavedUploadedPath(info.path);
          setSavedUploadedSentenceHash(sentenceHash);
          const nextItem: UploadedItem = {
            originalFilename: f.name,
            lang: item.lang,
            sentenceHash,
            savedPath: info.path,
          };

          processedRef.current.push(nextItem);
          setProcessedCount(processedRef.current.length);

          // バッチ中の自動追従は sessionStorage 書き込みを避ける
          if (followLatest || processedRef.current.length === 1) {
            const idx = processedRef.current.length - 1;
            setSelectedUploadIndex(idx);
            applyUploadedItemAsSelected(nextItem, {
              persist: !batchModeRef.current,
            });
          }
          return;
        }
      }

      const savedPath = await invoke<string>("save_uploaded_audio", {
        fileData: Array.from(bytes),
        sentenceHash,
        originalFilename: f.name,
        overwrite: true,
      });

      setSavedUploadedPath(savedPath);
      setSavedUploadedSentenceHash(sentenceHash);
      const nextItem: UploadedItem = {
        originalFilename: f.name,
        lang: item.lang,
        sentenceHash,
        savedPath,
      };

      processedRef.current.push(nextItem);
      setProcessedCount(processedRef.current.length);

      if (followLatest || processedRef.current.length === 1) {
        const idx = processedRef.current.length - 1;
        setSelectedUploadIndex(idx);
        applyUploadedItemAsSelected(nextItem, {
          persist: !batchModeRef.current,
        });
      }
    } finally {
      setSavingUpload(false);
      setCurrentUploadFilename(null);
      setUploadDone((d) => d + 1);
      setAudioFile(null);
    }
  };

  // キューがある限り、1つずつ処理する（並列にしない）
  useEffect(() => {
    if (!useSpeech) return;
    if (savingUpload) return;
    if (uploadPaused) return;
    if (queuedCount <= 0) return;

    const next = uploadQueueRef.current.shift();
    if (!next) {
      setQueuedCount(0);
      return;
    }

    setQueuedCount(uploadQueueRef.current.length);
    void processUpload(next);
  }, [useSpeech, savingUpload, uploadPaused, queuedCount]);

  // バッチ完了後、選択中アイテムを1回だけ永続化
  useEffect(() => {
    if (!batchModeRef.current) return;
    if (persistedAfterBatchRef.current) return;
    if (savingUpload) return;
    if (queuedCount > 0) return;
    if (processedRef.current.length === 0) return;

    const idx = Math.min(
      Math.max(selectedUploadIndex, 0),
      processedRef.current.length - 1,
    );
    const item = processedRef.current[idx];
    applyUploadedItemAsSelected(item, { persist: true });
    persistedAfterBatchRef.current = true;
  }, [savingUpload, queuedCount, selectedUploadIndex]);

  // ワードが変わったら、次回フォーカス時に再度確認できるようにする
  useEffect(() => {
    manualOverwritePromptedRef.current = false;
  }, [word]);

  const search = async () => {
    if (!word.trim()) return;

    setHasSearched(true);
    setLoading(true);
    setError(null);

    try {
      const result = await fetchExamples(
        word.trim(),
        lang,
        wordcount,
        translateTo,
      );
      onSearchResult(result);
      console.log("result:", result.length);
    } catch (e) {
      console.error(e);
      setError(t("screens.wordInput.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <TopNav
        current="word"
        onOpenHistory={guardedNavigate(onOpenHistory)}
        onOpenIpaList={guardedNavigate(onOpenIpaList)}
        onOpenAudioCutter={guardedNavigate(onOpenAudioCutter)}
        onOpenSettings={guardedNavigate(onOpenSettings)}
        onOpenDevelopersMistakes={guardedNavigate(onOpenDevelopersMistakes)}
        onOpenCommonMistakes={guardedNavigate(onOpenCommonMistakes)}
      />
      <Typography.Title level={4}>
        {t("screens.wordInput.title")}
      </Typography.Title>
      <Checkbox
        checked={useSpeech}
        onChange={(e) => setUseSpeech(e.target.checked)}
      >
        {t("screens.wordInput.useSpeech")}
      </Checkbox>
      {useSpeech && (
        <Space
          orientation="vertical"
          style={{ width: "80%", padding: 12, border: "1px dashed #ccc" }}
        >
          <AudioUpload
            disabled={savingUpload}
            onUpload={(f) => {
              startNewBatch([f]);
            }}
            onUploadFiles={(files) => {
              startNewBatch(files);
            }}
          />

          {(uploadTotal > 0 || queuedCount > 0 || savingUpload) && (
            <Typography.Text type="secondary">
              {`${t("screens.wordInput.batchUpload.progress")} ${uploadDone}/${uploadTotal}`}
              {queuedCount > 0
                ? ` ${t("screens.wordInput.batchUpload.queued")} ${queuedCount}`
                : ""}
              {currentUploadFilename
                ? ` ${t("screens.wordInput.batchUpload.current")} ${currentUploadFilename}`
                : ""}
            </Typography.Text>
          )}

          {(uploadTotal > 0 || queuedCount > 0 || processedCount > 0) && (
            <Space wrap>
              <Button
                size="small"
                disabled={savingUpload || uploadTotal === 0}
                onClick={() => setUploadPaused((p) => !p)}
              >
                {uploadPaused
                  ? t("screens.wordInput.batchUpload.resume")
                  : t("screens.wordInput.batchUpload.pause")}
              </Button>
              <Button
                size="small"
                disabled={savingUpload || queuedCount === 0}
                onClick={() => {
                  uploadQueueRef.current = [];
                  setQueuedCount(0);
                  setUploadTotal(uploadDone);
                }}
              >
                {t("screens.wordInput.batchUpload.cancelRemaining")}
              </Button>
              <Checkbox
                checked={followLatest}
                disabled={savingUpload}
                onChange={(e) => setFollowLatest(e.target.checked)}
              >
                {t("screens.wordInput.batchUpload.followLatest")}
              </Checkbox>
            </Space>
          )}

          {(uploadTotal > 0 || queuedCount > 0 || processedCount > 0) && (
            <Space wrap>
              <Input
                size="small"
                value={uploadSearch}
                allowClear
                placeholder={t(
                  "screens.wordInput.batchUpload.searchPlaceholder",
                )}
                onChange={(e) => {
                  setUploadSearch(e.target.value);
                  setUploadSearchMessage(null);
                }}
                onPressEnter={() => {
                  const term = uploadSearch;
                  const found = findInProcessed(term, 0);
                  if (found >= 0) {
                    lastSearchIndexRef.current = found;
                    selectProcessedIndex(found);
                    setUploadSearchMessage(null);
                    return;
                  }
                  const moved = prioritizeInQueue(term);
                  if (moved) {
                    setUploadPaused(false);
                    setUploadSearchMessage(
                      t("screens.wordInput.batchUpload.movedToFront"),
                    );
                    return;
                  }
                  setUploadSearchMessage(
                    t("screens.wordInput.batchUpload.notFound"),
                  );
                }}
                style={{ width: 260 }}
              />
              <Button
                size="small"
                disabled={!uploadSearch.trim() || processedCount === 0}
                onClick={() => {
                  const term = uploadSearch;
                  const found = findInProcessed(term, 0);
                  if (found >= 0) {
                    lastSearchIndexRef.current = found;
                    selectProcessedIndex(found);
                    setUploadSearchMessage(null);
                  } else {
                    setUploadSearchMessage(
                      t("screens.wordInput.batchUpload.notFound"),
                    );
                  }
                }}
              >
                {t("screens.wordInput.batchUpload.find")}
              </Button>
              <Button
                size="small"
                disabled={!uploadSearch.trim() || processedCount === 0}
                onClick={() => {
                  const term = uploadSearch;
                  const start =
                    lastSearchIndexRef.current >= 0
                      ? lastSearchIndexRef.current + 1
                      : 0;
                  const found = findInProcessed(term, start);
                  if (found >= 0) {
                    lastSearchIndexRef.current = found;
                    selectProcessedIndex(found);
                    setUploadSearchMessage(null);
                  } else {
                    setUploadSearchMessage(
                      t("screens.wordInput.batchUpload.notFound"),
                    );
                  }
                }}
              >
                {t("screens.wordInput.batchUpload.nextMatch")}
              </Button>
              <Button
                size="small"
                disabled={!uploadSearch.trim() || queuedCount === 0}
                onClick={() => {
                  const moved = prioritizeInQueue(uploadSearch);
                  if (moved) {
                    setUploadPaused(false);
                    setUploadSearchMessage(
                      t("screens.wordInput.batchUpload.movedToFront"),
                    );
                  } else {
                    setUploadSearchMessage(
                      t("screens.wordInput.batchUpload.notFound"),
                    );
                  }
                }}
              >
                {t("screens.wordInput.batchUpload.prioritizeRemaining")}
              </Button>
              {uploadSearchMessage && (
                <Typography.Text type="secondary">
                  {uploadSearchMessage}
                </Typography.Text>
              )}
            </Space>
          )}

          {processedCount > 1 && (
            <Space wrap>
              <Button
                size="small"
                disabled={savingUpload || selectedUploadIndex <= 0}
                onClick={() => {
                  const nextIdx = Math.max(0, selectedUploadIndex - 1);
                  const item = processedRef.current[nextIdx];
                  if (!item) return;
                  setSelectedUploadIndex(nextIdx);
                  applyUploadedItemAsSelected(item, { persist: true });
                }}
              >
                {t("screens.wordInput.batchUpload.prev")}
              </Button>
              <Button
                size="small"
                disabled={
                  savingUpload || selectedUploadIndex >= processedCount - 1
                }
                onClick={() => {
                  const nextIdx = Math.min(
                    processedCount - 1,
                    selectedUploadIndex + 1,
                  );
                  const item = processedRef.current[nextIdx];
                  if (!item) return;
                  setSelectedUploadIndex(nextIdx);
                  applyUploadedItemAsSelected(item, { persist: true });
                }}
              >
                {t("screens.wordInput.batchUpload.next")}
              </Button>
              <Typography.Text type="secondary">
                {`${t("screens.wordInput.batchUpload.selected")} ${Math.min(
                  selectedUploadIndex + 1,
                  processedCount,
                )}/${processedCount}`}
              </Typography.Text>
              <InputNumber
                size="small"
                min={1}
                max={processedCount}
                value={Math.min(selectedUploadIndex + 1, processedCount)}
                onChange={(v) => {
                  const n = typeof v === "number" ? v : null;
                  if (!n) return;
                  const idx = n - 1;
                  const item = processedRef.current[idx];
                  if (!item) return;
                  setSelectedUploadIndex(idx);
                  applyUploadedItemAsSelected(item, { persist: true });
                }}
              />
              <Typography.Text type="secondary">
                {t("screens.wordInput.batchUpload.jumpHint")}
              </Typography.Text>
            </Space>
          )}

          {(audioFile || savedUploadedPath) && (
            <>
              <Typography.Text>
                {t("screens.wordInput.selectedFile")}
                {audioFile ? audioFile.name : (savedUploadedFilename ?? "")}
              </Typography.Text>
              <Typography.Text>
                {t("screens.wordInput.selectedLanguage")}
                {LANG_OPTIONS.find((o) => o.value === lang)?.label ?? ""}
              </Typography.Text>
              <Checkbox
                checked={useRecognition}
                onChange={async (e) => {
                  const next = e.target.checked;

                  // 手動入力に切り替える場合、認識結果があるなら入力欄に入れる（上書き確認あり）
                  if (!next) {
                    const rt = recognizedText.trim();
                    if (rt) {
                      if (!sentence.trim()) {
                        setSentence(rt);
                        const w = word.trim();
                        if (w) setManualTextWord(w);
                      } else if (sentence.trim() !== rt) {
                        const ok = await confirmOverwriteRecognizedText();
                        if (ok) {
                          setSentence(rt);
                          const w = word.trim();
                          if (w) setManualTextWord(w);
                        }
                      }
                    }
                  }

                  setUseRecognition(next);
                }}
              >
                {t("screens.wordInput.useRecognition")}
              </Checkbox>
              {t("screens.wordInput.manualTextLabel")}
              <Input
                type="value"
                value={sentence}
                placeholder={t("screens.wordInput.manualSentencePlaceholder")}
                onFocus={async () => {
                  if (useRecognition) return;

                  const prev = manualTextWord.trim();
                  const next = word.trim();

                  // 現在のワードが空なら判定できないので何もしない
                  if (!next) return;

                  // どのワードの手動テキストか不明(未紐づけ)なら、まず現在のワードに紐づけてから編集
                  if (!prev) {
                    setManualTextWord(next);
                    return;
                  }

                  // 手動テキストが空なら、現在のワードを紐づけるだけ
                  if (!sentence.trim()) {
                    if (prev !== next) setManualTextWord(next);
                    return;
                  }

                  // 前のワードと同じならそのまま編集
                  if (prev === next) return;
                  if (manualOverwritePromptedRef.current) return;

                  manualOverwritePromptedRef.current = true;
                  const ok = await confirmOverwriteManualText();
                  if (ok) {
                    setSentence("");
                    setManualTextWord(next);
                    try {
                      sessionStorage.setItem("falkoe.manualText", "");
                      sessionStorage.setItem("falkoe.manualTextWord", next);
                    } catch {}
                  }
                }}
                onChange={(e) => {
                  const v = e.target.value;
                  setSentence(v);

                  // 手動入力が始まったら、今のワードを紐づけとして記録
                  if (!useRecognition) {
                    const next = word.trim();
                    if (next) setManualTextWord(next);
                  }
                }}
                disabled={useRecognition}
                style={{ width: "100%" }}
              />
              <Button
                type="primary"
                onClick={async () => {
                  if (savedUploadedPath) {
                    // 手動入力モードでは、確定時に manifest.json の text/sentence_id を更新する
                    if (!useRecognition) {
                      const nextText = sentence.trim();
                      if (!nextText) {
                        warnManualNeedsText();
                        return;
                      }

                      const audioId = savedUploadedSentenceHash;
                      if (audioId) {
                        const res = await invoke<UpsertManifestTextResult>(
                          "upsert_sentence_manifest_text",
                          {
                            audioId,
                            lang,
                            text: nextText,
                            overwrite: false,
                          },
                        );

                        // アップロード音声（手動入力）では、ユーザーが望むなら manifest.json の text を上書きできる
                        if (res.status === "conflict") {
                          const prev = (res.previousText ?? "").trim();
                          const ok = await confirmOverwriteManifestText(
                            prev,
                            nextText,
                          );
                          if (!ok) return;

                          await invoke<UpsertManifestTextResult>(
                            "upsert_sentence_manifest_text",
                            {
                              audioId,
                              lang,
                              text: nextText,
                              overwrite: true,
                            },
                          );
                        }
                      }
                    }

                    onUseSpeech({
                      kind: "uploaded",
                      savedPath: savedUploadedPath,
                      originalFilename:
                        savedUploadedFilename ||
                        currentUploadFilename ||
                        savedUploadedPath.split(/[\\/]/).pop() ||
                        "uploaded",
                      sentenceHash: savedUploadedSentenceHash || undefined,
                      text: useRecognition ? undefined : sentence || undefined,
                      lang,
                    });
                  } else if (audioFile) {
                    // 念のため（保存が間に合ってない場合）
                    onUseSpeech({
                      kind: "uploaded",
                      file: audioFile,
                      originalFilename: audioFile.name,
                      sentenceHash: savedUploadedSentenceHash || undefined,
                      text: useRecognition ? undefined : sentence || undefined,
                      lang,
                    });
                  }
                }}
                disabled={savingUpload}
              >
                {t("screens.wordInput.practiceWithSentence")}
              </Button>
            </>
          )}
        </Space>
      )}
      {t("screens.wordInput.choosePracticeLanguage")}
      <Select
        value={lang}
        onChange={setLang}
        showSearch={{ filterOption: filterLangOption }}
        options={LANG_OPTIONS}
        style={{ width: 200 }}
      />
      {t("screens.wordInput.translateTo")}
      <Select
        value={translateTo}
        onChange={setTranslateTo}
        showSearch={{ filterOption: filterLangOption }}
        options={translateOptions}
        disabled={useSpeech}
        style={{ width: 200 }}
      />
      {t("screens.wordInput.chooseWordCount")}
      <Select
        value={wordcount}
        disabled={useSpeech}
        onChange={onWordcount}
        options={WORD_COUNT}
        style={{ width: 160 }}
      />
      <Input.Search
        value={word}
        disabled={useSpeech}
        onChange={(e) => onWordChange(e.target.value)}
        placeholder={t("screens.wordInput.wordPlaceholder")}
        enterButton={t("screens.wordInput.search")}
        onSearch={search}
      />
      {loading && <Spin />}
      {error && <Typography.Text type="danger">{error}</Typography.Text>}
      {!loading && !error && (
        <>
          {hasSearched && sentences.length === 0 ? (
            <Typography.Text type="secondary">
              {t("screens.wordInput.noResults")}
            </Typography.Text>
          ) : (
            <ExampleList
              disabled={useSpeech}
              sentences={sentences}
              onSelect={onSelect}
            />
          )}
        </>
      )}
    </Space>
  );
};

export default WordInputScreen;
