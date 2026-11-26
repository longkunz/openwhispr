const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { isVietAsrStreaming } = require("../../src/helpers/selfHostedTranscription");
const {
  resolveStreamingProviderName,
  buildStreamingSessionOptions,
  isCloudMeteredStream,
} = require("../../src/helpers/dictationStreamingRouting");
const { productOperationAllowed } = require("../../src/helpers/productPolicy");
const { defaultDevicePolicy } = require("../../src/helpers/managedDevicePolicy");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const settings = {
  transcriptionMode: "self-hosted",
  remoteTranscriptionUrl: "http://localhost:8000/v1",
  vietAsrStreamingEnabled: true,
  showTranscriptionPreview: true,
};

test("VietASR is an explicit dictation opt-in with no account or key requirement", async (t) => {
  assert.equal(isVietAsrStreaming(settings), true);
  for (const override of [
    { vietAsrStreamingEnabled: false },
    { transcriptionMode: "providers" },
    { remoteTranscriptionUrl: " " },
  ])
    assert.equal(isVietAsrStreaming({ ...settings, ...override }), false);
  assert.equal(resolveStreamingProviderName({ settings, context: "dictation" }), "vietasr");
  assert.notEqual(resolveStreamingProviderName({ settings, context: "notes" }), "vietasr");
  const options = buildStreamingSessionOptions({
    providerName: "vietasr",
    settings,
    language: "auto",
  });
  assert.equal(options.mode, "byok");
  assert.equal(options.baseUrl, settings.remoteTranscriptionUrl);
  assert.equal(options.preview, true);
  assert.equal(options.transcriptionMode, "self-hosted");
  assert.equal(isCloudMeteredStream({ provider: "vietasr", mode: "openwhispr" }), false);
  const loaded = await loadAudioManager(t, { settingsKey: "__vietAsrSettings", settings });
  assert.equal(loaded.createManager().shouldUseStreaming(), true);
  loaded.setSettings({ ...settings, vietAsrStreamingEnabled: false });
  assert.equal(loaded.createManager().shouldUseStreaming(), false);
});

test("VietASR main policy uses self-hosted permissions rather than the provider allowlist", () => {
  const policy = defaultDevicePolicy();
  policy.transcription.allowedModes = ["self-hosted"];
  const snapshot = { success: true, managed: true, policy };
  const options = { provider: "vietasr", mode: "byok", transcriptionMode: "self-hosted" };
  assert.equal(
    productOperationAllowed(snapshot, "1.12.2", "dictation-realtime-start", [options]),
    true
  );
  policy.transcription.allowedModes = ["local"];
  assert.equal(
    productOperationAllowed(snapshot, "1.12.2", "dictation-realtime-start", [options]),
    false
  );
});

test("VietASR opt-in persists and storage events remain boolean across windows", async (t) => {
  const listeners = new Map();
  const { storage } = installBrowserGlobals(t, {
    window: {
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
  });
  const vite = await createRendererServer(t);
  const { useSettingsStore, initializeSettings } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  await initializeSettings();
  const defaults = useSettingsStore.getState();
  assert.equal(defaults.remoteTranscriptionUrl, "https://stt.gehihi.dev/v1");
  assert.equal(defaults.remoteTranscriptionModel, "vietasr");
  assert.equal(defaults.meetingRemoteTranscriptionUrl, "https://stt.gehihi.dev/v1");
  assert.equal(defaults.uploadRemoteTranscriptionUrl, "https://stt.gehihi.dev/v1");
  assert.equal(defaults.uploadRemoteTranscriptionModel, "vietasr");
  assert.equal(useSettingsStore.getState().vietAsrStreamingEnabled, false);
  useSettingsStore.getState().setVietAsrStreamingEnabled(true);
  assert.equal(storage.getItem("vietAsrStreamingEnabled"), "true");
  listeners.get("storage")({
    key: "vietAsrStreamingEnabled",
    newValue: "false",
    storageArea: storage,
  });
  assert.equal(useSettingsStore.getState().vietAsrStreamingEnabled, false);
});

test("saved self-hosted endpoints and model names take precedence over defaults", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      remoteTranscriptionUrl: "https://dictation.example/v1",
      remoteTranscriptionModel: "custom-dictation",
      meetingRemoteTranscriptionUrl: "https://meeting.example/v1",
      meetingFollowsTranscription: "false",
      uploadRemoteTranscriptionUrl: "https://upload.example/v1",
      uploadRemoteTranscriptionModel: "custom-upload",
      uploadSelfHostedMigrated: "true",
    },
  });
  const vite = await createRendererServer(t);
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();
  assert.equal(state.remoteTranscriptionUrl, "https://dictation.example/v1");
  assert.equal(state.remoteTranscriptionModel, "custom-dictation");
  assert.equal(state.meetingRemoteTranscriptionUrl, "https://meeting.example/v1");
  assert.equal(state.uploadRemoteTranscriptionUrl, "https://upload.example/v1");
  assert.equal(state.uploadRemoteTranscriptionModel, "custom-upload");
});
