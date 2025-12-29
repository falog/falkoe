import { useState } from "react";
import WordInputScreen from "./screens/WordInputScreen";
import RecorderScreen from "./screens/RecorderScreen";
import IpaListScreen from "./screens/IpaListScreen.tsx";
import DevelopersMistakeScreen from "./screens/DevelopersMistakeScreen.tsx";
import CommonMistakesScreen from "./screens/CommonMistakesScreen.tsx";
import { Sentence } from "./components/ExampleList";
import type { SpeechSource } from "./types/speech";
import type { MistakeFocus } from "./data/commonMistakes";

const App = () => {
  const [screen, setScreen] = useState<
    "word" | "record" | "ipa" | "mistake" | "common"
  >("word");
  const [mistakeFocus, setMistakeFocus] = useState<MistakeFocus | null>(null);
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
          onOpenIpaList={() => setScreen("ipa")}
          onOpenDevelopersMistake={() => {
            setMistakeFocus(null);
            setScreen("mistake");
          }}
          onOpenCommonMistakes={() => setScreen("common")}
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
        <RecorderScreen
          source={source}
          onBack={() => setScreen("word")}
          onOpenIpaList={() => setScreen("ipa")}
          onOpenDevelopersMistake={() => {
            setMistakeFocus(null);
            setScreen("mistake");
          }}
          onOpenCommonMistakes={() => setScreen("common")}
        />
      )}

      {screen === "ipa" && (
        <IpaListScreen
          onBack={() => setScreen("word")}
          onOpenDevelopersMistake={(focus) => {
            setMistakeFocus(focus ?? null);
            setScreen("mistake");
          }}
          onOpenCommonMistakes={() => setScreen("common")}
        />
      )}

      {screen === "mistake" && (
        <DevelopersMistakeScreen
          onBack={() => {
            setMistakeFocus(null);
            setScreen("word");
          }}
          onOpenIpaList={() => {
            setMistakeFocus(null);
            setScreen("ipa");
          }}
          onOpenCommonMistakes={() => {
            setMistakeFocus(null);
            setScreen("common");
          }}
          initialFocus={mistakeFocus ?? undefined}
        />
      )}

      {screen === "common" && (
        <CommonMistakesScreen
          onBack={() => setScreen("word")}
          onOpenIpaList={() => setScreen("ipa")}
          onOpenDevelopersMistake={() => {
            setMistakeFocus(null);
            setScreen("mistake");
          }}
          onOpenCommonMistakes={() => {
            // already here
          }}
        />
      )}
    </>
  );
};

export default App;
