const i18next = require("i18next");
const enTranslation = require("../locales/en/translation.json");
const enPrompts = require("../locales/en/prompts.json");
const SUPPORTED_UI_LANGUAGES = ["en"];

function normalizeUiLanguage(_language) {
  return "en";
}

const i18nMain = i18next.createInstance();
void i18nMain.init({
  resources: { en: { translation: enTranslation, prompts: enPrompts } },
  lng: "en",
  supportedLngs: ["en"],
  fallbackLng: "en",
  ns: ["translation", "prompts"],
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  returnNull: false,
});

function changeLanguage(language) {
  const normalized = normalizeUiLanguage(language);

  if (i18nMain.language !== normalized) {
    void i18nMain.changeLanguage(normalized);
  }

  return normalized;
}

module.exports = {
  i18nMain,
  changeLanguage,
  normalizeUiLanguage,
  SUPPORTED_UI_LANGUAGES,
};
