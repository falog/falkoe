import { useState } from "react";
import WordInputScreen from "./screens/WordInputScreen";
import RecorderScreen from "./screens/RecorderScreen";
import { Sentence } from "./components/ExampleList";
import type { SpeechSource } from "./types/speech";

const App = () => {
  const [screen, setScreen] = useState<"word" | "record">("word");
  const [lang, setLang] = useState("eng");
  const [word, setWord] = useState("");
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [wordcount, setWordcount] = useState("5-");
  const [source, setSource] = useState<SpeechSource | null>(null);

  return (
    <>
      {screen === "word" && (
        <WordInputScreen
          lang={lang}
          setLang={setLang}
          word={word}
          sentences={sentences}
          wordcount={wordcount}
          onWordChange={setWord}
          onSearchResult={setSentences}
          onWordcount={setWordcount}
          onSelect={(s) => {
            setSource({
              kind: "tatoeba",
              sentence: s,
            });
            setScreen("record");
          }}
          onUseSpeech={(speechSource) => {
            setSource(speechSource);
            setScreen("record");
          }}
        />
      )}

      {screen === "record" && source && (
        <RecorderScreen source={source} onBack={() => setScreen("word")} />
      )}
    </>
  );
};

export default App;
