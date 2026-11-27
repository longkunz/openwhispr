import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { PROMPTS_BY_LOCALE } from "./locales/prompts";
import { TRANSLATIONS_BY_LOCALE } from "./locales/translations";

export const SUPPORTED_UI_LANGUAGES = ["en"] as const;
export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number];

export function normalizeUiLanguage(_language?: string | null): UiLanguage {
  return "en";
}

// Retire saved UI locales without touching the independent speech-language setting.
if (typeof window !== "undefined") {
  const saved = window.localStorage?.getItem("uiLanguage");
  if (saved && saved !== "en") window.localStorage.setItem("uiLanguage", "en");
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: TRANSLATIONS_BY_LOCALE.en, prompts: PROMPTS_BY_LOCALE.en },
  },
  lng: "en",
  supportedLngs: ["en"],
  fallbackLng: "en",
  ns: ["translation", "prompts"],
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnEmptyString: true,
  returnNull: false,
});

export default i18n;
