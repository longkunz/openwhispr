// Run: node node_modules/electron/cli.js scripts/smoke-control-panel-release.cjs
// Isolated native-window/IPC smoke; fixture HTML is not an app RAM benchmark.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { app, BrowserWindow, ipcMain } = require("electron");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-panel-smoke-")));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app
  .whenReady()
  .then(async () => {
    const watchdog = setTimeout(() => {
      console.error("Control panel smoke timed out");
      app.exit(1);
    }, 15000);
    watchdog.unref();
    const WindowManager = require("../src/helpers/windowManager");
    require("../src/helpers/registryIpc").registerRegistryIpc(ipcMain, () => {});
    const { CONTROL_PANEL_CONFIG } = require("../src/helpers/windowConfig");
    const manager = new WindowManager();
    manager._onboardingActive = false;
    const hotkeys = manager.hotkeyManager;
    const float = new BrowserWindow({
      show: false,
      width: 96,
      height: 96,
      webPreferences: CONTROL_PANEL_CONFIG.webPreferences,
    });
    await float.loadURL("data:text/html,<title>Dictation fixture</title>");
    await float.webContents.executeJavaScript(`
    window.starts = 0;
    window.electronAPI.onStartDictation(() => window.starts++);
    void 0;
  `);
    manager.mainWindow = float;
    // Keep the smoke invisible; use the real dispatch and preload listener.
    manager.showDictationPanel = () => {};
    manager.loadControlPanel = async () => {
      await manager.controlPanelWindow.loadURL("data:text/html,<title>Notes fixture</title>");
      await manager.controlPanelWindow.webContents.executeJavaScript(`
      window.readyForRelease = false;
      window.electronAPI.onControlPanelReleaseRequested((requestId) => {
        window.electronAPI.controlPanelReleaseReady(requestId, window.readyForRelease);
      });
      void 0;
    `);
    };
    ipcMain.on("control-panel-release-ready", (event, id, ready) =>
      manager.completeControlPanelRelease(event.sender, id, ready)
    );
    await manager.createControlPanelWindow();
    const panel = manager.controlPanelWindow;
    const panelPid = panel.webContents.getOSProcessId();
    const floatPid = float.webContents.getOSProcessId();
    assert.notEqual(panelPid, floatPid);
    const before = app.getAppMetrics().find((metric) => metric.pid === panelPid);
    panel.close();
    await wait(100);
    assert.equal(panel.isDestroyed(), false, "busy panel stays resident");
    await panel.webContents.executeJavaScript("window.readyForRelease = true");
    const closed = once(panel, "closed");
    manager.hideControlPanelToTray();
    await closed;
    assert.equal(manager.controlPanelWindow, null);
    assert.equal(manager._onboardingActive, false);
    assert.equal(float.isDestroyed(), false);
    assert.equal(manager.hotkeyManager, hotkeys);
    manager.sendStartDictation();
    await wait(100);
    assert.equal(await float.webContents.executeJavaScript("window.starts"), 1);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!app.getAppMetrics().some((metric) => metric.pid === panelPid)) break;
      await wait(25);
    }
    assert.equal(
      app.getAppMetrics().some((metric) => metric.pid === panelPid),
      false
    );
    assert.equal(
      app.getAppMetrics().some((metric) => metric.pid === floatPid),
      true
    );
    await manager.createControlPanelWindow();
    assert.equal(manager.controlPanelWindow.isDestroyed(), false);
    assert.equal(manager._onboardingActive, false);
    manager._clearControlPanelVisibilityTimer();
    console.log(
      JSON.stringify({
        success: true,
        releasedRendererPid: panelPid,
        retainedFloatRendererPid: floatPid,
        fixtureRendererWorkingSetKB: before?.memory?.workingSetSize,
        reopened: true,
      })
    );
    clearTimeout(watchdog);
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
