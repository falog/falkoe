import { useState } from "react";
import WordInputScreen from "./screens/WordInputScreen";
import RecorderScreen from "./screens/RecorderScreen";
import { Sentence } from "./components/ExampleList";

const App = () => {
  const [screen, setScreen] = useState<"word" | "record">("word");
  const [word, setWord] = useState("");
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [selected, setSelected] = useState<Sentence | null>(null);

  return (
    <>
      {screen === "word" && (
        <WordInputScreen
          word={word}
          sentences={sentences}
          onWordChange={setWord}
          onSearchResult={setSentences}
          onSelect={(s) => {
            setSelected(s);
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
