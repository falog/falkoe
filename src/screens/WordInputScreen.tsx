import { Input, Space, Typography, Select, Checkbox, Button, Spin } from "antd";
import { useState } from "react";
import ExampleList, { Sentence } from "../components/ExampleList";
import AudioUpload from "../components/AudioUpload";

const LANG_OPTIONS = [
  { value: "eng", label: "English" },
  { value: "jpn", label: "Japanese" },
];

//const [lang, setLang] = useState<string>("eng");

type WordInputScreenProps = {
  lang: string;
  setLang: (lang: string) => void;
  word: string;
  sentences: Sentence[];
  onWordChange: (v: string) => void;
  onSearchResult: (s: Sentence[]) => void;
  onSelect: (s: Sentence) => void;
  onUseSpeech: (args: { file: File; lang: string }) => void;
};

async function fetchExamples(word: string, lang: string): Promise<Sentence[]> {
  const url =
    `https://api.tatoeba.org/unstable/sentences` +
    `?lang=${encodeURIComponent(lang)}` +
    `&q=${encodeURIComponent(word)}` +
    `&word_count=10-` +
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
  onWordChange,
  onSearchResult,
  onSelect,
  onUseSpeech,
}: WordInputScreenProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [useSpeech, setUseSpeech] = useState(false);

  const search = async () => {
    if (!word.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchExamples(word.trim(), lang);
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
      <Typography.Title level={4}>例文検索</Typography.Title>
      {/*<Checkbox
      <Checkbox
        checked={useSpeech}
        onChange={(e) => setUseSpeech(e.target.checked)}
      >
      
        音声認識を使う
      </Checkbox>
      */}
      {useSpeech && (
        <Space
          orientation="vertical"
          style={{ padding: 12, border: "1px dashed #ccc" }}
        >
          <AudioUpload onUpload={setAudioFile} />

          {audioFile && (
            <>
              <Typography.Text>選択中: {audioFile.name}</Typography.Text>
              <Typography.Text>
                選択言語：{LANG_OPTIONS.find((o) => o.value === lang)?.label}
              </Typography.Text>
              <Button
                type="primary"
                onClick={() => onUseSpeech({ file: audioFile, lang })}
              >
                この例文を表示する
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
      <Input.Search
        value={word}
        disabled={useSpeech}
        onChange={(e) => onWordChange(e.target.value)}
        placeholder="input word or phrase"
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
