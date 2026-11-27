const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter, once } = require("node:events");
const { WebSocketServer } = require("ws");
const { VietAsrStreaming } = require("../../src/helpers/vietAsrStreaming");

// Load the actual dictation handler closures without booting Electron's unrelated services.
function handlers() {
  const source = fs
    .readFileSync(require.resolve("../../src/helpers/ipcHandlers"), "utf8")
    .replace(/\r\n/g, "\n");
  const connect = source.slice(
    source.indexOf("    const setupDictationCallbacks ="),
    source.indexOf("    const streamingStartFailure =")
  );
  const lifecycle = source.slice(
    source.indexOf("    const streamingStartFailure ="),
    source.indexOf('    ipcMain.handle("dismiss-dictation-preview"')
  );
  assert.ok(connect.length > 0 && lifecycle.length > 0);
  const ipc = new EventEmitter();
  const invokes = new Map();
  ipc.handle = (name, fn) => invokes.set(name, fn);
  const target = {
    windowManager: { showTranscriptionPreview() {}, hideTranscriptionPreview() {} },
  };
  vm.runInNewContext(`(function () { ${connect}\n${lifecycle} }).call(target)`, {
    target,
    ipcMain: ipc,
    handleRemoteProduct: ipc.handle,
    VietAsrStreaming,
    OrukeetStreaming: class {},
    OpenAIRealtimeStreaming: class {},
    MANAGED_STREAM_OPTIONS: {},
    ownProductStream() {},
    retireStreaming: (stream) => stream.disconnect(),
    selfHostedRequest: () => ({ headers: { "X-API-Key": "ipc-secret" } }),
    credentialGeneration: 0,
    debugLogger: { debug() {}, error() {} },
    toPolicyFailure: (error) => ({ success: false, error: error.message }),
    Buffer,
    setTimeout,
    clearTimeout,
  });
  const sender = new EventEmitter();
  const messages = [];
  sender.send = (...args) => messages.push(args);
  const invoke = (name, ...args) => invokes.get(name)({ sender }, ...args);
  return { target, sender, messages, invokes, invoke, ipc };
}

async function server(t, onConnection) {
  const socketServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(socketServer, "listening");
  socketServer.on("connection", onConnection);
  t.after(async () => {
    for (const socket of socketServer.clients) socket.terminate();
    await new Promise((resolve) => socketServer.close(resolve));
  });
  return `http://127.0.0.1:${socketServer.address().port}/v1`;
}

test("VietASR dictation IPC sends credentials/PCM, forwards revised previews and finalizes", async (t) => {
  const context = handlers();
  const seen = [];
  const previews = [];
  context.target.windowManager.showTranscriptionPreview = (text) => previews.push(text);
  const baseUrl = await server(t, (socket, request) => {
    assert.equal(request.headers["x-api-key"], "ipc-secret");
    socket.send(JSON.stringify({ type: "ready", sample_rate: 16000, encoding: "pcm_s16le" }));
    socket.on("message", (data, binary) => {
      const message = binary ? Buffer.from(data) : JSON.parse(data.toString());
      seen.push(message);
      if (binary) {
        for (const text of ["xin chao", "xin chào", ""])
          socket.send(JSON.stringify({ type: "partial", text }));
      }
      if (message.type === "eof") socket.send(JSON.stringify({ type: "final", text: "Xin chào!" }));
    });
  });
  const options = {
    provider: "vietasr",
    mode: "byok",
    transcriptionMode: "self-hosted",
    baseUrl,
    preview: true,
  };
  assert.equal((await context.invoke("dictation-realtime-warmup", options)).success, true);
  assert.equal(
    context.target._dictationStreaming,
    undefined,
    "warmup does not open an unused CPU session"
  );
  assert.equal((await context.invoke("dictation-realtime-start", options)).success, true);
  const foreign = new EventEmitter();
  assert.equal(
    (await context.invokes.get("dictation-realtime-stop")({ sender: foreign })).success,
    false
  );
  context.ipc.emit("dictation-realtime-send", { sender: foreign }, Buffer.from([9, 0]));
  context.ipc.emit("dictation-realtime-send", { sender: context.sender }, Buffer.from([1, 0]));
  assert.equal((await context.invoke("dictation-realtime-finalize")).text, "Xin chào!");
  assert.equal((await context.invoke("dictation-realtime-stop")).text, "Xin chào!");
  assert.deepEqual(seen, [Buffer.from([1, 0]), { type: "eof" }]);
  assert.deepEqual(context.messages, [
    ["dictation-realtime-partial", "xin chao"],
    ["dictation-realtime-partial", "xin chào"],
    ["dictation-realtime-partial", ""],
    ["dictation-realtime-final", "Xin chào!"],
  ]);
  assert.deepEqual(previews, ["xin chao", "xin chào", ""]);
});

test("VietASR IPC cancellation settles a start awaiting ready", async (t) => {
  const context = handlers();
  let connected;
  const opened = new Promise((resolve) => {
    connected = resolve;
  });
  const baseUrl = await server(t, () => connected());
  const start = context.invoke("dictation-realtime-start", {
    provider: "vietasr",
    mode: "byok",
    transcriptionMode: "self-hosted",
    baseUrl,
  });
  await opened;
  assert.equal((await context.invoke("dictation-realtime-stop")).success, true);
  assert.equal((await start).success, false);
  assert.equal(context.target._dictationStreaming, null);
  assert.equal(context.sender.listenerCount("destroyed"), 1, "only the lifecycle watcher remains");
});
