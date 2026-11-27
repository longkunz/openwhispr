const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// Exercise the real router, app entry points and startup lifecycle. Retired
// account and guided-onboarding modules must never load on a normal launch.
async function createRouterHarness(t, initialStorage = {}, search = "?panel=true") {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const calls = { noteFiles: [], active: [], modes: [], accessibility: [] };
  const { storage } = installBrowserGlobals(t, {
    initialStorage,
    window: {
      location: { search },
      electronAPI: {
        noteFilesSetEnabled: (...args) => {
          calls.noteFiles.push(args);
          return Promise.resolve({ success: true });
        },
        setOnboardingActive: (...args) => calls.active.push(args),
        setOnboardingWindowMode: (...args) => calls.modes.push(args),
        markMacAccessibilityFeaturesReady: (...args) => calls.accessibility.push(args),
      },
    },
  });
  const container = installHostDom(t);
  const policy = {
    deviceReady: true,
    status: "unmanaged",
    localOnly: false,
    requireSignIn: false,
    workspaceRequired: false,
    accountId: null,
  };
  globalThis.__startupPolicy = policy;
  t.after(() => delete globalThis.__startupPolicy);
  const vite = await createRendererServer(t, {
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/App.jsx": 'export default function App() { return "dictation"; }',
      "/components/ControlPanel":
        'export default function ControlPanel() { return "control-panel"; }',
      "/components/MeetingNotificationOverlay.tsx":
        'export default function MeetingNotificationOverlay() { return "meeting-notification"; }',
      "/components/onboarding/PermissionGuideOverlay":
        'export function PermissionGuideOverlay() { return "permission-guide"; }',
      "/components/agent/AgentWindow.tsx":
        'export default function AgentWindow() { return "agent-window"; }',
      "/hooks/useControlPanelWindowDrag": "export function useControlPanelWindowDrag() {}",
      "/hooks/useTheme": "export function useTheme() {}",
      "/lib/accountScopeMirror": "export function mirrorActiveAccountScope() {}",
      "/stores/policyStore": `
        export const usePolicyStore = (selector) => selector(globalThis.__startupPolicy);
        usePolicyStore.getState = () => ({ bootstrap: async () => {} });
      `,
      "/stores/settingsStore": `
        export const useSettingsStore = { getState: () => ({
          noteFilesEnabled: localStorage.getItem("noteFilesEnabled") === "true",
          noteFilesPath: localStorage.getItem("noteFilesPath") ?? "",
        }) };
      `,
      "/lib/auth": 'throw new Error("Retired account client loaded");',
      "/services/SyncService.js": 'throw new Error("Retired cloud sync loaded");',
      "/components/OnboardingFlow.tsx": 'throw new Error("Retired guided onboarding loaded");',
      "/components/ReauthenticationScreen.tsx": 'throw new Error("Retired sign-in screen loaded");',
      "/components/ui/button": "export function Button({ children }) { return children; }",
    },
  });
  const { default: AppRouter } = await vite.ssrLoadModule("/AppRouter.jsx");
  await Promise.all([
    vite.ssrLoadModule("/ControlPanelApp.jsx"),
    vite.ssrLoadModule("/DictationApp.jsx"),
    vite.ssrLoadModule("/components/onboarding/PermissionGuideOverlay"),
    vite.ssrLoadModule("/components/MeetingNotificationOverlay.tsx"),
    vite.ssrLoadModule("/components/agent/AgentWindow.tsx"),
  ]);
  root = createRoot(container);
  const render = async () => {
    await React.act(async () => root.render(React.createElement(AppRouter)));
  };
  return { container, storage, calls, policy, render };
}

test("the panel waits for device policy and recovers note files once on mount", async (t) => {
  const { calls, policy, render, storage, container } = await createRouterHarness(t, {
    noteFilesEnabled: "true",
    noteFilesPath: "/tmp/note-exports",
  });
  policy.deviceReady = false;
  await render();
  assert.deepEqual(calls.noteFiles, []);
  assert.equal(storage.getItem("onboardingCompleted"), null);
  policy.deviceReady = true;
  await render();
  await render();
  assert.equal(container.textContent, "control-panel");
  assert.deepEqual(calls.noteFiles, [[true, "/tmp/note-exports", { startup: true }]]);
  assert.deepEqual(calls.active, [[false]]);
  assert.deepEqual(calls.modes, [["restore"]]);
});

for (const signedIn of ["false", "true"]) {
  test(`a local launch bypasses sign-in without resuming cloud (stored signed-in=${signedIn})`, async (t) => {
    const { container, storage, calls, policy, render } = await createRouterHarness(t, {
      isSignedIn: signedIn,
      onboardingCurrentStep: "0",
      onboardingSessionV2: JSON.stringify({ currentStepId: "auth" }),
      "openwhispr:accountProfile": "existing-profile",
    });
    policy.requireSignIn = true;
    await render();
    assert.equal(container.textContent, "control-panel");
    for (const key of ["onboardingCompleted", "authenticationSkipped", "skipAuth"])
      assert.equal(storage.getItem(key), "true");
    assert.equal(storage.getItem("openwhispr:accountProfile"), "existing-profile");
    assert.deepEqual(calls.accessibility, [[undefined]]);
  });
}

test("the float releases the startup gate without restoring a control-panel window", async (t) => {
  const { container, calls, render } = await createRouterHarness(t, {}, "");
  await render();
  assert.equal(container.textContent, "dictation");
  assert.deepEqual(calls.active, [[false]]);
  assert.deepEqual(calls.modes, []);
});

test("an invalid device policy blocks normal startup until corrected", async (t) => {
  const { container, policy, calls, storage, render } = await createRouterHarness(t);
  policy.code = "DEVICE_POLICY_INVALID";
  await render();
  assert.match(container.textContent, /common.devicePolicyInvalid/);
  assert.deepEqual(calls.noteFiles, []);
  assert.deepEqual(calls.active, []);
  assert.equal(storage.getItem("onboardingCompleted"), null);
  policy.code = undefined;
  await render();
  assert.equal(container.textContent, "control-panel");
  assert.deepEqual(calls.active, [[false]]);
});

for (const [search, content] of [["?permission-guide=true", "permission-guide"]]) {
  test(`${content} never runs normal-app startup effects`, async (t) => {
    const { container, calls, storage, render } = await createRouterHarness(t, {}, search);
    await render();
    assert.equal(container.textContent, content);
    assert.deepEqual(calls.noteFiles, []);
    assert.deepEqual(calls.active, []);
    assert.equal(storage.getItem("onboardingCompleted"), null);
  });
}
