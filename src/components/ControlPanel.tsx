import React, { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { prepareControlPanelRelease } from "../utils/controlPanelRelease";
import { useTranslation } from "react-i18next";
import PostMigrationOnboarding from "./PostMigrationOnboarding";
import { SelfHostedSetupDialog } from "./SelfHostedSetupDialog";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useHotkey } from "../hooks/useHotkey";
import { useToast } from "./ui/useToast";
import { useCollapsibleSidebar } from "../hooks/useCollapsibleSidebar";
import {
  useTranscriptions,
  useShowDiscarded,
  initializeTranscriptions,
  removeTranscription as removeFromStore,
  updateTranscription as updateInStore,
  clearTranscriptions as clearStore,
} from "../stores/transcriptionStore";
import { clearInsightsCache } from "../lib/insightsCache";
import { getSettings } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import {
  isAgentAllowed,
  isControlPanelViewAllowed,
  isPolicyActionAllowed,
} from "../stores/policyRules";
import { useIsMeetingMode, useIsNarrowWindow } from "../stores/meetingRecordingStore";
import ControlPanelSidebar from "./ControlPanelSidebar";
import ControlPanelTopBar from "./ControlPanelTopBar";
import { useControlPanelNavItems, type ControlPanelView } from "./controlPanelNav";
import NewNoteMenu from "./notes/NewNoteMenu";

import { getCachedPlatform } from "../utils/platform";
import { isAccessibilitySkipped } from "../utils/permissions";
import { useCreateNote } from "../hooks/useCreateNote";
import {
  setActiveNoteId,
  setActiveFolderId,
  navigateToContainer,
  ensureNoteLoaded,
  useActiveNoteId,
  initializeNotes,
} from "../stores/noteStore";
import HistoryView from "./HistoryView";
import { providerErrorToastProps } from "../utils/describeProviderError";
import { useModalGate } from "../stores/modalGateStore";

const platform = getCachedPlatform();

const SIDEBAR_WIDTH_PX = 192;

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const PersonalNotesView = React.lazy(() => import("./notes/PersonalNotesView"));
const InsightsView = React.lazy(() => import("./InsightsView"));
const UploadAudioView = React.lazy(() => import("./notes/UploadAudioView"));
const CommandSearch = React.lazy(() => import("./CommandSearch"));

interface ControlPanelProps {
  /** Open the settings modal at this section on mount (e.g. after onboarding). */
  initialSettingsSection?: string;
}

