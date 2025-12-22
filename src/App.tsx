import { useState } from "react";
import WordInputScreen from "./screens/WordInputScreen";
import RecorderScreen from "./screens/RecorderScreen";
import { Sentence } from "./components/ExampleList";

const App = () => {
  const [screen, setScreen] = useState<"word" | "record">("word");
  const [lang, setLang] = useState<string>("eng");
  const [word, setWord] = useState("");
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [selected, setSelected] = useState<Sentence | null>(null);

  return (
    <>
      {screen === "word" && (
        <WordInputScreen
          lang={lang}
          setLang={setLang}
          word={word}
          sentences={sentences}
          onWordChange={setWord}
          onSearchResult={setSentences}
          onSelect={(s) => {
            setSelected(s);
            setScreen("record");
          }}
          onUseSpeech={(file) => {
            setSelected({
              id: -1,
              text: "（音声認識結果がここに入る予定）",
              audioUrl: URL.createObjectURL(file.file),
              lang: file.lang,
            });
            setScreen("record");
          }}
        />
      )}

      {screen === "record" && selected && (
        <RecorderScreen sentence={selected} onBack={() => setScreen("word")} />
      )}
    </>
  );
};

export default App;
