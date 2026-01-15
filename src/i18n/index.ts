import i18n, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import ja from "./ja.json";
import en from "./en.json";

export type UiLanguage = "en" | "ja";

const STORAGE_KEY = "falkoe.uiLanguage";

export function getStoredUiLanguage(): UiLanguage | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "en" || raw === "ja") return raw;
    return null;
  } catch {
    return null;
  }
}

export function setStoredUiLanguage(lang: UiLanguage): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
}

export function initI18n(initialLanguage?: UiLanguage): void {
  if (i18n.isInitialized) return;

  const resources: Resource = {
    en: { translation: en },
    ja: { translation: ja },
  };

  i18n
    .use(initReactI18next)
    .init({
      resources,
      lng: initialLanguage ?? "en",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
    })
    .catch(() => {
      // ignore
    });
}

export { i18n };
