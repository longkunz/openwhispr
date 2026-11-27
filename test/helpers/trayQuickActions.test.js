const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadTrayWithStubs(request, parent, isMain) {
  if (request === "electron") return { Tray: class {}, Menu: {}, nativeImage: {}, app: {} };
  if (request === "./debugLogger") return { info: () => undefined, debug: () => undefined };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  return originalLoad.call(this, request, parent, isMain);
};
const TrayManager = require("../../src/helpers/tray");
Module._load = originalLoad;

function createTrayManager(calls, { dictating = false } = {}) {
  const trayManager = new TrayManager();
  trayManager.windowManager = {
    isDictationPanelVisible: () => false,
    isDictating: () => dictating,
    sendStartDictation: () => calls.push("start-dictation"),
    sendStopDictation: () => calls.push("stop-dictation"),
  };
  return trayManager;
}

test("the tray menu offers dictation without assistant or meeting recording", () => {
  const calls = [];
  const menu = createTrayManager(calls).buildContextMenuTemplate();
  const [listen, separator] = menu;

  assert.deepEqual([listen.label, separator.type], ["app.commandMenu.startListening", "separator"]);

  listen.click();
  assert.deepEqual(calls, ["start-dictation"]);
  assert.equal(
    menu.some((item) => item.label === "app.commandMenu.askAssistant"),
    false
  );
  assert.equal(
    menu.some((item) => item.label === "app.commandMenu.startMeetingRecording"),
    false
  );
});

test("the tray's listen item stops the recording it reflects", () => {
  const calls = [];
  const [listen] = createTrayManager(calls, { dictating: true }).buildContextMenuTemplate();

  assert.equal(listen.label, "app.commandMenu.stopListening");
  listen.click();
  assert.deepEqual(calls, ["stop-dictation"]);
});
