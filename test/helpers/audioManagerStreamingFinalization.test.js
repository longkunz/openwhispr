const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

test("VietASR keeps its original endpoint, uses only acknowledged finals, and publishes once", async (t) => {
  const AudioManager = await loadManagerClass(t);
  installCapture(t);
  globalThis.window.dispatchEvent = () => true;
  for (const scenario of [
    "final",
    "silence",
    "dropped",
    "start-failed",
    "cancel-before-ready",
    "cancel-final",
  ]) {
    await t.test(scenario, async () => {
      globalThis.__streamingFinalizationSettings = {
        transcriptionMode: "self-hosted",
        vietAsrStreamingEnabled: true,
        remoteTranscriptionUrl: "http://127.0.0.1:8000/v1?token=original",
        remoteTranscriptionModel: "vietasr",
        preferredLanguage: "vi",
        selfHostedSttHeaders: { dictation: [{ name: "X-API-Key", value: "original" }] },
        cloudTranscriptionMode: "byok",
        useLocalWhisper: false,
      };
      let partial;
      let finishStart;
      let finishFinal;
      const started = new Promise((resolve) => {
        finishStart = resolve;
      });
      let startEntered = false;
      const provider = startingOrukeetProvider({
        onPartial: (listener) => {
          partial = listener;
          return () => {};
        },
        start: async () => {
          startEntered = true;
          if (scenario === "cancel-before-ready") return started;
          return { success: scenario !== "start-failed" };
        },
        finalize: async () => {
          if (scenario === "cancel-final")
            return new Promise((resolve) => {
              finishFinal = resolve;
            });
          return scenario === "dropped" || scenario === "start-failed"
            ? { success: false, error: "Connection closed" }
            : { success: true, text: scenario === "silence" ? "" : "Xin chào!" };
        },
        stop: async () => {
          finishStart({ success: false });
          finishFinal?.({ success: false });
          return { success: true, text: "unconfirmed stop text", model: "vietasr" };
        },
      });
      const { manager, completions, errors, uploads } = createStartingManager(AudioManager, {
        providerName: "vietasr",
        provider,
      });
      const batches = [];
      globalThis.window.electronAPI.proxySelfHostedTranscription = async (data) => {
        batches.push(data);
        return { ok: true, bodyText: '{"text":"Batch final"}' };
      };
      manager.processTranscription = async (text) => text;
      manager.finalizeChineseScript = async (text) => text;
      const start = manager.startStreamingRecording();
      if (scenario === "cancel-before-ready") {
        while (!startEntered) await new Promise(setImmediate);
        await manager.cancelStreamingRecording();
        await start;
        assert.deepEqual(completions, []);
        assert.deepEqual(batches, []);
        return;
      }
      assert.equal(await start, true, JSON.stringify(errors));
      partial("partial text must never be pasted");
      // Mutate both the URL and an existing header row while this recording is active.
      globalThis.__streamingFinalizationSettings.remoteTranscriptionUrl =
        "https://other.example/v1";
      globalThis.__streamingFinalizationSettings.selfHostedSttHeaders.dictation[0].value =
        "changed";
      const stop = manager.stopStreamingRecording();
      if (scenario === "cancel-final") {
        while (!finishFinal) await new Promise(setImmediate);
        assert.equal(manager.cancelProcessing(), true);
        await stop;
        assert.deepEqual(completions, []);
        assert.deepEqual(batches, []);
        return;
      }
      await Promise.all([stop, manager.stopStreamingRecording()]);
      assert.deepEqual(errors, []);
      assert.deepEqual(uploads, [], "no OpenWhispr Cloud fallback");
      if (scenario === "silence") {
        assert.deepEqual(completions, [{ success: true, text: "" }]);
        assert.deepEqual(batches, []);
      } else {
        assert.equal(completions.length, 1);
        assert.equal(completions[0].text, scenario === "final" ? "Xin chào!" : "Batch final");
        assert.equal(batches.length, scenario === "final" ? 0 : 1);
        if (batches.length) {
          assert.equal(
            batches[0].endpoint,
            "http://127.0.0.1:8000/v1/audio/transcriptions?token=original"
          );
          assert.equal(batches[0].headers["x-api-key"], "original");
        }
      }
    });
  }
});

async function loadManagerClass(t, mockModules) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-streaming-finalization-test-",
    settingsKey: "__streamingFinalizationSettings",
    settings: {
      useLocalWhisper: false,
      transcriptionMode: "providers",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openai",
    },
    mockModules,
  });
  return AudioManager;
}

// A capture pipeline whose fallback recorder holds "opening words" from the
// moment it starts, before any streaming session exists, and whose worklet
// answers "stop" with the flush sentinel like the real one.
function installCapture(t) {
  const previous = {
    AudioWorkletNode: globalThis.AudioWorkletNode,
    MediaRecorder: globalThis.MediaRecorder,
  };
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = {
        postMessage: (message) => {
          if (message === "stop") queueMicrotask(() => this.port.onmessage?.({ data: "flushed" }));
        },
      };
    }

    connect() {}
    disconnect() {}
  };
  globalThis.MediaRecorder = class {
    constructor() {
      this.state = "inactive";
      this.mimeType = "audio/webm";
    }

    start() {
      this.state = "recording";
      this.ondataavailable({ data: new Blob(["opening words"]) });
    }

    stop() {
      this.state = "inactive";
      queueMicrotask(() => this.onstop?.());
    }
  };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
}

function createStartingManager(AudioManager, { providerName, provider }) {
  const errors = [];
  const uploads = [];
  const completions = [];
  const stream = { getAudioTracks: () => [], getTracks: () => [{ stop() {} }] };
  const source = { connect() {}, disconnect() {} };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 0,
    _activeStreamingSessionId: null,
    _streamingMicSwapPromise: null,
    streamingCleanupFns: [],
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    streamingTextDebounce: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    preparedMicCapture: { take: async () => null },
    micRecovery: { stop() {} },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => stream,
    getOrCreateAudioContext: async () => ({
      createMediaStreamSource: () => source,
      createAnalyser: () => ({}),
      audioWorklet: { addModule: async () => {} },
    }),
    getWorkletBlobUrl: () => "",
    getStreamingProvider: () => provider,
    getStreamingProviderName: () => providerName,
    getEffectiveSttLanguage: () => "auto",
    getKeyterms: () => [],
    beginMicRecovery: async () => {},
    mergeRecordedSegments: async (segments) => segments[0] ?? null,
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {},
    shouldUseStreaming: () => false,
    _markCaptureStreamReleased() {},
    onStateChange() {},
    startRecording: async () => assert.fail("the microphone must not be reopened"),
    processWithOpenWhisprCloud: async (blob, metadata) => {
      uploads.push({ audio: await blob.text(), reason: metadata.streamingFallbackReason });
      return { text: "" };
    },
    onError: (error) => errors.push(error),
    onTranscriptionComplete: (result) => completions.push(result),
  });
  return { manager, errors, uploads, completions };
}

function startingOrukeetProvider(overrides = {}) {
  const sent = [];
  return {
    sent,
    onPartial: () => () => {},
    onFinal: () => () => {},
    onError: () => () => {},
    onSessionEnd: () => () => {},
    send: (pcm) => sent.push(pcm),
    start: async () => ({ success: true }),
    finalizeAcknowledged: true,
    // What main answers once the adapter is gone or failed.
    finalize: async () => ({ success: false, error: "No Orukeet recording is active" }),
    stop: async () => ({ success: true, text: "" }),
    ...overrides,
  };
}
