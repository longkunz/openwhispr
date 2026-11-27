import { useEffect, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { resolveMacAccessibilityReadiness } from "../utils/macAccessibilityReadiness";

// Both windows release the startup gate; only the panel owns account/session UI.
export function useNormalAppLifecycle(isControlPanel, isSignedIn = false) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const { noteFilesEnabled, noteFilesPath } = useSettingsStore.getState();
    void window.electronAPI?.noteFilesSetEnabled?.(noteFilesEnabled, noteFilesPath || undefined, {
      startup: true,
    });
    localStorage.setItem("onboardingCompleted", "true");
    localStorage.setItem("authenticationSkipped", "true");
    localStorage.setItem("skipAuth", "true");
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (isControlPanel) void window.electronAPI?.setOnboardingWindowMode?.("restore");
    void window.electronAPI?.setOnboardingActive?.(false);
    let cancelled = false;
    void resolveMacAccessibilityReadiness({
      normalAppVisible: true,
      isControlPanel,
      isSignedIn,
      authSkipped: true,
      readActiveAccountScope: window.electronAPI?.getActiveAccountScope,
    }).then((readiness) => {
      if (!cancelled && readiness) {
        window.electronAPI?.markMacAccessibilityFeaturesReady?.(readiness.expectedAccountScope);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ready, isControlPanel, isSignedIn]);
  return ready;
}
