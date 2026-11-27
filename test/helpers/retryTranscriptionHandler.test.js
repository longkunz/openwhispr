const { withDevicePolicy } = require("./harness/devicePolicy");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Captures every ipcMain.handle registration and every net.fetch request so the
// registered handler closures can be invoked directly against a fake `this`.
const handlers = new Map();
const eventHandlers = new Map();
const fetches = [];
let tinfoilBehavior = async () => ({ text: "tinfoil text", model: "tinfoil-model" });
let selfHostedHeaders = JSON.stringify({
  dictation: [{ name: "X-API-Key", value: "dictation-key" }],
  upload: [{ name: "X-API-Key", value: "upload-key" }],
});
let policySnapshot = { success: true, managed: false };
// A lookup that doesn't answer until the test lets it.
let policyLookupGate = null;
let accountWorkspaces = [];
const broadcasts = [];
let tokenState = { token: "test-token", generation: 1 };
let fetchResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ text: "transcribed" }),
  text: async () => JSON.stringify({ text: "transcribed" }),
});

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => eventHandlers.set(channel, fn),
    removeHandler: () => {},
  },
  net: {
    fetch: async (url, init) => {
      if (String(url).endsWith("/api/workspaces")) {
        return { ok: true, json: async () => ({ data: accountWorkspaces }) };
      }
      fetches.push({ url: String(url), init });
      return fetchResponse(String(url), init);
    },
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    // Cloud retries need a window to read auth from; a sender opts in with one.
    static fromWebContents(sender) {
      return sender?.window ?? null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: {
    fromPartition: () => ({
      webRequest: { onBeforeSendHeaders: () => {} },
      fetch: (url, init) => electronStub.net.fetch(url, init),
      closeAllConnections: async () => {},
    }),
  },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

// A 44-byte RIFF header is enough for isWavFormat, which only sniffs the magic.
const WAV_BUFFER = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(32),
]);
const CONVERTED_WAV = Buffer.concat([WAV_BUFFER, Buffer.from("converted")]);
// Just over the inline upload limit, so an OpenWhispr Cloud retry is chunked.
const CHUNKED_BUFFER = Buffer.alloc(4 * 1024 * 1024 + 1);

// Conversion is mocked rather than run: spawning ffmpeg from a unit test would
// make it slow and dependent on the runner having a usable binary.
const wavConversions = [];
let convertBehavior = async () => CONVERTED_WAV;
const prepareUploadBehavior = null;
let localReasoningBehavior = async () => "local output";
let localReasoningCancel = () => {};

// ffmpeg's segmenter, faked: writes `count` pieces of about a second of 128 kbps
// MP3 each where it is told (smaller ones read as a sliver and are dropped). A
// short upload is one piece, so OpenRouter upload tests written before chunking
// still make exactly one request.
const splitCalls = [];
const piecesOf = (count) => async (_inputPath, outputDir) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const chunkPaths = [];
  for (let i = 0; i < count; i++) {
    const piece = path.join(outputDir, `chunk-${String(i).padStart(3, "0")}.mp3`);
    fs.writeFileSync(piece, Buffer.alloc(16_000, i));
    chunkPaths.push(piece);
  }
  return { chunkPaths, durationSeconds: count * 240 };
};
let splitBehavior = piecesOf(1);

const cortiCalls = [];
const tinfoilCalls = [];
const textUpdates = [];
const statusUpdates = [];
let parakeetBehavior = async () => ({ success: true, text: "local text" });
let whisperBehavior = async () => ({ success: true, text: "whisper text" });
let cortiBehavior = async () => ({ text: "corti text" });

