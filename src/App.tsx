import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import WordInputScreen from "./screens/WordInputScreen";
import RecorderScreen from "./screens/RecorderScreen";
import HistoryScreen from "./screens/HistoryScreen";
import IpaListScreen from "./screens/IpaListScreen.tsx";
import DevelopersMistakesScreen from "./screens/DevelopersMistakesScreen.tsx";
import CommonMistakesScreen from "./screens/CommonMistakesScreen.tsx";
import SettingsScreen from "./screens/SettingsScreen";
import { Sentence } from "./components/ExampleList";
import type { SpeechSource } from "./types/speech";
import type { MistakeFocus } from "./data/commonMistakes";
import { finishBackgroundTranscriptionByWavPath } from "./state/backgroundTranscription";

type FinalResultPayload = {
  wav_path: string;
};

const App = () => {
  const [screen, setScreen] = useState<
    "word" | "record" | "history" | "ipa" | "mistakes" | "common" | "settings"
  >("word");
  const [screenBeforeSettings, setScreenBeforeSettings] =
    useState<
      Exclude<
        | "word"
        | "record"
        | "history"
        | "ipa"
        | "mistakes"
        | "common"
        | "settings",
        "settings"
      >
    >("word");
  const [mistakeFocus, setMistakeFocus] = useState<MistakeFocus | null>(null);
  const [lang, setLang] = useState("eng");
  const [word, setWord] = useState("");
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [wordcount, setWordcount] = useState("5-");
  const [source, setSource] = useState<SpeechSource | null>(null);

  const openSettings = () => {
    if (screen !== "settings") {
      setScreenBeforeSettings(screen);
    }
    setScreen("settings");
  };

  useEffect(() => {
    const unlistenPromise = listen<FinalResultPayload>(
      "transcript-final",
      (e) => {
        const wavPath = e.payload?.wav_path;
        if (typeof wavPath === "string" && wavPath) {
          finishBackgroundTranscriptionByWavPath(wavPath);
        }
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

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
          onOpenHistory={() => setScreen("history")}
          onOpenSettings={openSettings}
          onOpenDevelopersMistakes={() => {
            setMistakeFocus(null);
            setScreen("mistakes");
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
          onOpenHistory={() => setScreen("history")}
          onOpenSettings={openSettings}
          onOpenDevelopersMistakes={() => {
            setMistakeFocus(null);
            setScreen("mistakes");
          }}
          onOpenCommonMistakes={() => setScreen("common")}
        />
      )}

      {screen === "history" && (
        <HistoryScreen
          onBack={() => setScreen("word")}
          onOpenIpaList={() => setScreen("ipa")}
          onOpenHistory={() => {
            // already here
          }}
          onOpenSettings={openSettings}
          onOpenDevelopersMistakes={() => {
            setMistakeFocus(null);
            setScreen("mistakes");
          }}
          onOpenCommonMistakes={() => setScreen("common")}
          onOpenFromHistory={(speechSource) => {
            setSource(speechSource);
            setScreen("record");
          }}
        />
      )}

      {screen === "ipa" && (
        <IpaListScreen
          onBack={() => setScreen("word")}
          onOpenHistory={() => setScreen("history")}
          onOpenDevelopersMistakes={(focus) => {
            setMistakeFocus(focus ?? null);
            setScreen("mistakes");
          }}
          onOpenSettings={openSettings}
          onOpenCommonMistakes={() => setScreen("common")}
        />
      )}

      {screen === "mistakes" && (
        <DevelopersMistakesScreen
          onBack={() => {
            setMistakeFocus(null);
            setScreen("word");
          }}
          onOpenHistory={() => setScreen("history")}
          onOpenIpaList={() => {
            setMistakeFocus(null);
            setScreen("ipa");
          }}
          onOpenSettings={openSettings}
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
          onOpenHistory={() => setScreen("history")}
          onOpenIpaList={() => setScreen("ipa")}
          onOpenSettings={openSettings}
          onOpenDevelopersMistakes={() => {
            setMistakeFocus(null);
            setScreen("mistakes");
          }}
          onOpenCommonMistakes={() => {
            // already here
          }}
        />
      )}

      {screen === "settings" && (
        <SettingsScreen
          onBack={() => setScreen(screenBeforeSettings)}
          onOpenHistory={() => setScreen("history")}
          onOpenIpaList={() => setScreen("ipa")}
          onOpenDevelopersMistakes={() => {
            setMistakeFocus(null);
            setScreen("mistakes");
          }}
          onOpenCommonMistakes={() => setScreen("common")}
          onOpenSettings={() => {
            // already here
          }}
        />
      )}
    </>
  );
};

export default App;
