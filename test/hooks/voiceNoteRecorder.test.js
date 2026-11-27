const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");
const { deferred } = require("../helpers/harness/deferred");

async function setup(t, url = "https://speech.example/v1?token=abc") {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const { window } = installBrowserGlobals(t);
  const container = installHookDom(t);
  installMicCaptureGlobals(t);
  const recorders = [];
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    constructor(stream) {
      this.stream = stream;
      this.state = "inactive";
      this.mimeType = "audio/webm";
      recorders.push(this);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio"]) });
      this.stopped = this.onstop?.();
    }
  }
  const originalRecorder = globalThis.MediaRecorder;
  globalThis.MediaRecorder = Recorder;
  t.after(() => {
    if (originalRecorder === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = originalRecorder;
  });
  const received = [];
  window.electronAPI.proxySelfHostedTranscription = async (data) => {
    received.push(data);
    return { ok: true, bodyText: '{"text":" hello "}' };
  };
  globalThis.__voiceNoteSettings = {
    remoteTranscriptionUrl: url,
    remoteTranscriptionModel: "whisper",
    preferredLanguage: "auto",
    selfHostedSttHeaders: { dictation: [] },
  };
  t.after(() => {
    delete globalThis.__voiceNoteSettings;
  });
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: key => key });",
      "/stores/settingsStore": "export const getSettings = () => globalThis.__voiceNoteSettings;",
      "/ui/useToast": "export const useToast = () => ({ toast() {} });",
    },
  });
  const { useVoiceNoteRecorder } = await vite.ssrLoadModule("/hooks/useVoiceNoteRecorder.ts");
  let hook;
  const transcribed = [];
  function Harness() {
    hook = useVoiceNoteRecorder((...args) => transcribed.push(args));
    return null;
  }
  root = createRoot(container);
  await React.act(async () =>
    root.render(React.createElement(React.StrictMode, null, React.createElement(Harness)))
  );
  return {
    get hook() {
      return hook;
    },
    root,
    recorders,
    received,
    transcribed,
    window,
    vite,
  };
}

test("panel release waits through mic permission, recording and transcription", async (t) => {
  const context = await setup(t);
  const { prepareControlPanelRelease } = await context.vite.ssrLoadModule(
    "/utils/controlPanelRelease.ts"
  );
  assert.equal(await prepareControlPanelRelease(), true);
  const permission = deferred();
  navigator.mediaDevices.getUserMedia = () => permission.promise;
  let start;
  await React.act(async () => {
    start = context.hook.startRecording(7);
  });
  assert.equal(await prepareControlPanelRelease(), false);
  await React.act(async () => {
    permission.resolve({ getTracks: () => [{ stop() {} }] });
    await start;
  });
  assert.equal(await prepareControlPanelRelease(), false);
  const transcription = deferred();
  context.window.electronAPI.proxySelfHostedTranscription = () => transcription.promise;
  await React.act(async () => context.hook.stopRecording());
  assert.equal(await prepareControlPanelRelease(), false);
  await React.act(async () => {
    transcription.resolve({ ok: true, bodyText: '{"text":"Saved words"}' });
    await context.recorders[0].stopped;
  });
  assert.equal(await prepareControlPanelRelease(), true);
  assert.deepEqual(context.transcribed, [[7, "Saved words"]]);
});

test("a mic permission result arriving after unmount releases its tracks without recording", async (t) => {
  const context = await setup(t);
  const permission = deferred();
  let stops = 0;
  navigator.mediaDevices.getUserMedia = () => permission.promise;
  let started;
  await React.act(async () => {
    started = context.hook.startRecording(7);
  });
  await React.act(async () => context.root.unmount());
  permission.resolve({ getTracks: () => [{ stop: () => stops++ }] });
  await started;
  assert.equal(stops, 1);
  assert.equal(context.recorders.length, 0);
  assert.equal(context.received.length, 0);
});

test("overlapping starts share one capture and query/full-endpoint URLs transcribe correctly", async (t) => {
  const context = await setup(t);
  let captures = 0;
  const getUserMedia = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = (...args) => {
    captures++;
    return getUserMedia(...args);
  };
  for (const url of [
    "https://speech.example/v1?token=abc",
    "https://speech.example/v1/audio/transcriptions?token=abc",
  ]) {
    globalThis.__voiceNoteSettings.remoteTranscriptionUrl = url;
    await React.act(async () => {
      await Promise.all([context.hook.startRecording(7), context.hook.startRecording(8)]);
    });
    assert.equal(context.hook.isRecording, true);
    await React.act(async () => {
      await context.hook.stopRecording();
      await context.recorders.at(-1).stopped;
    });
    assert.equal(
      context.received.at(-1).endpoint,
      "https://speech.example/v1/audio/transcriptions?token=abc"
    );
    assert.equal(context.hook.isProcessing, false);
  }
  assert.equal(captures, 2);
  assert.deepEqual(context.transcribed, [
    [7, "hello"],
    [7, "hello"],
  ]);
});

test("unmount during transcription cancels the proxy and ignores late text", async (t) => {
  const context = await setup(t);
  const response = deferred();
  const submitted = deferred();
  let cancelled;
  context.window.electronAPI.proxySelfHostedTranscription = (data) => {
    submitted.resolve(data);
    return response.promise;
  };
  context.window.electronAPI.cancelSelfHostedTranscription = (id) => {
    cancelled = id;
  };
  await React.act(async () => context.hook.startRecording(7));
  await React.act(async () => context.hook.stopRecording());
  const request = await submitted.promise;
  await React.act(async () => context.root.unmount());
  assert.equal(cancelled, request.requestId);
  response.resolve({ ok: true, bodyText: '{"text":"late"}' });
  await context.recorders[0].stopped;
  assert.deepEqual(context.transcribed, []);
});
