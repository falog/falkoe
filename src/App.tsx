import { useEffect, useState, useRef, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import WordInputScreen from "./screens/WordInputScreen";
import RecorderScreen from "./screens/RecorderScreen";
import HistoryScreen from "./screens/HistoryScreen";
import IpaListScreen from "./screens/IpaListScreen.tsx";
import DevelopersMistakesScreen from "./screens/DevelopersMistakesScreen.tsx";
import CommonMistakesScreen from "./screens/CommonMistakesScreen.tsx";
import SettingsScreen from "./screens/SettingsScreen";
import LanguageSelectScreen from "./screens/LanguageSelectScreen";
import { Sentence } from "./components/ExampleList";
import AudioCutterScreen from "./screens/AudioCutterScreen";
import type { SpeechSource } from "./types/speech";
import type { MistakeFocus } from "./data/commonMistakes";
import { finishBackgroundTranscriptionByWavPath } from "./state/backgroundTranscription";
import { getStoredUiLanguage } from "./i18n";
import { sha256 } from "./utils/hash";

type FinalResultPayload = {
  wav_path: string;
};

const App = () => {
  const [screen, setScreen] = useState<
    | "language"
    | "word"
    | "record"
    | "history"
    | "ipa"
    | "mistakes"
    | "common"
    | "cutter"
    | "settings"
  >(() => (getStoredUiLanguage() ? "word" : "language"));
  const [screenBeforeSettings, setScreenBeforeSettings] =
    useState<
      Exclude<
        | "word"
        | "record"
        | "history"
        | "cutter"
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
  const selectingRef = useRef(false);

  const prefetchAndSelect = async (s: Sentence) => {
    if (selectingRef.current) return;
    selectingRef.current = true;
    try {
      // Pre-download Tatoeba audio so the recorder screen has it ready.
      // Try multiple candidate URLs — the legacy audio.tatoeba.org path
      // often 404s for non-English sentences.
      const hash = await sha256(s.text, s.lang);
      const candidates = Array.from(
        new Set(
          [
            s.audioUrl,
            s.attribution?.audioId
              ? `https://tatoeba.org/en/audio/download/${s.attribution.audioId}`
              : null,
            `https://audio.tatoeba.org/sentences/${s.lang}/${s.id}.mp3`,
          ].filter(
            (x): x is string => typeof x === "string" && x.trim().length > 0,
          ),
        ),
      );
      let cached = false;
      for (const url of candidates) {
        try {
          await invoke<string>("ensure_sentence_audio_cached", {
            audioId: hash,
            url,
          });
          cached = true;
          break;
        } catch {
          // try next candidate
        }
      }
      if (!cached) {
        // Non-fatal: recorder screen will retry if prefetch fails.
      }
      setSource({ kind: "tatoeba", sentence: s });
      setScreen("record");
    } finally {
      selectingRef.current = false;
    }
  };

  const openSettings = () => {
    const prev = screen;
    if (prev !== "settings" && prev !== "language") {
      setScreenBeforeSettings(prev);
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
      },
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const appShellStyle: CSSProperties = {
    width: "100%",
    minHeight: "100vh",
    boxSizing: "border-box",
    paddingTop: "max(env(safe-area-inset-top), 12px)",
    paddingRight: "max(env(safe-area-inset-right), 12px)",
    paddingBottom: "max(env(safe-area-inset-bottom), 12px)",
    paddingLeft: "max(env(safe-area-inset-left), 12px)",
  };

  return (
    <div style={appShellStyle}>
      {screen === "language" && (
        <LanguageSelectScreen
          onDone={() => {
            setScreen("word");
          }}
        />
      )}

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
          onOpenAudioCutter={() => setScreen("cutter")}
          onOpenSettings={openSettings}
          onOpenDevelopersMistakes={() => {
            setMistakeFocus(null);
            setScreen("mistakes");
          }}
          onOpenCommonMistakes={() => setScreen("common")}
          onSelect={(s) => {
            void prefetchAndSelect(s);
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
          onOpenAudioCutter={() => setScreen("cutter")}
          onOpenSettings={openSettings}
          onOpenDevelopersMistakes={() => {
            setMistakeFocus(null);
            setScreen("mistakes");
          }}
          onOpenCommonMistakes={() => setScreen("common")}
        />
      )}

      {screen === "cutter" && (
        <AudioCutterScreen
          lang={lang}
          setLang={setLang}
          onBack={() => setScreen("word")}
          onOpenHistory={() => setScreen("history")}
          onOpenIpaList={() => setScreen("ipa")}
          onOpenAudioCutter={() => {
            // already here
          }}
          onPracticeSentence={(speechSource) => {
            setSource(speechSource);
            setScreen("record");
          }}
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
          onOpenAudioCutter={() => setScreen("cutter")}
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
          onOpenAudioCutter={() => setScreen("cutter")}
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
          onOpenAudioCutter={() => setScreen("cutter")}
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
          onOpenAudioCutter={() => setScreen("cutter")}
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
          onOpenAudioCutter={() => setScreen("cutter")}
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
    </div>
  );
};

export default App;
