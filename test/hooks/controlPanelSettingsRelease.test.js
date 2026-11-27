const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

async function mountSettings(t, saveHeaders) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        saveSelfHostedSttHeaders: saveHeaders,
        saveAllKeysToEnv: async () => ({ success: true }),
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-settings-release-" });
  // Load persistence first, as happens before Settings mounts in the app.
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useCredentialDraft } = await vite.ssrLoadModule("/hooks/useCredentialDraft.ts");
  const { prepareControlPanelRelease } = await vite.ssrLoadModule("/utils/controlPanelRelease.ts");
  let draft;
  function Harness() {
    draft = useCredentialDraft();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return {
    draft: () => draft,
    setHeaders: (headers) =>
      useSettingsStore.getState().setSelfHostedSttHeaders("dictation", headers),
    release: () => React.act(async () => prepareControlPanelRelease()),
    prepareControlPanelRelease,
  };
}

const headers = [{ name: "Authorization", value: "Bearer changed" }];

test("closing Settings flushes a header draft whose check is pending, then waits for IPC", async (t) => {
  const writes = [];
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const settings = await mountSettings(t, (value) => {
    writes.push(value);
    return gate;
  });
  const typed = JSON.stringify(headers);
  await React.act(async () =>
    settings.draft().change("headers", typed, (value) => {
      settings.setHeaders(JSON.parse(value));
    })
  );
  await React.act(async () =>
    settings.draft().follow({
      phase: "checking",
      checked: { headers: typed },
      refused: false,
    })
  );
  await React.act(async () => settings.draft().save());
  assert.equal(writes.length, 0);
  let released = false;
  const release = settings.prepareControlPanelRelease().then((ready) => {
    released = ready;
    return ready;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]).dictation, headers);
  assert.equal(released, false, "pending IPC must retain the renderer");
  finish({ success: true });
  assert.equal(await release, true);
  assert.equal(writes.length, 1);
});

test("a rejected secret save retains Settings and is retried on the next close", async (t) => {
  let success = false;
  const writes = [];
  const settings = await mountSettings(t, async (value) => {
    writes.push(value);
    return { success };
  });
  settings.setHeaders(headers);
  assert.equal(await settings.prepareControlPanelRelease(), false);
  success = true;
  assert.equal(await settings.prepareControlPanelRelease(), true);
  assert.equal(writes.length, 2);
});

test("a newer header edit waits behind its in-flight save and persists before release", async (t) => {
  const writes = [];
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const settings = await mountSettings(t, (value) => {
    writes.push(value);
    return writes.length === 1 ? gate : Promise.resolve({ success: true });
  });
  settings.setHeaders(headers);
  const release = settings.prepareControlPanelRelease();
  await new Promise((resolve) => setImmediate(resolve));
  const newer = [{ name: "Authorization", value: "Bearer newer" }];
  settings.setHeaders(newer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  finish({ success: true });
  assert.equal(await release, true);
  assert.deepEqual(JSON.parse(writes.at(-1)).dictation, newer);
  assert.equal(writes.length, 2);
});
