const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// processWithOpenAIAPI classifies BYOK transcription failures from the throw
// shapes production sees: a renderer fetch Response or TypeError for direct
// providers, and the { error } fields main serialises for proxied ones.
async function loadManager(t, settings, window = {}, overrides = {}) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-provider-errors-test-",
    settingsKey: "__providerErrorsSettings",
    settings: { useLocalWhisper: false, allowLocalFallback: false, ...settings },
  });
  Object.assign(loaded.window.electronAPI, window);
  return loaded.createManager({
    isProcessing: true,
    _activeTranscriptionAbortController: null,
    getEffectiveSttLanguage: () => "auto",
    getAPIKey: async () => "test-key",
    getWhisperPrompt: () => null,
    getKeyterms: () => [],
    isDictionaryEcho: () => false,
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
    ...overrides,
  });
}

const selfHostedSettings = {
  cloudTranscriptionMode: "byok",
  // Self-hosted dictation leaves the provider setting at its default.
  cloudTranscriptionProvider: "openai",
  transcriptionMode: "self-hosted",
  remoteTranscriptionUrl: "https://stt.example.com/v1",
  remoteTranscriptionModel: "whisper-large-v3",
};

const recording = () => new Blob(["recording"], { type: "audio/webm" });

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected processWithOpenAIAPI to reject");
}

test("a self-hosted 404 blames the user's server, not OpenAI", async (t) => {
  const manager = await loadManager(t, selfHostedSettings);
  t.mock.method(globalThis, "fetch", async () => new Response("Not Found", { status: 404 }));

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.code, "PROVIDER_ERROR");
  assert.equal(error.messageKey, "providerErrors.selfHosted.unknown");
  assert.equal(error.message, "Your server returned an unexpected error.");
  assert.doesNotMatch(error.message, /OpenAI/);
});

// Self-hosted dictation sends no key unless the server is Orukeet (shouldSkipTranscriptionApiKey).
const noKey = { getAPIKey: async () => null };
const dictationHeaders = {
  selfHostedSttHeaders: {
    dictation: [{ name: "X-API-Key", value: "dictation-key" }],
    upload: [{ name: "X-API-Key", value: "upload-key" }],
  },
};

test("self-hosted dictation sends dictation's headers only, and only to the self-hosted server", async (t) => {
  const calls = [];
  const manager = await loadManager(t, { ...selfHostedSettings, ...dictationHeaders }, {}, noKey);
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({ text: "test" }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  await manager.processWithOpenAIAPI(recording());
  assert.equal(calls[0].redirect, "manual");
  assert.deepEqual(calls[0].headers, { "x-api-key": "dictation-key" });
});

test("self-hosted dictation with no effective custom headers keeps redirect follow", async (t) => {
  const manager = await loadManager(
    t,
    { ...selfHostedSettings, selfHostedSttHeaders: { dictation: [{ name: " ", value: "" }] } },
    {},
    noKey
  );
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.redirect, "follow");
    assert.deepEqual(init.headers, {});
    return new Response(JSON.stringify({ text: "test" }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  await manager.processWithOpenAIAPI(recording());
});

test("a redirect refused for custom headers is named, with a Settings link", async (t) => {
  const manager = await loadManager(t, { ...selfHostedSettings, ...dictationHeaders }, {}, noKey);
  // What Chromium's fetch returns for a redirect under redirect: "manual".
  t.mock.method(globalThis, "fetch", async () => ({ type: "opaqueredirect", status: 0 }));

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.code, "PROVIDER_REDIRECTED");
  assert.equal(error.messageKey, "providerErrors.selfHosted.redirected");
  assert.equal(error.settingsTarget, "speechToText");
});

test("an invalid custom header fails with a translated message and sends nothing", async (t) => {
  const manager = await loadManager(
    t,
    {
      ...selfHostedSettings,
      selfHostedSttHeaders: { dictation: [{ name: "X-API-Key: abc", value: "" }] },
    },
    {},
    noKey
  );
  t.mock.method(globalThis, "fetch", async () => assert.fail("nothing may be sent"));

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.code, "PROVIDER_INVALID_HEADERS");
  assert.equal(error.messageKey, "providerErrors.selfHosted.invalidHeaders");
  assert.equal(error.settingsTarget, "speechToText");
});
