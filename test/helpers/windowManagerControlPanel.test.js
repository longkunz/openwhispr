const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
let browserWindowFactory;

const dockVisibilityCalls = [];
let workArea = { x: 0, y: 0, width: 1440, height: 900 };

const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      BrowserWindow: class {
        constructor() {
          return browserWindowFactory();
        }
      },
      screen: {
        getDisplayMatching: () => ({ workArea: { ...workArea } }),
      },
    };
  }
  if (request === "./debugLogger") return {};
  if (request === "./hotkeyManager") return class {};
  if (request === "./dragManager") return class {};
  if (request === "./menuManager") return { setupControlPanelMenu() {} };
  if (request === "./devServerManager") return {};
  if (request === "./dockManager") {
    return {
      setControlPanelVisible: (visible) => dockVisibilityCalls.push(visible),
    };
  }
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      NOTIFICATION_WINDOW_CONFIG: {},
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: {
        COMPACT: { width: 480, height: 624 },
        EXPANDED: { width: 1000, height: 740 },
        LOCAL_SETUP: { width: 1000, height: 880 },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

function createControlPanelWindow({
  visible,
  bounds = { x: 120, y: 90, width: 1200, height: 800 },
}) {
  const calls = [];
  const resizes = [];
  const minimumSizes = [];
  let currentBounds = { ...bounds };
  let isVisible = visible;
  let destroyed = false;

  return {
    calls,
    resizes,
    minimumSizes,
    isVisible: () => isVisible,
    window: Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      webContents: Object.assign(new EventEmitter(), {
        send: (...args) => calls.push(args),
      }),
      setTitle() {},
      destroy() {
        destroyed = true;
        calls.push("destroy");
        this.emit("closed");
      },
      isVisible: () => isVisible,
      isFullScreen: () => false,
      isMaximized: () => false,
      isMinimized: () => false,
      getBounds: () => ({ ...currentBounds }),
      getContentBounds: () => ({ ...currentBounds }),
      setContentBounds: (nextBounds, animate) => {
        currentBounds = { ...nextBounds };
        calls.push("setContentBounds");
        resizes.push({ bounds: { ...nextBounds }, animate });
      },
      isResizable: () => true,
      isMinimizable: () => true,
      isMaximizable: () => true,
      isClosable: () => true,
      isFullScreenable: () => true,
      getMinimumSize: () => [400, 300],
      setResizable: () => undefined,
      setMinimizable: () => undefined,
      setMaximizable: () => undefined,
      setClosable: () => undefined,
      setFullScreenable: () => undefined,
      setMinimumSize: (width, height) => minimumSizes.push([width, height]),
      setWindowButtonVisibility: () => undefined,
      show: () => {
        isVisible = true;
        calls.push("show");
      },
      focus: () => calls.push("focus"),
      hide: () => {
        isVisible = false;
        calls.push("hide");
      },
    }),
  };
}

function createManager(windowOptions) {
  const manager = new WindowManager();
  const fake = createControlPanelWindow(windowOptions);
  manager.controlPanelWindow = fake.window;
  return { manager, ...fake };
}

test.beforeEach(() => {
  dockVisibilityCalls.length = 0;
  workArea = { x: 0, y: 0, width: 1440, height: 900 };
});

test("closing an idle control panel releases its renderer only after the save acknowledgement", () => {
  const { manager, calls, window } = createManager({ visible: true });
  manager._onboardingActive = false;
  manager.hideControlPanelToTray();
  assert.equal(calls[0], "hide");
  const request = calls.find((entry) => Array.isArray(entry));
  assert.ok(request, "hidden panel must be asked to flush before releasing its renderer");
  assert.equal(request[0], "control-panel-release-requested");
  assert.equal(window.isDestroyed(), false);
  assert.equal(manager.completeControlPanelRelease(window.webContents, request[1], true), true);
  assert.equal(window.isDestroyed(), true);
  assert.equal(manager._onboardingActive, false);
});

test("busy, silent and foreign renderer replies never release a panel; showing it cancels a late reply", () => {
  const { manager, calls, window } = createManager({ visible: true });
  manager._onboardingActive = false;
  manager.hideControlPanelToTray();
  const requestId = calls.find(Array.isArray)[1];
  assert.equal(manager.completeControlPanelRelease({}, requestId, true), false);
  assert.equal(manager.completeControlPanelRelease(window.webContents, requestId, false), false);
  assert.equal(window.isDestroyed(), false);
  manager.showControlPanel();
  assert.equal(manager.completeControlPanelRelease(window.webContents, requestId, true), false);
  assert.equal(window.isDestroyed(), false);
});

test("releasing and recreating the real panel lifecycle preserves dictation and its hotkey gate", async (t) => {
  const manager = new WindowManager();
  manager._onboardingActive = false;
  const panels = [];
  browserWindowFactory = () => {
    const fake = createControlPanelWindow({ visible: false });
    panels.push(fake);
    return fake.window;
  };
  manager.registerExternalLinkHandlers = () => {};
  manager.loadControlPanel = async () =>
    manager.controlPanelWindow.webContents.emit("did-finish-load");
  t.after(() => {
    manager._cancelControlPanelRelease();
    manager._clearControlPanelVisibilityTimer();
  });
  const dictationCalls = [];
  const dictationWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel) => dictationCalls.push(channel) },
  };
  manager.mainWindow = dictationWindow;
  manager.hotkeyManager = { isInListeningMode: () => false };
  manager.showDictationPanel = () => dictationCalls.push("show-pill");
  await manager.createControlPanelWindow();
  const panel = manager.controlPanelWindow;
  panel.emit("close", { preventDefault() {} });
  const requestId = panels[0].calls.find(Array.isArray)[1];
  assert.equal(manager.completeControlPanelRelease(panel.webContents, requestId, true), true);
  assert.equal(manager.controlPanelWindow, null);
  assert.equal(manager.mainWindow, dictationWindow);
  manager.sendStartDictation();
  assert.deepEqual(dictationCalls, ["show-pill", "start-dictation"]);
  await manager.createControlPanelWindow();
  assert.notEqual(manager.controlPanelWindow, panel);
  assert.equal(manager._onboardingActive, false);
  assert.equal(panels.length, 2);
});

