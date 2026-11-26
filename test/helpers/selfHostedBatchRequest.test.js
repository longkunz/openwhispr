const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { requestSelfHostedBatch } = require("../../src/helpers/selfHostedBatchRequest");
const {
  registerSelfHostedTranscriptionProxy,
} = require("../../src/helpers/selfHostedTranscriptionProxy");
const { deferred } = require("./harness/deferred");

function bridge(t) {
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (name, fn) => handlers.set(name, fn);
  registerSelfHostedTranscriptionProxy(ipc);
  const sender = new EventEmitter();
  const originalWindow = globalThis.window;
  globalThis.window = {
    electronAPI: {
      proxySelfHostedTranscription: (data) =>
        handlers.get("proxy-self-hosted-transcription")({ sender }, data),
      cancelSelfHostedTranscription: (id) =>
        ipc.emit("cancel-self-hosted-transcription", { sender }, id),
    },
  };
  t.after(() => {
    globalThis.window = originalWindow;
  });
  return { sender, ipc };
}

async function server(t, handle) {
  const instance = http.createServer(handle);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    instance.closeAllConnections();
    return new Promise((resolve) => instance.close(resolve));
  });
  return `http://127.0.0.1:${instance.address().port}/v1/audio/transcriptions`;
}

const audio = () => new Blob(["spoken audio"], { type: "audio/webm" });

test("batch proxy sends multipart credentials and preserves HTTP errors", async (t) => {
  bridge(t);
  let body = "";
  const endpoint = await server(t, (req, res) => {
    assert.equal(req.headers["x-api-key"], "secret");
    req.setEncoding("utf8");
    req.on("data", (data) => {
      body += data;
    });
    req.on("end", () => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"bad key"}');
    });
  });
  const response = await requestSelfHostedBatch({
    endpoint,
    audio: audio(),
    fileName: "note.webm",
    model: "whisper",
    language: "vi",
    prompt: "example",
    headers: { "X-API-Key": "secret" },
  });
  assert.equal(response.ok, false);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(await response.text(), '{"error":"bad key"}');
  for (const value of [
    'name="model"',
    "whisper",
    'name="language"',
    "vi",
    'name="prompt"',
    "example",
    "note.webm",
    "spoken audio",
  ])
    assert.ok(body.includes(value), value);
});

test("renderer cancellation aborts an in-flight response body in main, scoped to its sender", async (t) => {
  const { sender, ipc } = bridge(t);
  const received = deferred();
  const closed = deferred();
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"text":"');
    res.on("close", () => closed.resolve());
    received.resolve();
  });
  const controller = new AbortController();
  let requestId;
  const proxy = globalThis.window.electronAPI.proxySelfHostedTranscription;
  globalThis.window.electronAPI.proxySelfHostedTranscription = (data) => {
    requestId = data.requestId;
    return proxy(data);
  };
  const pending = requestSelfHostedBatch({
    endpoint,
    audio: audio(),
    fileName: "note.webm",
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await received.promise;
  ipc.emit("cancel-self-hosted-transcription", { sender: new EventEmitter() }, requestId);
  assert.equal(sender.listenerCount("destroyed"), 1);
  controller.abort();
  await rejected;
  await closed.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sender.listenerCount("destroyed"), 0);
});

test("closing the renderer aborts its request and releases listeners", async (t) => {
  const { sender } = bridge(t);
  const received = deferred();
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(200);
    res.write("{");
    received.resolve();
  });
  const pending = requestSelfHostedBatch({ endpoint, audio: audio(), fileName: "note.webm" });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await received.promise;
  sender.emit("destroyed");
  await rejected;
  assert.equal(sender.listenerCount("destroyed"), 0);
});

test("custom credentials never follow redirects through main or browser fallback", async (t) => {
  bridge(t);
  let leaked = 0;
  const destination = await server(t, (_req, res) => {
    leaked++;
    res.end("{}");
  });
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(302, { location: destination });
    res.end();
  });
  const options = {
    endpoint,
    audio: audio(),
    fileName: "note.webm",
    headers: { "X-API-Key": "secret" },
    redirect: "error",
  };
  assert.equal((await requestSelfHostedBatch(options)).type, "opaqueredirect");
  globalThis.window.electronAPI = {};
  assert.equal((await requestSelfHostedBatch(options)).status, 302);
  assert.equal(leaked, 0);
});

test("an already aborted batch never enters IPC", async (t) => {
  bridge(t);
  globalThis.window.electronAPI.proxySelfHostedTranscription = () =>
    assert.fail("must not send audio");
  await assert.rejects(
    requestSelfHostedBatch({
      endpoint: "http://localhost",
      audio: audio(),
      fileName: "note.webm",
      signal: AbortSignal.abort(),
    }),
    { name: "AbortError" }
  );
});
