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
import ExampleList, { Sentence } from "../components/ExampleList";
import AudioUpload from "../components/AudioUpload";
import { invoke } from "@tauri-apps/api/core";
import type { SpeechSource } from "../types/speech";
import { sha256Bytes } from "../utils/hash";
import TopNav from "../components/TopNav";

const LANG_OPTIONS = [
  { value: "eng", label: "English" },
  { value: "jpn", label: "Japanese" },
];

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

function confirmOverwriteRecognizedText(): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: "認識結果で上書きしますか？",
      content:
        "音声認識の結果が既にあります。入力欄を認識結果で上書きしますか？",
      okText: "上書きする",
      cancelText: "上書きしない",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function confirmOverwriteManualText(
  prevWord: string,
  nextWord: string
): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: "テキストを上書きしますか？",
      content: `前のワード（${prevWord}）の手動入力テキストが残っています。現在のワード（${nextWord}）用に上書きしますか？`,
      okText: "上書きする",
      cancelText: "上書きしない",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

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

function confirmOverwriteManifestText(
  prev: string,
  next: string
): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: "manifest.jsonのテキストを上書きしますか？",
      content: (
        <div>
          <div style={{ marginBottom: 8 }}>
            既に保存済みのテキストがあります。manifest.json の text
            を上書きしますか？
          </div>
          <div>
            <Typography.Text strong>現在:</Typography.Text>
            <div style={{ whiteSpace: "pre-wrap" }}>{prev}</div>
          </div>
          <div style={{ marginTop: 8 }}>
            <Typography.Text strong>新しい入力:</Typography.Text>
            <div style={{ whiteSpace: "pre-wrap" }}>{next}</div>
          </div>
        </div>
      ),
      okText: "上書きする",
      cancelText: "上書きしない",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function warnManualNeedsText(): void {
  Modal.warning({
    title: "テキストを入力してください",
    content:
      "手動入力モードでは、テキストが空だとRecorder側で自動認識が走ってしまいます。テキストを入力するか、音声認識をONにしてください。",
    okText: "OK",
  });
}

async function fetchExamples(
  word: string,
  lang: string,
  wordcount: string
): Promise<Sentence[]> {
  const url =
    `https://api.tatoeba.org/unstable/sentences` +
    `?lang=${encodeURIComponent(lang)}` +
    `&q=${encodeURIComponent(word)}` +
    `&word_count=${encodeURIComponent(wordcount)}` +
    `&has_audio=yes` +
    `&sort=words`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("fetch failed");

  const data = await res.json();

  return data.data.map((s: any) => ({
    id: s.id,
    text: s.text,
    audioUrl: `https://audio.tatoeba.org/sentences/${lang}/${s.id}.mp3`,
    lang,
  }));
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
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: WordInputScreenProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

      if (sp) setSavedUploadedPath(sp);
      if (fn) setSavedUploadedFilename(fn);
      if (sh) setSavedUploadedSentenceHash(sh);
      if (us) setUseSpeech(us === "true");
      if (ur) setUseRecognition(ur === "true");
      if (txt) setSentence(txt);
      if (rt) setRecognizedText(rt);
      if (mtw) setManualTextWord(mtw);
      if (lg) setLang(lg);
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
    } catch {}
  }, [hydrated, sentence, manualTextWord, useSpeech, useRecognition, lang]);

  // ワードが変わったら、次回フォーカス時に再度確認できるようにする
  useEffect(() => {
    manualOverwritePromptedRef.current = false;
  }, [word]);

  const search = async () => {
    if (!word.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchExamples(word.trim(), lang, wordcount);
      onSearchResult(result);
      console.log("result:", result.length);
    } catch (e) {
      console.error(e);
      setError("例文の取得に失敗しました");
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
        onOpenDevelopersMistakes={onOpenDevelopersMistakes}
        onOpenCommonMistakes={onOpenCommonMistakes}
      />
      <Typography.Title level={4}>例文検索</Typography.Title>
      <Checkbox
        checked={useSpeech}
        onChange={(e) => setUseSpeech(e.target.checked)}
      >
        音声ファイルを選択して例文を取得する
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
                選択中: {audioFile ? audioFile.name : savedUploadedFilename}
              </Typography.Text>
              <Typography.Text>
                選択言語：{LANG_OPTIONS.find((o) => o.value === lang)?.label}
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
                音声認識を使用する（自動入力）
              </Checkbox>
              テキストを手動入力：
              <Input
                type="value"
                value={sentence}
                placeholder="Input sentence manually"
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
                  const ok = await confirmOverwriteManualText(prev, next);
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
                この例文を使って練習
              </Button>
            </>
          )}
        </Space>
      )}
      練習する言語を選択してください：
      <Select
        value={lang}
        onChange={setLang}
        options={LANG_OPTIONS}
        style={{ width: 160 }}
      />
      ワード数を選択してください：
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
        placeholder="Input word or phrase"
        enterButton="検索"
        onSearch={search}
      />
      {loading && <Spin />}
      {error && <Typography.Text type="danger">{error}</Typography.Text>}
      {!loading && !error && (
        <ExampleList
          disabled={useSpeech}
          sentences={sentences}
          onSelect={onSelect}
        />
      )}
    </Space>
  );
};

export default WordInputScreen;
