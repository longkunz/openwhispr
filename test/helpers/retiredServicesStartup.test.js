const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createEffectivePolicyManager } = require("../../src/helpers/effectivePolicyManager");

const main = fs.readFileSync(require.resolve("../../main"), "utf8");
const ipc = fs.readFileSync(require.resolve("../../src/helpers/ipcHandlers"), "utf8");

test("core startup keeps local notes and capture managers without assistant or detection services", () => {
  const source = main.slice(
    main.indexOf("function initializeCoreManagers()"),
    main.indexOf("function registerSidecars()")
  );
  const loaded = [];
  const constructed = [];
  const calls = [];
  const manager = () => ({
    hotkeyManager: {},
    getUiLanguage: () => "en",
    setActiveAccountId: (...args) => calls.push(args),
    ensureAccountDefaultFolders() {},
    setWindowManager() {},
  });
  const context = {
    process: { platform: "win32" },
    app: { on() {}, getLocale: () => "en", getPath: () => "fixture", getVersion: () => "1" },
    setupProductionPath() {},
    changeLanguage() {},
    cleanupOrphanedLinuxRestoreToken() {},
    syncAutoStartEntry() {},
    linuxSchemeHandler: null,
    meetingDetectionEngine: null,
    protocolRegistered: false,
    OAUTH_PROTOCOL: "fixture",
    trayManager: null,
    createManagedDevicePolicy: () => ({}),
    createManagedMeetingPolicy: () => ({}),
    createMeetingAuditLog: () => ({ recoverInterrupted() {} }),
    require(name) {
      loaded.push(name);
      if (name.endsWith("/debugLogger")) return { ensureFileLogging() {}, refreshLogLevel() {} };
      if (name.endsWith("/tokenStore")) return { get: () => "stored-token" };
      if (name.endsWith("/accountScopeBinding"))
        return {
          read: () => ({}),
          resolveBootAccountScope: () => "existing-local-owner",
        };
      throw new Error(`Unexpected startup dependency: ${name}`);
    },
  };
  for (const name of source.matchAll(/new (\w+)\(/g)) {
    const symbol = name[1];
    context[symbol] = class {
      constructor(options) {
        constructed.push(symbol);
        if (symbol === "IPCHandlers") context.registered = options;
        return manager();
      }
    };
  }
  vm.runInNewContext(`${source}\ninitializeCoreManagers();`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["existing-local-owner", { atLaunch: true }],
  ]);
  assert.equal(context.registered.meetingDetectionEngine, null);
  assert.ok(context.registered.audioTapManager);
  assert.ok(context.registered.windowsLoopbackAudioManager);
  assert.ok(context.registered.meetingAecManager);
  assert.ok(
    !constructed.some((name) =>
      /AgentWindow|MeetingDetection|MeetingProcess|AudioActivity/.test(name)
    )
  );
  assert.ok(
    !loaded.some((name) => /agentWindow|meetingDetection|meetingProcess|audioActivity/.test(name))
  );
});

test("policy refresh with a stored account stays on device and preserves its data scope", async () => {
  const target = {
    _retireDisallowedProductWork() {},
    databaseManager: { activeAccountId: "existing-local-owner" },
    managedDevicePolicy: {
      getSnapshot: () => ({ status: "absent", managed: false, policy: null }),
      subscribe: () => () => {},
    },
  };
  const source = ipc.slice(
    ipc.indexOf("    const getScope = () => ({"),
    ipc.indexOf("    const { createAudioFeaturePolicy }")
  );
  vm.runInNewContext(`(function () { ${source} }).call(target)`, {
    target,
    createEffectivePolicyManager,
    tokenStore: { getState: () => ({ token: "old-token", generation: 7 }) },
    broadcastToWindows() {},
  });
  for (let refresh = 0; refresh < 3; refresh++) {
    const policy = await target.refreshEffectivePolicy();
    assert.equal(policy.success, true);
    assert.equal(policy.accountId, "existing-local-owner");
    assert.equal(policy.workspaceRequired, false);
    assert.equal(policy.status, "unmanaged");
  }
  target.effectivePolicyManager.stop();
});

test("retired cloud discovery and dictation cleanup need no account service", async () => {
  const source = ipc.slice(
    ipc.indexOf("    const handleSttConfigRequest ="),
    ipc.indexOf(
      '    handleProduct("retry-transcription"',
      ipc.indexOf("    const handleSttConfigRequest =")
    )
  );
  const context = {};
  vm.runInNewContext(
    `${source}\nthis.stt = handleSttConfigRequest; this.notes = handleNoteRecordingConfigRequest;`,
    context
  );
  for (const handler of [context.stt, context.notes]) {
    const result = await handler();
    assert.equal(result.success, true);
    assert.equal(result.providers.length, 0);
  }
  const cleanup = ipc.slice(
    ipc.indexOf("    const getDictationCleanupSignal ="),
    ipc.indexOf("    const transcribeAssemblyAiDictation =")
  );
  vm.runInNewContext(`${cleanup}\nthis.cleanup = getDictationCleanupSignal;`, context);
  const take = new AbortController();
  assert.equal(await context.cleanup({}, take.signal), take.signal);
  take.abort();
  await assert.rejects(context.cleanup({}, take.signal), { name: "AbortError" });
});

test("retired sync entry points register no timers or window listeners", () => {
  const sync = fs.readFileSync(require.resolve("../../src/services/SyncService.ts"), "utf8");
  const source = sync
    .slice(
      sync.indexOf("  startAutoSync(): void {"),
      sync.indexOf("  private scheduleTeamSpacesRetry()")
    )
    .replaceAll(": void", "")
    .replaceAll("_open: boolean", "_open");
  const unexpected = () => {
    throw new Error("Unexpected background sync");
  };
  const context = {
    setInterval: unexpected,
    setTimeout: unexpected,
    window: { addEventListener: unexpected },
  };
  vm.runInNewContext(`this.service = new (class { ${source} })();`, context);
  context.service.requestSyncAll = unexpected;
  context.service.startAutoSync();
  context.service.startAutoSync();
  context.service.setNoteOpen(true);
  context.service.setNoteOpen(false);
});
