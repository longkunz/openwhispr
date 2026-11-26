const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { WebSocketServer } = require("ws");
const { VietAsrStreaming, vietAsrStreamingUrl } = require("../../src/helpers/vietAsrStreaming");

async function fixture(t, handler, { ready = true, timeoutMs = 2000 } = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const adapter = new VietAsrStreaming({ timeoutMs });
  const seen = [];
  server.on("connection", (socket, request) => {
    assert.equal(request.headers["x-api-key"], "test-secret");
    const url = new URL(request.url, "http://localhost");
    assert.equal(url.pathname, "/v1/stream");
    assert.equal(url.searchParams.get("pipeline"), "stream");
    if (ready)
      socket.send(JSON.stringify({ type: "ready", sample_rate: 16000, encoding: "pcm_s16le" }));
    socket.on("message", (data, binary) => {
      const message = binary ? Buffer.from(data) : JSON.parse(data.toString());
      seen.push(message);
      handler?.(socket, message);
    });
  });
  t.after(async () => {
    await adapter.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    adapter,
    server,
    seen,
    options: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      headers: { "X-API-Key": "test-secret" },
    },
  };
}

test("stream URL preserves gateway paths/query and fixes the VietASR wire format", () => {
  const url = new URL(
    vietAsrStreamingUrl(
      "https://speech.example/gateway/v1/audio/transcriptions?token=abc&pipeline=transcribe&modules=vad#ignore"
    )
  );
  assert.equal(url.pathname, "/gateway/v1/stream");
  assert.equal(url.protocol, "wss:");
  assert.equal(url.searchParams.get("token"), "abc");
  assert.equal(url.searchParams.get("pipeline"), "stream");
  assert.equal(url.searchParams.get("sample_rate"), "16000");
  assert.equal(url.searchParams.get("encoding"), "pcm_s16le");
  assert.equal(url.searchParams.has("modules"), false);
  assert.equal(url.hash, "");
  for (const base of [
    "http://public.example/v1",
    "https://user:password@speech.example/v1",
    "file:///tmp/v1",
  ])
    assert.throws(() => vietAsrStreamingUrl(base));
});

test("queued PCM precedes one EOF; cumulative partials are replaced and revised final wins", async (t) => {
  const { adapter, seen, options } = await fixture(t, (socket, message) => {
    if (Buffer.isBuffer(message)) {
      socket.send(JSON.stringify({ type: "partial", text: "xin" }));
      socket.send(JSON.stringify({ type: "partial", text: "xin chào" }));
    } else if (message.type === "eof") {
      socket.send(JSON.stringify({ type: "final", text: "Xin chào!", is_final: true }));
      socket.close();
    }
  });
  const partials = [];
  const finals = [];
  adapter.onPartialTranscript = (text) => partials.push(text);
  adapter.onFinalTranscript = (text) => finals.push(text);
  adapter.beginConnecting();
  adapter.sendAudio(Buffer.from([1, 0]));
  await adapter.connect(options);
  const first = adapter.finalize();
  assert.equal(adapter.finalize(), first);
  assert.equal((await first).text, "Xin chào!");
  assert.deepEqual(partials, ["xin", "xin chào"]);
  assert.deepEqual(finals, ["Xin chào!"]);
  assert.deepEqual(seen, [Buffer.from([1, 0]), { type: "eof" }]);
  assert.equal((await adapter.disconnect()).text, "Xin chào!");
});

test("an acknowledged empty final is valid silence", async (t) => {
  const { adapter, options } = await fixture(t, (socket, message) => {
    if (message.type === "eof")
      socket.send(JSON.stringify({ type: "final", text: "", is_final: true }));
  });
  await adapter.connect(options);
  assert.equal((await adapter.finalize()).text, "");
});

test("a socket closing after partial rejects final instead of returning provisional text", async (t) => {
  const { adapter, options } = await fixture(t, (socket, message) => {
    if (message.type === "eof") {
      socket.send(JSON.stringify({ type: "partial", text: "incomplete" }));
      socket.close();
    }
  });
  await adapter.connect(options);
  await assert.rejects(adapter.finalize(), /closed before final/);
  assert.equal((await adapter.disconnect()).text, "");
});

test("ready and final timeouts both release stalled sessions", async (t) => {
  const first = await fixture(t, null, { ready: false, timeoutMs: 30 });
  await assert.rejects(first.adapter.connect(first.options), /ready timed out/);
  const second = await fixture(t, null, { timeoutMs: 30 });
  await second.adapter.connect(second.options);
  await assert.rejects(second.adapter.finalize(), /final timed out/);
});

test("cancellation before ready rejects connect and never sends EOF", async (t) => {
  const { adapter, options, seen } = await fixture(t, null, { ready: false });
  const pending = adapter.connect(options);
  const rejected = assert.rejects(pending, /cancelled/);
  await adapter.disconnect();
  await rejected;
  assert.deepEqual(seen, []);
});

test("pre-connect audio is bounded and a failed session cannot later connect", async () => {
  const adapter = new VietAsrStreaming({ maxPendingBytes: 2 });
  adapter.sendAudio(Buffer.from([1, 0, 1, 0]));
  await assert.rejects(adapter.connect({ baseUrl: "http://localhost/v1" }), /buffer limit/);
  assert.equal(adapter.pendingBytes, 0);
});
