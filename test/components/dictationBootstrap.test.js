const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  installBrowserGlobals,
  installHostDom,
  createRendererServer,
} = require("../lib/rendererTestHarness");

for (const panel of [false, true]) {
  test(
    panel
      ? "the panel boots its own lifecycle and remains available after splitting the float route"
      : "the default window boots dictation without loading panel or auth UI",
    async (t) => {
      let root;
      t.after(async () => {
        if (root) await React.act(async () => root.unmount());
      });
      const calls = [];
      globalThis.__dictationBootstrapCalls = calls;
      t.after(() => delete globalThis.__dictationBootstrapCalls);
      installBrowserGlobals(t, {
        window: {
          location: { search: panel ? "?panel=true" : "" },
          electronAPI: {
            getPlatform: () => "win32",
            setOnboardingWindowMode: async (mode) => calls.push(["window-mode", mode]),
            setOnboardingActive: async (active) => calls.push(["onboarding", active]),
            noteFilesSetEnabled: async (...args) => calls.push(["note-files", ...args]),
          },
        },
      });
      const container = installHostDom(t);
      const vite = await createRendererServer(t, {
        mockModules: {
          "react-i18next": `export const useTranslation = () => ({ t: key => key });`,
          "/App.jsx": `export default function App() { return "dictation-ready"; }`,
          ...(!panel
            ? { "/ControlPanelApp.jsx": `throw new Error("control panel must remain unloaded");` }
            : {}),
          "/components/ControlPanel": `export default function ControlPanel() { return "panel-ready"; }`,
          "/hooks/useControlPanelWindowDrag": `export function useControlPanelWindowDrag() {}`,
          "/hooks/useAuth": panel
            ? `export const useAuth = () => ({ isSignedIn: false, isLoaded: true });`
            : `throw new Error("auth UI must remain unloaded");`,
          "/hooks/useTheme": `export function useTheme() {}`,
          "/lib/accountScopeMirror": `export function mirrorActiveAccountScope() {
      globalThis.__dictationBootstrapCalls.push(["mirror"]); return () => {};
    }`,
          "/stores/policyStore": `export const usePolicyStore = selector => selector({ deviceReady: true, status: "unmanaged" });
      usePolicyStore.getState = () => ({ bootstrap: async () => {} });`,
          "/stores/settingsStore": `export const useSettingsStore = { getState: () => ({ noteFilesEnabled: false }) };`,
        },
      });
      const { default: AppRouter } = await vite.ssrLoadModule("/AppRouter.jsx");
      await vite.ssrLoadModule(panel ? "/ControlPanelApp.jsx" : "/DictationApp.jsx");
      const expected = panel ? "panel-ready" : "dictation-ready";
      root = createRoot(container);
      await React.act(async () => root.render(React.createElement(AppRouter)));
      for (let attempt = 0; attempt < 10 && !container.textContent.includes(expected); attempt++) {
        await React.act(() => new Promise((resolve) => setImmediate(resolve)));
      }
      assert.equal(container.textContent, expected);
      assert.ok(calls.some(([kind, active]) => kind === "onboarding" && active === false));
      assert.equal(
        calls.some(([kind]) => kind === "mirror"),
        !panel
      );
      assert.equal(
        calls.some(([kind]) => kind === "window-mode"),
        panel
      );
      assert.ok(calls.some(([kind]) => kind === "note-files"));
    }
  );
}