export default function ControlPanel({ initialSettingsSection }: ControlPanelProps = {}) {
  const releaseBlocked = useRef(true);
  useEffect(() => {
    let preparing = false;
    let mounted = true;
    const dispose = window.electronAPI?.onControlPanelReleaseRequested?.(async (requestId) => {
      if (preparing) return;
      preparing = true;
      try {
        const ready = !releaseBlocked.current && (await prepareControlPanelRelease());
        if (mounted)
          window.electronAPI.controlPanelReleaseReady(requestId, ready && !releaseBlocked.current);
      } finally {
        preparing = false;
      }
    });
    return () => {
      mounted = false;
      dispose?.();
    };
  }, []);
  const { t } = useTranslation();
  const history = useTranscriptions();
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(!!initialSettingsSection);
  const [showPostMigration, setShowPostMigration] = useState(false);
  const [postMigrationChecked, setPostMigrationChecked] = useState(platform !== "darwin");
  useModalGate("postMigrationPending", !postMigrationChecked);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(
    initialSettingsSection
  );
  // Counts named show-settings requests, so asking again for the section the
  // modal was opened at still lands there after the user moved elsewhere in it.
  const [settingsRequest, setSettingsRequest] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const showDiscarded = useShowDiscarded();
  const [activeView, setActiveView] = useState<ControlPanelView>("home");
  const navItems = useControlPanelNavItems();
  const {
    collapsed: sidebarCollapsed,
    peek: sidebarPeek,
    toggle: toggleSidebar,
    showPeek: showSidebarPeek,
    hidePeek: hideSidebarPeek,
    leaveToggle: leaveSidebarToggle,
  } = useCollapsibleSidebar();
  const isMeetingMode = useIsMeetingMode();
  const isNarrowWindow = useIsNarrowWindow();
  const activeNoteId = useActiveNoteId();
  const isSidePanelLayout =
    isMeetingMode || (isNarrowWindow && activeView === "personal-notes" && activeNoteId != null);
  releaseBlocked.current = isLoading;
  const { hotkey } = useHotkey();
  const { toast } = useToast();
  const isSignedIn = false;

  const agentAllowedByPolicy = usePolicyStore(isAgentAllowed);
  const { createNote } = useCreateNote();
  // The note is created before the view switches so Notes mounts with it already open.
  const handleNewNote = useCallback(async () => {
    await createNote();
    setActiveView("personal-notes");
  }, [createNote]);
  const policyActionsAllowed = usePolicyStore((state) => isPolicyActionAllowed(state));
  useEffect(() => {
    if (!isControlPanelViewAllowed(activeView, agentAllowedByPolicy, policyActionsAllowed)) {
      setActiveView("home");
    }
  }, [activeView, agentAllowedByPolicy, policyActionsAllowed]);

  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const loadTranscriptions = useCallback(
    async (includeDiscarded?: boolean) => {
      try {
        setIsLoading(true);
        await initializeTranscriptions(undefined, includeDiscarded);
      } catch {
        showAlertDialog({
          title: t("controlPanel.history.couldNotLoadTitle"),
          description: t("controlPanel.history.couldNotLoadDescription"),
        });
      } finally {
        setIsLoading(false);
      }
    },
    [showAlertDialog, t]
  );

  useEffect(() => {
    loadTranscriptions();
  }, [loadTranscriptions]);

  useEffect(() => {
    if (platform !== "darwin") return;
    const check = window.electronAPI?.getPostMigrationState?.();
    if (!check) {
      setPostMigrationChecked(true);
      return;
    }
    check
      .then((state) => {
        if (state?.justMigrated) setShowPostMigration(true);
      })
      .finally(() => setPostMigrationChecked(true));
  }, []);

  const dismissPostMigrationPermanently = useCallback(async () => {
    await window.electronAPI?.markBundleMigrated?.();
    setShowPostMigration(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "k") {
        e.preventDefault();
        setShowSearch(true);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const drain = async () => {
      const data = await window.electronAPI?.getPendingNoteNavigation?.();
      if (!data) return;
      if (data.folderId) {
        setActiveFolderId(data.folderId);
        initializeNotes(null, 50, data.folderId);
      }
      setActiveNoteId(data.noteId);
      void ensureNoteLoaded(data.noteId);
      setActiveView("personal-notes");
    };
    drain();
    const cleanup = window.electronAPI?.onNoteNavigationPending?.(drain);
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    // A named section waits in main (it can outrace this listener on a cold
    // start); a bare request (app-menu Cmd+,) keeps an open modal where it is.
    const drain = async (showAnyway: boolean) => {
      const section = await window.electronAPI?.getPendingSettingsSection?.();
      if (section) {
        setSettingsSection(section);
        setSettingsRequest((count) => count + 1);
      }
      if (section || showAnyway) setShowSettings(true);
    };
    drain(false);
    const cleanup = window.electronAPI?.onShowSettings?.(() => drain(true));
    return () => cleanup?.();
  }, []);

  // When accessibility is missing on macOS, open the permissions settings page
  useEffect(() => {
    const cleanup = window.electronAPI?.onAccessibilityMissing?.(async () => {
      if (isAccessibilitySkipped()) return;
      const migration = await window.electronAPI?.getPostMigrationState?.();
      if (migration?.justMigrated) return;
      setSettingsSection("privacyData");
      setShowSettings(true);
      toast({
        title: t("controlPanel.accessibilityMissing.title"),
        description: t("controlPanel.accessibilityMissing.description"),
        duration: 10000,
      });
    });
    return () => cleanup?.();
  }, [toast, t]);
  const openNoteInNotes = useCallback(
    (noteId: number, folderId: number | null, spaceId?: number | null) => {
      if (folderId != null) setActiveFolderId(folderId);
      else if (spaceId != null) navigateToContainer(spaceId, null);
      setActiveNoteId(noteId);
      void ensureNoteLoaded(noteId);
      setActiveView("personal-notes");
    },
    []
  );
  // The side-panel layout is shared by meeting mode and by a note opened in a
  // narrow window, so leaving it means different things in each case.
  const handleExitSidePanel = useCallback(() => {
    if (isMeetingMode) window.electronAPI?.restoreFromMeetingMode?.();
    else setActiveNoteId(null);
  }, [isMeetingMode]);

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t("controlPanel.history.copiedTitle"),
          description: t("controlPanel.history.copiedDescription"),
          variant: "success",
          duration: 2000,
        });
      } catch (err) {
        toast({
          title: t("controlPanel.history.couldNotCopyTitle"),
          description: t("controlPanel.history.couldNotCopyDescription"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const deleteTranscription = useCallback(
    async (id: number) => {
      showConfirmDialog({
        title: t("controlPanel.history.deleteTitle"),
        description: t("controlPanel.history.deleteDescription"),
        onConfirm: async () => {
          try {
            const result = await window.electronAPI.deleteTranscription(id);
            if (result.success) {
              removeFromStore(id);
            } else {
              showAlertDialog({
                title: t("controlPanel.history.couldNotDeleteTitle"),
                description: t("controlPanel.history.couldNotDeleteDescription"),
              });
            }
          } catch {
            showAlertDialog({
              title: t("controlPanel.history.couldNotDeleteTitle"),
              description: t("controlPanel.history.couldNotDeleteDescriptionGeneric"),
            });
          }
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, showAlertDialog, t]
  );

  const clearAllTranscriptions = useCallback(() => {
    showConfirmDialog({
      title: t("controlPanel.history.clearAllTitle"),
      description: t(
        isSignedIn
          ? "controlPanel.history.clearAllDescription"
          : "controlPanel.history.clearAllDescriptionDevice"
      ),
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.clearTranscriptions();
          if (result.success) {
            clearStore();
            // Insights is unmounted here, and would otherwise paint the cleared totals.
            clearInsightsCache();
            toast({
              title: t("controlPanel.history.clearAllSuccess"),
              variant: "success",
              duration: 2000,
            });
          } else {
            showAlertDialog({
              title: t("controlPanel.history.clearAllErrorTitle"),
              description: t("controlPanel.history.clearAllErrorDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("controlPanel.history.clearAllErrorTitle"),
            description: t("controlPanel.history.clearAllErrorDescription"),
          });
        }
      },
      variant: "destructive",
    });
  }, [isSignedIn, showConfirmDialog, showAlertDialog, toast, t]);

  const showAudioInFolder = useCallback(
    async (id: number) => {
      try {
        const result = await window.electronAPI.showAudioInFolder(id);
        if (!result?.success) {
          toast({
            title: t("controlPanel.history.audioNotFound"),
            variant: "destructive",
          });
        }
      } catch {
        toast({
          title: t("controlPanel.history.audioNotFound"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );
  const retryTranscription = useCallback(
    async (id: number) => {
      const result = await window.electronAPI.retryTranscription(id, getSettings());
      if (!result?.success) {
        toast({
          title: t("controlPanel.history.retryError"),
          ...providerErrorToastProps(result, t),
          variant: "destructive",
        });
        return;
      }
      if (result.transcription) updateInStore(result.transcription);
      toast({ title: t("controlPanel.history.retrySuccess") });
    },
    [toast, t]
  );

  const toggleShowDiscarded = useCallback(() => {
    loadTranscriptions(!showDiscarded);
  }, [loadTranscriptions, showDiscarded]);

  return (
    <div className="h-screen bg-surface-window flex flex-col">
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <PostMigrationOnboarding
        open={showPostMigration}
        onOpenChange={setShowPostMigration}
        onDone={dismissPostMigrationPermanently}
      />

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            // SettingsModal reads initialSection only on open, so a named request remounts it.
            key={`${settingsSection ?? "default"}-${settingsRequest}`}
            open={showSettings}
            onOpenChange={(open) => {
              setShowSettings(open);
              if (!open) setSettingsSection(undefined);
            }}
            initialSection={settingsSection}
          />
        </Suspense>
      )}

      {/* Always mounted so the palette chunk is warm and Radix can play its exit animation. */}
      <Suspense fallback={null}>
        <CommandSearch
          open={showSearch}
          onOpenChange={setShowSearch}
          transcriptions={history}
          onNoteSelect={openNoteInNotes}
          onContainerSelect={(spaceId, folderId) => {
            navigateToContainer(spaceId, folderId);
            setActiveView("personal-notes");
          }}
          onTranscriptSelect={() => {
            setActiveView("home");
          }}
        />
      </Suspense>

      <SelfHostedSetupDialog />

      <div className="flex flex-1 overflow-hidden relative">
        <div
          className="shrink-0 transition-[width] duration-300 ease-out"
          style={{ width: sidebarCollapsed || isSidePanelLayout ? 0 : SIDEBAR_WIDTH_PX }}
        />
        <div
          className={`absolute inset-y-0 start-0 z-30 transition-transform duration-300 ease-out ${
            !isSidePanelLayout && (!sidebarCollapsed || sidebarPeek)
              ? "translate-x-0"
              : "ltr:-translate-x-full rtl:translate-x-full"
          }${
            sidebarCollapsed && sidebarPeek && !isSidePanelLayout
              ? " shadow-[10px_0_40px_-18px_rgba(0,0,0,0.2)] rtl:shadow-[-10px_0_40px_-18px_rgba(0,0,0,0.2)]"
              : ""
          }`}
          onMouseEnter={sidebarCollapsed ? showSidebarPeek : undefined}
          onMouseLeave={sidebarCollapsed ? hideSidebarPeek : undefined}
        >
          <ControlPanelSidebar
            activeView={activeView}
            onViewChange={setActiveView}
            onOpenSettings={() => {
              setSettingsSection(undefined);
              setShowSettings(true);
            }}
            // The side-panel layout (a meeting, or a narrow window with a note open) has no room for it.
            workspaceIntroAllowed={!showSettings && !isSidePanelLayout}
          />
        </div>
        <main className="flex-1 flex flex-col overflow-hidden p-2">
          <div className="flex min-h-0 flex-1 flex-col overflow-clip rounded-(--radius-shell) border border-border bg-background dark:border-white/10">
            <ControlPanelTopBar
              title={navItems.find((item) => item.id === activeView)?.label ?? ""}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
              onToggleMouseEnter={sidebarCollapsed ? showSidebarPeek : undefined}
              onToggleMouseLeave={sidebarCollapsed ? leaveSidebarToggle : undefined}
              onOpenSearch={() => setShowSearch(true)}
              isSidePanelLayout={isSidePanelLayout}
              onExitSidePanel={handleExitSidePanel}
              actions={
                <div className="flex items-center gap-2">
                  <NewNoteMenu onNewNote={handleNewNote} />
                </div>
              }
            />
            <div className="scrollbar-hidden flex-1 overflow-y-auto">
              {activeView === "home" && (
                <HistoryView
                  history={history}
                  isLoading={isLoading}
                  hotkey={hotkey}
                  copyToClipboard={copyToClipboard}
                  deleteTranscription={deleteTranscription}
                  clearAllTranscriptions={clearAllTranscriptions}
                  onShowAudioInFolder={showAudioInFolder}
                  onRetryTranscription={retryTranscription}
                  showDiscarded={showDiscarded}
                  onToggleDiscarded={toggleShowDiscarded}
                  onOpenSettings={(section) => {
                    setSettingsSection(section);
                    setShowSettings(true);
                  }}
                />
              )}
              {activeView === "insights" && (
                <Suspense fallback={null}>
                  <InsightsView
                    onSignIn={() => {
                      setSettingsSection("general");
                      setShowSettings(true);
                    }}
                  />
                </Suspense>
              )}
              {activeView === "personal-notes" && (
                <Suspense fallback={null}>
                  <PersonalNotesView
                    onOpenSettings={(section) => {
                      setSettingsSection(section);
                      setShowSettings(true);
                    }}
                  />
                </Suspense>
              )}
              {activeView === "upload" && policyActionsAllowed && (
                <Suspense fallback={null}>
                  <UploadAudioView
                    onNoteCreated={(noteId, folderId) => {
                      setActiveNoteId(noteId);
                      if (folderId) setActiveFolderId(folderId);
                      setActiveView("personal-notes");
                    }}
                    onOpenSettings={(section) => {
                      setSettingsSection(section);
                      setShowSettings(true);
                    }}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
