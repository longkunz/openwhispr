const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");
const {
  registerSelfHostedTranscriptionProxy,
} = require("../../src/helpers/selfHostedTranscriptionProxy");

test("Cancel in AudioManager closes the self-hosted HTTP response through preload IPC", async (t) => {
  const received = deferred();
  const closed = deferred();
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/v1/audio/transcriptions?token=abc");
    assert.equal(req.headers["x-api-key"], "secret");
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"text":"');
    res.on("close", () => closed.resolve());
    received.resolve();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-self-hosted-cancel-",
    settingsKey: "__selfHostedCancelSettings",
    settings: {
      useLocalWhisper: false,
      allowLocalFallback: false,
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: `http://127.0.0.1:${server.address().port}/v1?token=abc`,
      remoteTranscriptionModel: "whisper",
      cloudTranscriptionMode: "byok",
      preferredLanguage: "auto",
      customDictionary: [],
      snippets: [],
      selfHostedSttHeaders: { dictation: [{ name: "X-API-Key", value: "secret" }] },
    },
  });
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  registerSelfHostedTranscriptionProxy(ipcMain);
  const sender = new EventEmitter();
  // Exercise the real preload methods, with only Electron's IPC wire substituted.
  const fs = require("node:fs");
  const vm = require("node:vm");
  const preload = fs.readFileSync(require.resolve("../../preload.js"), "utf8");
  const start = preload.indexOf("  proxySelfHostedTranscription:");
  const end = preload.indexOf("  // Custom endpoint API keys", start);
  assert.ok(start >= 0 && end > start);
  Object.assign(
    loaded.window.electronAPI,
    vm.runInNewContext(`({${preload.slice(start, end)}})`, {
      ipcRenderer: {
        invoke: (name, data) => handlers.get(name)({ sender }, data),
        send: (name, id) => ipcMain.emit(name, { sender }, id),
      },
    })
  );
  const manager = loaded.createManager({
    isProcessing: true,
    _streamingCancellationGeneration: 0,
    getAPIKey: async () => "",
    shouldStreamTranscription: () => false,
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
  });
  const pending = manager.processWithOpenAIAPI(
    new Blob([new Uint8Array(1600)], { type: "audio/webm" })
  );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await received.promise;
  assert.equal(manager.cancelProcessing(), true);
  await rejected;
  await closed.promise;
  assert.equal(manager._activeTranscriptionAbortController, null);
});

test("batch processing uses its captured server instead of a stale streaming session", async (t) => {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-batch-snapshot-",
    settingsKey: "__batchSnapshotSettings",
    settings: {
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://changed.example/v1",
      remoteTranscriptionModel: "changed",
    },
  });
  const requests = [];
  loaded.window.electronAPI.proxySelfHostedTranscription = async (data) => {
    requests.push(data);
    return { ok: true, bodyText: '{"text":"Xin chào"}' };
  };
  const completed = [];
  const errors = [];
  const manager = loaded.createManager({
    isProcessing: true,
    _batchSelfHostedSettings: {
      remoteTranscriptionUrl: "https://original.example/v1",
      remoteTranscriptionModel: "vietasr",
      preferredLanguage: "vi",
      headers: [{ name: "X-API-Key", value: "original" }],
    },
    _activeVietAsrSettings: {
      remoteTranscriptionUrl: "https://stale-stream.example/v1",
    },
    processTranscription: async (text) => text,
    onTranscriptionComplete: (result) => completed.push(result),
    onError: (error) => errors.push(error),
    onStateChange() {},
  });
  await manager.processAudio(new Blob(["audio"], { type: "audio/webm" }));
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].endpoint, "https://original.example/v1/audio/transcriptions");
  assert.equal(requests[0].model, "vietasr");
  assert.equal(requests[0].headers["x-api-key"], "original");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].text, "Xin chào");
  assert.equal(completed[0].source, "self-hosted");
});
