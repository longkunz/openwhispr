const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadStore(t, electronAPI) {
  installBrowserGlobals(t, {
    initialStorage: { voiceAgentKey: "F9", translationKey: "F10" },
    window: { electronAPI },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-registered-hotkey-setter-test-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  return vite.ssrLoadModule("/stores/settingsStore.ts");
}

test("an accepted assistant hotkey is saved", async (t) => {
  const { useSettingsStore } = await loadStore(t, {
    updateVoiceAgentHotkey: async () => ({ success: true }),
  });

  assert.deepEqual(await useSettingsStore.getState().setVoiceAgentKey("Alt+Space"), {
    success: true,
  });
  assert.equal(useSettingsStore.getState().voiceAgentKey, "Alt+Space");
  assert.equal(globalThis.localStorage.getItem("voiceAgentKey"), "Alt+Space");
});
