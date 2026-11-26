const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

async function setup(t, existingUpload = "") {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const browser = await installHappyDom(t);
  const state = {
    remoteTranscriptionUrl: "",
    remoteTranscriptionModel: "whisper",
    uploadRemoteTranscriptionUrl: existingUpload,
    uploadRemoteTranscriptionModel: "",
    meetingRemoteTranscriptionUrl: "",
    selfHostedSttHeaders: { dictation: [], upload: [{ name: "X-Upload", value: "existing" }] },
  };
  for (const field of [
    "remoteTranscriptionUrl",
    "remoteTranscriptionModel",
    "uploadRemoteTranscriptionUrl",
    "uploadRemoteTranscriptionModel",
    "meetingRemoteTranscriptionUrl",
  ]) {
    state[`set${field[0].toUpperCase()}${field.slice(1)}`] = (value) => {
      state[field] = value;
    };
  }
  state.setSelfHostedSttHeaders = (surface, headers) => {
    state.selfHostedSttHeaders[surface] = headers;
  };
  globalThis.__setupSettings = state;
  t.after(() => {
    delete globalThis.__setupSettings;
    delete globalThis.__setupPanel;
  });
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: key => key });",
      "/stores/settingsStore": "export const useSettingsStore = () => globalThis.__setupSettings;",
      "./icons": "export const Network = () => null;",
      "/SelfHostedPanel":
        "export default function Panel(props) { globalThis.__setupPanel = props; return null; }",
      "/ui/button":
        'import React from "react"; export const Button = props => React.createElement("button", props);',
      "/ui/dialog":
        "export const Dialog = ({children}) => children; export const DialogContent = Dialog, DialogDescription = Dialog, DialogFooter = Dialog, DialogHeader = Dialog, DialogTitle = Dialog;",
    },
  });
  const { SelfHostedSetupDialog } = await vite.ssrLoadModule(
    "/components/SelfHostedSetupDialog.tsx"
  );
  const container = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(container);
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(SelfHostedSetupDialog)));
  const headers = [{ name: "X-API-Key", value: "first-launch-secret" }];
  await React.act(async () => {
    globalThis.__setupPanel.onUrlChange("https://speech.example/v1");
    globalThis.__setupPanel.onHeadersChange(headers);
    root.render(React.createElement(SelfHostedSetupDialog));
  });
  await React.act(async () => {
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "common.continue"
    );
    assert.ok(save && !save.disabled);
    save.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
  });
  return { state, headers };
}

test("first-launch setup carries credentials to the newly initialized upload endpoint", async (t) => {
  const { state, headers } = await setup(t);
  assert.equal(state.uploadRemoteTranscriptionUrl, "https://speech.example/v1");
  assert.equal(state.uploadRemoteTranscriptionModel, "whisper");
  assert.deepEqual(state.selfHostedSttHeaders.upload, headers);
  state.selfHostedSttHeaders.upload[0].value = "changed upload secret";
  assert.equal(state.selfHostedSttHeaders.dictation[0].value, "first-launch-secret");
});

test("setup preserves a separately configured upload endpoint and its credentials", async (t) => {
  const { state } = await setup(t, "https://upload.example/v1");
  assert.equal(state.uploadRemoteTranscriptionUrl, "https://upload.example/v1");
  assert.deepEqual(state.selfHostedSttHeaders.upload, [{ name: "X-Upload", value: "existing" }]);
});
