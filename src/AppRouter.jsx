import React, { Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "./hooks/useTheme";
import { usePolicyStore } from "./stores/policyStore";
import { Button } from "./components/ui/button";
import { isAgentWindow, isControlPanelWindow } from "./utils/windowContext.ts";

const ControlPanelApp = React.lazy(() => import("./ControlPanelApp.jsx"));
const DictationApp = React.lazy(() => import("./DictationApp.jsx"));
const MeetingNotificationOverlay = React.lazy(
  () => import("./components/MeetingNotificationOverlay.tsx")
);
const PermissionGuideOverlay = React.lazy(() =>
  import("./components/onboarding/PermissionGuideOverlay").then((module) => ({
    default: module.PermissionGuideOverlay,
  }))
);
const AgentWindow = React.lazy(() => import("./components/agent/AgentWindow.tsx"));

export default function AppRouter() {
  useTheme();
  const { t } = useTranslation();
  const deviceReady = usePolicyStore((state) => state.deviceReady);
  const policyCode = usePolicyStore((state) => state.code);
  const policyStatus = usePolicyStore((state) => state.status);
  const localOnly = usePolicyStore((state) => state.localOnly);
  const workspaceRequired = usePolicyStore((state) => state.workspaceRequired);
  useEffect(() => {
    void usePolicyStore.getState().bootstrap();
  }, []);
  useEffect(() => {
    if (
      deviceReady &&
      isControlPanelWindow() &&
      (policyCode === "DEVICE_POLICY_INVALID" || (localOnly && policyStatus === "error"))
    )
      void window.electronAPI?.setOnboardingWindowMode?.("restore");
  }, [deviceReady, policyCode, localOnly, policyStatus]);
  if (!deviceReady) return <LoadingFallback />;
  if (policyCode === "DEVICE_POLICY_INVALID") {
    return <LoadingFallback message={t("common.devicePolicyInvalid")} error />;
  }
  if (localOnly && policyStatus === "error") {
    return (
      <LoadingFallback
        error
        message={t(
          workspaceRequired ? "common.deviceWorkspaceUnavailable" : "common.managedPolicyConflict"
        )}
        action={
          workspaceRequired ? (
            <Button onClick={() => void import("./lib/auth").then(({ signOut }) => signOut())}>
              {t("common.logout")}
            </Button>
          ) : undefined
        }
      />
    );
  }
  const params = window.location.search;

  if (params.includes("permission-guide=true"))
    return (
      <Suspense fallback={null}>
        <PermissionGuideOverlay />
      </Suspense>
    );

  if (params.includes("meeting-notification=true")) {
    return (
      <Suspense fallback={null}>
        <MeetingNotificationOverlay />
      </Suspense>
    );
  }

  // Before the normal app routes: they report startup state, which only the dictation
  // window and the control panel may do.
  if (isAgentWindow()) {
    return (
      <Suspense fallback={null}>
        <AgentWindow />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<LoadingFallback />}>
      {isControlPanelWindow() ? <ControlPanelApp /> : <DictationApp />}
    </Suspense>
  );
}

function LoadingFallback({ message, error = false, action }) {
  const { t } = useTranslation();
  const fallbackMessage = message || t("common.loading");

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 animate-[scale-in_300ms_ease-out]">
        <svg
          viewBox="0 0 1024 1024"
          className="w-12 h-12 drop-shadow-[0_2px_8px_rgba(37,99,235,0.18)] dark:drop-shadow-[0_2px_12px_rgba(100,149,237,0.25)]"
          aria-label="OpenWhispr"
        >
          <rect width="1024" height="1024" rx="241" fill="#2056DF" />
          <circle cx="512" cy="512" r="314" fill="#2056DF" stroke="white" strokeWidth="74" />
          <path d="M512 383V641" stroke="white" strokeWidth="74" strokeLinecap="round" />
          <path d="M627 457V568" stroke="white" strokeWidth="74" strokeLinecap="round" />
          <path d="M397 457V568" stroke="white" strokeWidth="74" strokeLinecap="round" />
        </svg>
        {!error && (
          <div className="w-7 h-7 rounded-full border-[2.5px] border-transparent border-t-primary animate-[spinner-rotate_0.8s_cubic-bezier(0.4,0,0.2,1)_infinite] motion-reduce:animate-none motion-reduce:border-t-muted-foreground motion-reduce:opacity-50" />
        )}
        {fallbackMessage && (
          <p className="text-[13px] font-medium text-muted-foreground dark:text-foreground/60 tracking-[-0.01em]">
            {fallbackMessage}
          </p>
        )}
        {action}
      </div>
    </div>
  );
}