test("initial restore still reveals the renderer-sized control panel", () => {
  const { manager, calls, isVisible } = createManager({ visible: false });
  manager._controlPanelVisibilityTimer = 1;

  assert.equal(manager.setOnboardingWindowMode("restore"), true);

  assert.equal(isVisible(), true);
  assert.deepEqual(calls, ["show", "focus"]);
  assert.deepEqual(dockVisibilityCalls, [true]);
});

test("repeated restore preserves a control panel hidden to the tray", () => {
  const { manager, calls, isVisible } = createManager({ visible: true });
  manager._controlPanelVisibilityTimer = 1;
  manager.hideControlPanelToTray();
  calls.length = 0;
  dockVisibilityCalls.length = 0;

  assert.equal(manager.setOnboardingWindowMode("restore"), true);

  assert.equal(isVisible(), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(dockVisibilityCalls, []);
});

test("compact reauthentication can resize a tray-hidden panel without surfacing it", () => {
  const { manager, calls, isVisible } = createManager({ visible: true });
  manager._controlPanelVisibilityTimer = 1;
  manager.hideControlPanelToTray();
  calls.length = 0;
  dockVisibilityCalls.length = 0;

  assert.equal(manager.setOnboardingWindowMode("compact"), true);

  assert.equal(isVisible(), false);
  assert.deepEqual(calls, ["setContentBounds"]);
  assert.deepEqual(dockVisibilityCalls, []);
});

test("repeated compact resends keep a tray-hidden panel hidden", () => {
  // Already at the centered compact bounds, so no resize is needed.
  const { manager, calls, isVisible } = createManager({
    visible: true,
    bounds: { x: 480, y: 138, width: 480, height: 624 },
  });
  manager._controlPanelVisibilityTimer = 1;
  manager.hideControlPanelToTray();
  calls.length = 0;
  dockVisibilityCalls.length = 0;

  // First resend: bounds already match the target.
  assert.equal(manager.setOnboardingWindowMode("compact"), true);
  assert.equal(isVisible(), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(dockVisibilityCalls, []);

  // Second resend: the mode is already compact.
  assert.equal(manager.setOnboardingWindowMode("compact"), true);
  assert.equal(isVisible(), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(dockVisibilityCalls, []);
});

test("local setup grows the window smoothly to its own size and back", () => {
  const { manager, resizes, minimumSizes } = createManager({ visible: true });

  assert.equal(manager.setOnboardingWindowMode("expanded"), true);
  assert.equal(manager.setOnboardingWindowMode("local-setup"), true);
  assert.equal(manager.setOnboardingWindowMode("expanded"), true);

  // Each step keeps the window's centre, and every change animates on macOS.
  assert.deepEqual(resizes, [
    { bounds: { x: 220, y: 120, width: 1000, height: 740 }, animate: true },
    // Centred would put the top at y=50; the 900px work area holds it at y=20.
    { bounds: { x: 220, y: 20, width: 1000, height: 880 }, animate: true },
    { bounds: { x: 220, y: 90, width: 1000, height: 740 }, animate: true },
  ]);
  // The floor follows the step, so leaving local setup can shrink the window.
  assert.deepEqual(minimumSizes, [
    [1000, 740],
    [1000, 880],
    [1000, 740],
  ]);
});

test("local setup clamps to a short work area, where the step scrolls instead", () => {
  // Tall enough for the other steps' 740, too short for local setup's 880.
  workArea = { x: 0, y: 25, width: 1280, height: 800 };
  const { manager, resizes, minimumSizes } = createManager({
    visible: true,
    bounds: { x: 140, y: 55, width: 1000, height: 740 },
  });

  assert.equal(manager.setOnboardingWindowMode("local-setup"), true);

  assert.deepEqual(resizes, [
    { bounds: { x: 140, y: 25, width: 1000, height: 800 }, animate: true },
  ]);
  assert.deepEqual(minimumSizes, [[1000, 800]]);
});

test("restore after local setup returns the pre-onboarding bounds", () => {
  const { manager, resizes, minimumSizes } = createManager({ visible: true });

  assert.equal(manager.setOnboardingWindowMode("local-setup"), true);
  assert.equal(manager.setOnboardingWindowMode("restore"), true);

  assert.deepEqual(resizes.at(-1), {
    bounds: { x: 120, y: 90, width: 1200, height: 800 },
    animate: true,
  });
  // The control panel's own minimum size comes back with it.
  assert.deepEqual(minimumSizes.at(-1), [400, 300]);
});

test("an unknown onboarding window mode is refused without touching the window", () => {
  const { manager, calls, minimumSizes } = createManager({ visible: true });

  assert.equal(manager.setOnboardingWindowMode("local"), false);
  assert.equal(manager.setOnboardingWindowMode("LOCAL_SETUP"), false);

  assert.deepEqual(calls, []);
  assert.deepEqual(minimumSizes, []);
});
