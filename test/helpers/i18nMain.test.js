const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeUiLanguage,
  changeLanguage,
  i18nMain,
  SUPPORTED_UI_LANGUAGES,
} = require("../../src/helpers/i18nMain");

test("main UI supports only English, including legacy saved preferences", () => {
  assert.deepEqual(SUPPORTED_UI_LANGUAGES, ["en"]);
  for (const locale of ["en-US", "ar", "de-DE", "zh-Hant-TW", "vi", "", undefined]) {
    assert.equal(normalizeUiLanguage(locale), "en");
    assert.equal(changeLanguage(locale), "en");
  }
  assert.equal(i18nMain.language, "en");
  assert.deepEqual(Object.keys(i18nMain.options.resources), ["en"]);
});
