import {
  Input,
  Space,
  Typography,
  Select,
  Checkbox,
  Button,
  Spin,
  Modal,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ExampleList, { Sentence } from "../components/ExampleList";
import AudioUpload from "../components/AudioUpload";
import { invoke } from "@tauri-apps/api/core";
import type { SpeechSource } from "../types/speech";
import { sha256Bytes } from "../utils/hash";
import TopNav from "../components/TopNav";

const LANG_OPTIONS = [
  { value: "eng", label: "English" },
  { value: "jpn", label: "Japanese" },
  { value: "spa", label: "Spanish" },
  { value: "fra", label: "French" },
  { value: "deu", label: "German" },
  { value: "ita", label: "Italian" },
  { value: "por", label: "Portuguese" },
  { value: "rus", label: "Russian" },
  { value: "kor", label: "Korean" },
  { value: "cmn", label: "Chinese (Mandarin)" },
  { value: "yue", label: "Chinese (Cantonese)" },
  { value: "ara", label: "Arabic" },
  { value: "hin", label: "Hindi" },
  { value: "tur", label: "Turkish" },
  { value: "vie", label: "Vietnamese" },
  { value: "tha", label: "Thai" },
  { value: "ind", label: "Indonesian" },
  { value: "ukr", label: "Ukrainian" },
  { value: "pol", label: "Polish" },
  { value: "nld", label: "Dutch" },
  { value: "swe", label: "Swedish" },
];

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
  onOpenSettings: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

type UploadedAudioInfo = {
  exists: boolean;
  path: string;
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
  translateTo: string | null
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

  const toSentencesFromSameLang = (data: any): Sentence[] => {
    if (!data || !Array.isArray(data.data)) return [];
    return data.data.map((s: any) => {
      let translation: string | null = null;
      if (showTransLang && Array.isArray(s.translations)) {
        const hit = s.translations.find((t: any) => {
          const lc = getLangCode(t?.lang);
          return lc === showTransLang;
        });
        if (hit && typeof hit.text === "string") {
          translation = hit.text;
        }
      }

      return {
        id: s.id,
        text: s.text,
        translation,
        audioUrl: `https://audio.tatoeba.org/sentences/${lang}/${s.id}.mp3`,
        lang,
      };
    });
  };

  // 1) 通常: `lang` の文を検索し、必要なら `translateTo` の翻訳を表示
  const primaryUrl =
    `https://api.tatoeba.org/unstable/sentences` +
    `?lang=${encodeURIComponent(lang)}` +
    `&q=${encodeURIComponent(word)}` +
    `&word_count=${encodeURIComponent(wordcount)}` +
    `&has_audio=yes` +
    `&sort=relevance` +
    (showTransLang
      ? `&showtrans:lang=${encodeURIComponent(showTransLang)}` +
        `&showtrans:is_direct=yes`
      : "");

  const primaryData = await fetchJson(primaryUrl);
  const primary = toSentencesFromSameLang(primaryData);
  if (primary.length > 0 || !showTransLang) {
    return primary;
  }

  // 2) フォールバック: 入力語が翻訳側言語(例: 日本語)の可能性が高い場合
  //    `showTransLang` 側で検索し、`lang` の翻訳（=表示・練習する言語）を結果として返す。
  //    例: showTransLang=jpn で q=「こんにちは」 -> lang=eng の例文を返す
  const fallbackUrl =
    `https://api.tatoeba.org/unstable/sentences` +
    `?lang=${encodeURIComponent(showTransLang)}` +
    `&q=${encodeURIComponent(word)}` +
    `&word_count=${encodeURIComponent(wordcount)}` +
    `&trans:lang=${encodeURIComponent(lang)}` +
    `&trans:is_direct=yes` +
    `&trans:has_audio=yes` +
    `&sort=words` +
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
      out.push({
        id: t.id,
        text: t.text,
        translation: sourceText || null,
        audioUrl: `https://audio.tatoeba.org/sentences/${lang}/${t.id}.mp3`,
        lang,
      });
      seen.add(t.id);
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
          "screens.wordInput.confirmOverwriteRecognizedText.cancel"
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
    next: string
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
    null
  );
  const [savedUploadedFilename, setSavedUploadedFilename] = useState<
    string | null
  >(null);
  const [savedUploadedSentenceHash, setSavedUploadedSentenceHash] = useState<
    string | null
  >(null);
  const [savingUpload, setSavingUpload] = useState(false);
  const [hydrated, setHydrated] = useState(false);
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
        translateTo
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
        onOpenHistory={onOpenHistory}
        onOpenIpaList={onOpenIpaList}
        onOpenSettings={onOpenSettings}
        onOpenDevelopersMistakes={onOpenDevelopersMistakes}
        onOpenCommonMistakes={onOpenCommonMistakes}
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
            onUpload={(f) => {
              setAudioFile(f);
              setSavedUploadedFilename(f.name);
              setSavedUploadedPath(null);

              const run = async () => {
                try {
                  setSavingUpload(true);
                  const arrayBuffer = await f.arrayBuffer();
                  const bytes = new Uint8Array(arrayBuffer);

                  // 保存先IDは常に audio_id (=音声バイト由来hash) に統一
                  const sentenceHash = await sha256Bytes(bytes, lang);

                  const info = await invoke<UploadedAudioInfo>(
                    "get_uploaded_audio_info",
                    {
                      sentenceHash,
                      originalFilename: f.name,
                    }
                  );

                  if (info.exists) {
                    const overwrite = await confirmOverwriteExisting();
                    if (!overwrite) {
                      // 既存ファイルをそのまま利用
                      setSavedUploadedPath(info.path);
                      setSavedUploadedSentenceHash(sentenceHash);
                      try {
                        sessionStorage.setItem(
                          "falkoe.uploadedSavedPath",
                          info.path
                        );
                        sessionStorage.setItem(
                          "falkoe.uploadedFilename",
                          f.name
                        );
                        sessionStorage.setItem(
                          "falkoe.uploadedSentenceHash",
                          sentenceHash
                        );
                        sessionStorage.setItem("falkoe.useSpeech", "true");
                        sessionStorage.setItem(
                          "falkoe.useRecognition",
                          String(useRecognition)
                        );
                        sessionStorage.setItem("falkoe.manualText", sentence);
                        sessionStorage.setItem("falkoe.lang", lang);
                      } catch {}
                      return;
                    }
                  }

                  const savedPath = await invoke<string>(
                    "save_uploaded_audio",
                    {
                      fileData: Array.from(bytes),
                      sentenceHash,
                      originalFilename: f.name,
                      overwrite: true,
                    }
                  );

                  setSavedUploadedPath(savedPath);
                  setSavedUploadedSentenceHash(sentenceHash);
                  try {
                    sessionStorage.setItem(
                      "falkoe.uploadedSavedPath",
                      savedPath
                    );
                    sessionStorage.setItem("falkoe.uploadedFilename", f.name);
                    sessionStorage.setItem(
                      "falkoe.uploadedSentenceHash",
                      sentenceHash
                    );
                    sessionStorage.setItem("falkoe.useSpeech", "true");
                    sessionStorage.setItem(
                      "falkoe.useRecognition",
                      String(useRecognition)
                    );
                    sessionStorage.setItem("falkoe.manualText", sentence);
                    sessionStorage.setItem("falkoe.lang", lang);
                  } catch {}
                } finally {
                  setSavingUpload(false);
                }
              };

              run();
            }}
          />

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
                          }
                        );

                        // アップロード音声（手動入力）では、ユーザーが望むなら manifest.json の text を上書きできる
                        if (res.status === "conflict") {
                          const prev = (res.previousText ?? "").trim();
                          const ok = await confirmOverwriteManifestText(
                            prev,
                            nextText
                          );
                          if (!ok) return;

                          await invoke<UpsertManifestTextResult>(
                            "upsert_sentence_manifest_text",
                            {
                              audioId,
                              lang,
                              text: nextText,
                              overwrite: true,
                            }
                          );
                        }
                      }
                    }

                    onUseSpeech({
                      kind: "uploaded",
                      savedPath: savedUploadedPath,
                      originalFilename: savedUploadedFilename || "uploaded",
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
