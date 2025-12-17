import { Input, Space, Typography, Spin } from "antd";
import { useState } from "react";
import ExampleList, { Sentence } from "../components/ExampleList";

type WordInputScreenProps = {
  word: string;
  sentences: Sentence[];
  onWordChange: (v: string) => void;
  onSearchResult: (s: Sentence[]) => void;
  onSelect: (s: Sentence) => void;
};

async function fetchExamples(word: string): Promise<Sentence[]> {
  const url =
    `https://api.tatoeba.org/unstable/sentences` +
    `?lang=eng` +
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
    audioUrl: `https://audio.tatoeba.org/sentences/eng/${s.id}.mp3`,
  }));
}

const WordInputScreen = ({
  word,
  sentences,
  onWordChange,
  onSearchResult,
  onSelect,
}: WordInputScreenProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!word.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchExamples(word.trim());
      onSearchResult(result);
    } catch {
      setError("例文の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Typography.Title level={4}>例文検索</Typography.Title>

      <Input.Search
        value={word}
        onChange={(e) => onWordChange(e.target.value)}
        placeholder="input word or phrase"
        enterButton="検索"
        onSearch={search}
      />

      {loading && <Spin />}
      {error && <Typography.Text type="danger">{error}</Typography.Text>}

      {!loading && !error && (
        <ExampleList sentences={sentences} onSelect={onSelect} />
      )}
    </Space>
  );
};

export default WordInputScreen;