// Kept installed for the whole file: the corti client is require()d lazily at
// handler invocation time, not at module load.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "../services/localReasoningBridge")
      return {
        default: {
          processText: (...args) => localReasoningBehavior(...args),
          cancel: (id) => localReasoningCancel(id),
        },
      };
    if (request === "./providerUploadAudio") {
      const real = originalLoad.call(this, request, parent, isMain);
      return {
        ...real,
        prepareProviderUpload: (...args) =>
          prepareUploadBehavior
            ? prepareUploadBehavior(...args)
            : real.prepareProviderUpload(...args),
      };
    }
    if (request === "./cortiTranscription") {
      return {
        transcribeAudio: async (opts) => {
          cortiCalls.push(opts);
          return cortiBehavior(opts);
        },
      };
    }
    if (request === "./tinfoilTranscription") {
      return {
        transcribeWithTinfoil: async (opts) => {
          tinfoilCalls.push(opts);
          return tinfoilBehavior(opts);
        },
        getTinfoilChatModels: () => [],
      };
    }
    if (request === "./workspacePolicyManager")
      return {
        ...originalLoad.call(this, request, parent, isMain),
        createWorkspacePolicyManager: () => ({
          getPolicy: async ({ expectedAuthGeneration = tokenState.generation }) => {
            await policyLookupGate;
            return {
              ...policySnapshot,
              accountId: "account-a",
              authGeneration: expectedAuthGeneration,
            };
          },
          heldPolicy: () => null,
        }),
      };
    if (request === "./tokenStore") {
      return {
        ...originalLoad.call(this, request, parent, isMain),
        get: () => tokenState.token,
        getState: () => ({ ...tokenState }),
      };
    }
    if (request === "./accountScopeBinding")
      return {
        ...originalLoad.call(this, request, parent, isMain),
        resolveActiveAccountScope: ({ generation }) => ({
          accountId: "account-a",
          authGeneration: generation,
        }),
      };
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: (...args) => broadcasts.push(args) };
    }
    if (request === "./ffmpegUtils") {
      const real = originalLoad.call(this, request, parent, isMain);
      return {
        ...real,
        convertBufferToWav: async (buffer, options) => {
          wavConversions.push(buffer);
          return convertBehavior(buffer, options);
        },
        splitAudioFile: (inputPath, outputDir, options) => {
          splitCalls.push({ inputPath, outputDir, options });
          return splitBehavior(inputPath, outputDir, options);
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// A permissive `this` for setupHandlers: registration only stores closures, so
// any manager not exercised by the retry handler can be an inert stub.
function anything() {
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const dbRows = new Map([
    [7, { id: 7, audio_duration_ms: 1200 }],
    [8, { id: 8, audio_duration_ms: 1200 }],
    [9, { id: 9, audio_duration_ms: 1200 }],
  ]);
  const target = {
    sessionId: "test-session",
    _enterpriseAudioBinding: null,
    _enterpriseAudioOwner: null,
    _enterpriseAudioScope: null,
    _enterpriseAudioScopeRevision: 0,
    _uploadCancelRegistry:
      require("../../src/helpers/uploadCancelRegistry").createUploadCancelRegistry(),
    audioStorageManager: {
      // 7 is a stored WebM recording, 8 one already in WAV, 9 one too large to
      // upload inline.
      getAudioBuffer: (id) =>
        id === 7
          ? Buffer.from([1, 2, 3])
          : id === 8
            ? WAV_BUFFER
            : id === 9
              ? CHUNKED_BUFFER
              : null,
    },
    databaseManager: {
      activeAccountId: null,
      updateTranscriptionText: (id, text) => textUpdates.push({ id, text }),
      updateTranscriptionStatus: (id, status) => statusUpdates.push({ id, status }),
      updateTranscriptionAudio: () => {},
      getTranscriptionById: (id) => dbRows.get(id),
    },
    parakeetManager: {
      transcribeLocalParakeet: (buffer, options) => parakeetBehavior(buffer, options),
    },
    whisperManager: {
      serverManager: { isAvailable: () => true },
      transcribeLocalWhisper: (buffer, options) => whisperBehavior(buffer, options),
    },
    _resolveWhisperVadOptions: () => ({}),
    environmentManager: {
      getOpenAIKey: () => "sk-openai",
      getGroqKey: () => "gk-groq",
      getMistralKey: () => "mk-mistral",
      getXaiKey: () => "xk-xai",
      getTinfoilKey: () => "tk-tinfoil",
      getAssemblyAIKey: () => "aai-assemblyai",
      getElevenlabsKey: () => "xi-elevenlabs",
      getOpenrouterKey: () => "ork-openrouter",
      getCustomTranscriptionKey: () => "ck-custom",
      getSelfHostedSttHeaders: () => selfHostedHeaders,
      getCortiClientId: () => "corti-id",
      getCortiClientSecret: () => "corti-secret",
    },
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

let retryHandler;
let fakeThis;
test.before(async (t) => {
  const originalApiUrl = process.env.OPENWHISPR_API_URL;
  process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
  t.after(() => {
    if (originalApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = originalApiUrl;
  });
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  fakeThis = buildFakeThis();
  fakeThis._retireDisallowedProductWork =
    Ctor.prototype._retireDisallowedProductWork.bind(fakeThis);
  Ctor.prototype.setupHandlers.call(withDevicePolicy(fakeThis));
  await fakeThis.refreshEffectivePolicy();
  retryHandler = handlers.get("retry-transcription");
  assert.ok(retryHandler, "retry-transcription must be registered");
});

// Tests that switch the token restore an older generation afterwards, which a
// real token never does; the effective policy re-reads the restored identity.
test.beforeEach(() => fakeThis.refreshEffectivePolicy());

test.after(() => {
  Module._load = originalLoad;
});

const invoke = (settings, id = 7) => retryHandler({ sender: {} }, id, settings);

const fsNode = require("node:fs");
const osNode = require("node:os");
const pathNode = require("node:path");

const uploadTempFile = pathNode.join(osNode.tmpdir(), "openwhispr-upload-handler-test.webm");

const progressEvents = [];
const invokeUpload = (payload, bytes = Buffer.from([1, 2, 3, 4])) => {
  const uploadHandler = handlers.get("transcribe-audio-file-byok");
  assert.ok(uploadHandler, "transcribe-audio-file-byok must be registered");
  fsNode.writeFileSync(uploadTempFile, bytes);
  return uploadHandler(
    { sender: { send: (channel, data) => progressEvents.push({ channel, data }) } },
    { filePath: uploadTempFile, ...payload }
  );
};

test("upload: a self-hosted Azure endpoint keeps its deployment URL", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "",
    provider: "custom",
    language: "",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myorg.openai.azure.com",
    remoteTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(
    fetches[0].url,
    "https://myorg.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview"
  );
});

// Electron's net.fetch rejects with a plain Error whose message is the Chromium
// net error and no code; both BYOK handlers must classify it before replying.
async function withFetchRejecting(message, run) {
  const originalFetchResponse = fetchResponse;
  fetchResponse = () => {
    throw new Error(message);
  };
  try {
    return await run();
  } finally {
    fetchResponse = originalFetchResponse;
  }
}

test("retry: a self-hosted timeout names the user's server", async () => {
  const result = await withFetchRejecting("net::ERR_CONNECTION_TIMED_OUT", () =>
    invoke({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://stt.example.com/v1",
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionMode: "byok",
    })
  );
  assert.equal(result.code, "PROVIDER_TIMEOUT");
  assert.equal(result.messageKey, "providerErrors.selfHosted.timeout");
});

test("self-hosted Custom retries and uploads do not require BYOK permission", async (t) => {
  t.after(async () => {
    policySnapshot = { success: true, managed: false };
    await fakeThis.refreshEffectivePolicy();
  });
  const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
  policy.transcription.allowedModes = ["self-hosted"];
  policy.transcription.allowedByokProviders = [];
  policySnapshot = { success: true, managed: true, policy };
  await fakeThis.refreshEffectivePolicy();
  fetches.length = 0;
  const retry = await invoke(
    {
      transcriptionMode: "self-hosted",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://speech.example.test/v1",
      cloudTranscriptionModel: "speech",
    },
    8
  );
  assert.equal(retry.success, true);
  const upload = await invokeUpload({
    transcriptionMode: "self-hosted",
    provider: "custom",
    baseUrl: "https://speech.example.test/v1",
    model: "speech",
  });
  assert.equal(upload.success, true);
  assert.equal(fetches.length, 2);
});

const selfHostedRetry = {
  transcriptionMode: "self-hosted",
  remoteTranscriptionUrl: "http://127.0.0.1:8178/v1",
  remoteTranscriptionModel: "orukeet-v0.1.0",
  cloudTranscriptionProvider: "custom",
};
const selfHostedUpload = {
  ...selfHostedRetry,
  provider: "custom",
  apiKey: "",
  baseUrl: "",
  model: "",
  language: "",
};

async function withSelfHostedHeaders(value, run) {
  const previous = selfHostedHeaders;
  selfHostedHeaders = value;
  try {
    await run();
  } finally {
    selfHostedHeaders = previous;
  }
}

test("self-hosted retry sends dictation's headers and keeps Orukeet authentication", async () => {
  fetches.length = 0;
  assert.equal((await invoke(selfHostedRetry)).success, true);
  assert.equal(fetches[0].init.redirect, "error");
  assert.equal(fetches[0].init.headers["x-api-key"], "dictation-key");
  assert.equal(fetches[0].init.headers.authorization, "Bearer ck-custom");
  fetches.length = 0;
  assert.equal(
    (await invoke({ cloudTranscriptionMode: "byok", cloudTranscriptionProvider: "openai" }))
      .success,
    true
  );
  assert.equal(new Headers(fetches[0].init.headers).get("x-api-key"), null);
});

test("a self-hosted upload sends the Upload tab's headers, a voice draft dictation's", async () => {
  fetches.length = 0;
  assert.equal((await invokeUpload(selfHostedUpload)).success, true);
  assert.equal(fetches[0].init.redirect, "error");
  assert.equal(fetches[0].init.headers["x-api-key"], "upload-key");
  assert.equal(fetches[0].init.headers.authorization, "Bearer ck-custom");
  assert.match(fetches[0].init.headers["Content-Type"], /^multipart\/form-data; boundary=/);

  // A renderer's word alone does not make a file a voice draft.
  fetches.length = 0;
  assert.equal((await invokeUpload({ ...selfHostedUpload, purpose: "dictation" })).success, true);
  assert.equal(fetches[0].init.headers["x-api-key"], "upload-key");

  const draft = await handlers.get("save-temp-audio")({}, Buffer.from([1, 2, 3, 4]));
  try {
    fetches.length = 0;
    const result = await handlers.get("transcribe-audio-file-byok")(
      { sender: { send: () => {} } },
      { ...selfHostedUpload, filePath: draft.path, purpose: "dictation" }
    );
    assert.equal(result.success, true);
    assert.equal(fetches[0].init.headers["x-api-key"], "dictation-key");
  } finally {
    await handlers.get("delete-temp-audio")({}, draft.path);
  }
});

test("self-hosted retry and upload without effective custom headers keep redirect follow", async () => {
  await withSelfHostedHeaders(
    JSON.stringify({ dictation: [{ name: "", value: "" }], upload: [{ name: " ", value: "" }] }),
    async () => {
      const settings = { ...selfHostedRetry, remoteTranscriptionModel: "whisper-1" };
      fetches.length = 0;
      assert.equal((await invoke(settings)).success, true);
      assert.equal(fetches[0].init.redirect, "follow");
      assert.equal(new Headers(fetches[0].init.headers).has("authorization"), false);
      fetches.length = 0;
      assert.equal(
        (await invokeUpload({ ...selfHostedUpload, remoteTranscriptionModel: "whisper-1" }))
          .success,
        true
      );
      assert.equal(fetches[0].init.redirect, "follow");
    }
  );
});

test("a redirect refused for custom headers is named on retry and upload", async () => {
  const originalFetchResponse = fetchResponse;
  fetchResponse = () => {
    // Electron's net.fetch under redirect: "error".
    throw new Error("Attempted to redirect, but redirect policy was 'error'");
  };
  try {
    for (const result of [await invoke(selfHostedRetry), await invokeUpload(selfHostedUpload)]) {
      assert.equal(result.success, false);
      assert.equal(result.code, "PROVIDER_REDIRECTED");
      assert.equal(result.messageKey, "providerErrors.selfHosted.redirected");
      assert.equal(result.settingsTarget, "speechToText");
    }
  } finally {
    fetchResponse = originalFetchResponse;
  }
});
