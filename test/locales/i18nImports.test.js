const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("i18n still loads under a window stub that lacks localStorage", async (t) => {
  installBrowserGlobals(t, { window: { localStorage: undefined } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-i18n-import-test-",
  });

  const mod = await vite.ssrLoadModule("/i18n.ts");

  assert.equal(typeof mod.normalizeUiLanguage, "function");
  assert.ok(mod.SUPPORTED_UI_LANGUAGES.includes(mod.default.language));
});

test("legacy UI language migrates to English without changing Vietnamese speech recognition", async (t) => {
  installBrowserGlobals(t, { initialStorage: { uiLanguage: "ar", preferredLanguage: "vi" } });
  const vite = await createRendererServer(t);
  const { default: i18n, SUPPORTED_UI_LANGUAGES } = await vite.ssrLoadModule("/i18n.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  assert.deepEqual([...SUPPORTED_UI_LANGUAGES], ["en"]);
  assert.equal(i18n.language, "en");
  assert.equal(localStorage.getItem("uiLanguage"), "en");
  assert.equal(useSettingsStore.getState().preferredLanguage, "vi");
  assert.equal(localStorage.getItem("preferredLanguage"), "vi");
  assert.deepEqual(Object.keys(i18n.options.resources), ["en"]);
});
