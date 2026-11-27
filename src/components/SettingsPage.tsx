import React, { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "./ui/BidiInterpolatedText";
import {
  Mic,
  Shield,
  FolderOpen,
  Sun,
  Moon,
  Monitor,
  AlertTriangle,
  Loader2,
  CircleCheck,
  CircleX,
  RotateCw,
  BookOpen,
  Copy,
  Info,
  FileAudio,
  Upload,
} from "./icons";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import MicrophoneSettings from "./ui/MicrophoneSettings";
import PermissionCard from "./ui/PermissionCard";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import NixOsPasteInfo from "./ui/NixOsPasteInfo";
import SelfHostedPanel from "./SelfHostedPanel";
import {
  ConfirmDialog,
  AlertDialog,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { useSettings } from "../hooks/useSettings";
import { useDialogs } from "../hooks/useDialogs";
import { clearInsightsCache } from "../lib/insightsCache";
import { usePermissions } from "../hooks/usePermissions";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { useClipboard } from "../hooks/useClipboard";

import { ProviderTabs } from "./ui/ProviderTabs";
import { HotkeyListInput } from "./ui/HotkeyListInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { useHotkeyModeInfo } from "../hooks/useHotkeyModeInfo";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { validateHotkeyForSlot } from "../utils/hotkeyValidation";
import { getCachedPlatform } from "../utils/platform";
import { formatHotkeyLabel } from "../utils/hotkeys";
import {
  getLinuxPasteInstallCommands,
  needsLinuxPasteToolGuidance,
} from "../utils/linuxPasteTools";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import LinuxPttSetupInfo from "./ui/LinuxPttSetupInfo";
import { Toggle } from "./ui/toggle";
import DeveloperSection from "./DeveloperSection";
import { MeetingTranscriptionPanel } from "./settings/MeetingSettings";
import { UploadTranscriptionPanel } from "./settings/UploadSettings";
import LanguageSelector from "./ui/LanguageSelector";
import { useToast } from "./ui/useToast";
import { useTheme } from "../hooks/useTheme";
import type { LocalTranscriptionProvider, InferenceMode } from "../types/electron";
import logger from "../utils/logger";
import { SettingsRow, SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { TabPanel } from "./ui/TabPanel";
import { formatBytes } from "../utils/formatBytes";
import { useSettingsStore } from "../stores/settingsStore";
import {
  effectiveAudioRetentionDays,
  effectiveLocalHistoryEnabled,
  lockedLocalHistoryValue,
  maxAudioRetentionDays,
} from "../stores/policyRules";
import { usePolicySnapshot } from "../hooks/usePolicy";
import { canManageSystemAudioInApp } from "../utils/systemAudioAccess";
import type { PlansBillingRequest, SettingsSectionType } from "../lib/settingsNav";

export type { SettingsSectionType };

interface SettingsPageProps {
  activeSection?: SettingsSectionType;
  onNavigateToSection?: (section: SettingsSectionType, subTab?: string) => void;
  /** When a legacy section ID was used (e.g. `meetings`), land on the matching sub-tab. */
  initialSubTab?: string;
  /** Takes the user to a teamspace in Notes (owned by the control panel, which closes Settings). */
  onOpenTeamspace?: (localSpaceId: number) => void;
  /** Which plan Plans & Billing shows; owned by the modal so a link can name it. */
  billingRequest?: PlansBillingRequest;
  onBillingRequestChange?: (request: PlansBillingRequest) => void;
}

const PERSONAL_BILLING_REQUEST: PlansBillingRequest = { kind: "personal" };

const RETENTION_DAY_OPTIONS = [1, 7, 14, 30, 60, 90];

const RETENTION_SELECT_CLASS =
  "h-7 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm hover:border-border-hover hover:bg-surface-2/70 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 transition-colors duration-200";

function SectionHeader({
  title,
  description,
  note,
}: {
  title: string;
  description?: string;
  note?: string;
}) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
      )}
      {note && <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{note}</p>}
    </div>
  );
}

interface TranscriptionSectionProps {
  isSignedIn: boolean;
  cloudTranscriptionMode: string;
  setCloudTranscriptionMode: (mode: string) => void;
  useLocalWhisper: boolean;
  setUseLocalWhisper: (value: boolean) => void;
  updateTranscriptionSettings: (settings: { useLocalWhisper: boolean }) => void;
  cloudTranscriptionProvider: string;
  setCloudTranscriptionProvider: (provider: string) => void;
  cloudTranscriptionModel: string;
  setCloudTranscriptionModel: (model: string) => void;
  localTranscriptionProvider: string;
  setLocalTranscriptionProvider: (provider: LocalTranscriptionProvider) => void;
  whisperModel: string;
  setWhisperModel: (model: string) => void;
  parakeetModel: string;
  setParakeetModel: (model: string) => void;
  cohereModel: string;
  setCohereModel: (model: string) => void;
  cloudTranscriptionBaseUrl?: string;
  setCloudTranscriptionBaseUrl: (url: string) => void;
  transcriptionMode: InferenceMode;
  setTranscriptionMode: (mode: InferenceMode) => void;
  remoteTranscriptionUrl: string;
  setRemoteTranscriptionUrl: (url: string) => void;
  remoteTranscriptionModel: string;
  setRemoteTranscriptionModel: (model: string) => void;
  showTranscriptionPreview: boolean;
  setShowTranscriptionPreview: (value: boolean) => void;
  toast: (opts: {
    title: string;
    description: string;
    variant?: "default" | "destructive" | "success";
    duration?: number;
  }) => void;
}

export function TranscriptionSection({
  isSignedIn,
  cloudTranscriptionMode,
  setCloudTranscriptionMode,
  useLocalWhisper,
  setUseLocalWhisper,
  updateTranscriptionSettings,
  cloudTranscriptionProvider,
  setCloudTranscriptionProvider,
  cloudTranscriptionModel,
  setCloudTranscriptionModel,
  localTranscriptionProvider,
  setLocalTranscriptionProvider,
  whisperModel,
  setWhisperModel,
  parakeetModel,
  setParakeetModel,
  cohereModel,
  setCohereModel,
  cloudTranscriptionBaseUrl,
  setCloudTranscriptionBaseUrl,
  transcriptionMode,
  setTranscriptionMode,
  remoteTranscriptionUrl,
  setRemoteTranscriptionUrl,
  remoteTranscriptionModel,
  setRemoteTranscriptionModel,
  showTranscriptionPreview,
  setShowTranscriptionPreview,
  toast,
}: TranscriptionSectionProps) {
  const { t } = useTranslation();
  const selfHostedHeaders = useSettingsStore((s) => s.selfHostedSttHeaders.dictation);
  const vietAsrStreamingEnabled = useSettingsStore((s) => s.vietAsrStreamingEnabled);
  const setVietAsrStreamingEnabled = useSettingsStore((s) => s.setVietAsrStreamingEnabled);
  const setSelfHostedSttHeaders = useSettingsStore((s) => s.setSelfHostedSttHeaders);

  useEffect(() => {
    if (transcriptionMode !== "self-hosted") {
      setTranscriptionMode("self-hosted");
      setUseLocalWhisper(false);
      updateTranscriptionSettings({ useLocalWhisper: false });
      setCloudTranscriptionMode("byok");
    }
  }, [
    transcriptionMode,
    setTranscriptionMode,
    setUseLocalWhisper,
    updateTranscriptionSettings,
    setCloudTranscriptionMode,
  ]);

  const previewAvailable = vietAsrStreamingEnabled;

  const renderPreviewToggle = () => (
    <SettingsPanel>
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.transcription.transcriptionPreview")}
          description={t("settingsPage.transcription.transcriptionPreviewDescription")}
        >
          <Toggle
            checked={showTranscriptionPreview}
            onChange={setShowTranscriptionPreview}
            ariaLabel={t("settingsPage.transcription.transcriptionPreview")}
          />
        </SettingsRow>
      </SettingsPanelRow>
    </SettingsPanel>
  );

  return (
    <div className="space-y-4">
      <SelfHostedPanel
        service="transcription"
        url={remoteTranscriptionUrl}
        onUrlChange={setRemoteTranscriptionUrl}
        model={remoteTranscriptionModel}
        onModelChange={setRemoteTranscriptionModel}
        headers={selfHostedHeaders}
        onHeadersChange={(rows) => setSelfHostedSttHeaders("dictation", rows)}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.transcription.vietAsrStreaming", "VietASR streaming")}
            description={t(
              "settingsPage.transcription.vietAsrStreamingDescription",
              "Show words as you speak with a VietASR server. Other servers use batch transcription."
            )}
          >
            <Toggle
              checked={vietAsrStreamingEnabled}
              onChange={setVietAsrStreamingEnabled}
              ariaLabel={t("settingsPage.transcription.vietAsrStreaming", "VietASR streaming")}
            />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>
      {previewAvailable && renderPreviewToggle()}
    </div>
  );
}

type SpeechTab = "dictation" | "noteRecording" | "upload";

const SPEECH_TABS: SpeechTab[] = ["dictation", "noteRecording", "upload"];

function useSubTab<T extends string>(storageKey: string, options: readonly T[], initial?: T) {
  const [tab, setTab] = useLocalStorage<T>(storageKey, initial ?? options[0]);
  useEffect(() => {
    if (initial && initial !== tab) setTab(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const safeTab = options.includes(tab) ? tab : options[0];
  return [safeTab, setTab] as const;
}

function SpeechToTextTabs({
  initialTab,
  renderDictation,
  renderNoteRecording,
  renderUpload,
}: {
  initialTab?: SpeechTab;
  renderDictation: () => React.ReactNode;
  renderNoteRecording: () => React.ReactNode;
  renderUpload: () => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useSubTab<SpeechTab>("settings.speechToTextTab", SPEECH_TABS, initialTab);

  const subTabs = [
    { id: "dictation", name: t("settingsPage.speechToText.tabs.dictation") },
    { id: "noteRecording", name: t("settingsPage.speechToText.tabs.noteRecording") },
    { id: "upload", name: t("settingsPage.speechToText.tabs.upload") },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("settingsPage.speechToText.title")}
        description={t("settingsPage.speechToText.description")}
      />
      <ProviderTabs
        providers={subTabs}
        selectedId={tab}
        onSelect={(id) => setTab(id as SpeechTab)}
        renderIcon={(id) =>
          id === "dictation" ? (
            <Mic className="w-3.5 h-3.5" />
          ) : id === "upload" ? (
            <Upload className="w-3.5 h-3.5" />
          ) : (
            <FileAudio className="w-3.5 h-3.5" />
          )
        }
      />
      <TabPanel active={tab === "dictation"}>{renderDictation()}</TabPanel>
      <TabPanel active={tab === "noteRecording"}>{renderNoteRecording()}</TabPanel>
      <TabPanel active={tab === "upload"}>{renderUpload()}</TabPanel>
    </div>
  );
}

export default function SettingsPage({
  activeSection = "general",
  onNavigateToSection,
  initialSubTab,
  onOpenTeamspace,
  billingRequest = PERSONAL_BILLING_REQUEST,
  onBillingRequestChange,
}: SettingsPageProps) {
  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    parakeetModel,
    cohereModel,
    preferredLanguage,
    chineseScriptPreference,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    useCleanupModel,
    dictationKey,
    activationMode,
    setActivationMode,
    microphoneSelectionMode,
    selectedMicDeviceId,
    selectedMicDeviceLabel,
    micWarmHoldSeconds,
    setMicrophoneSelectionMode,
    setSelectedMicDevice,
    setMicWarmHoldSeconds,
    setUseLocalWhisper,
    setWhisperModel,
    setLocalTranscriptionProvider,
    setParakeetModel,
    setCohereModel,
    setCloudTranscriptionProvider,
    setCloudTranscriptionModel,
    setCloudTranscriptionBaseUrl,
    setUseCleanupModel,
    setDictationKey,
    meetingKey,
    setMeetingKey,
    meetingHotkeyLayoutMode,
    setMeetingHotkeyLayoutMode,
    autoLearnCorrections,
    setAutoLearnCorrections,
    updateTranscriptionSettings,
    updateCleanupSettings,
    cloudTranscriptionMode,
    setCloudTranscriptionMode,
    transcriptionMode,
    setTranscriptionMode,
    remoteTranscriptionUrl,
    setRemoteTranscriptionUrl,
    remoteTranscriptionModel,
    setRemoteTranscriptionModel,
    notificationsEnabled,
    setNotificationsEnabled,
    notifyMeetingDetection,
    setNotifyMeetingDetection,
    notifyCalendarReminders,
    setNotifyCalendarReminders,
    autoUpdatesEnabled,
    setAutoUpdatesEnabled,
    audioCuesEnabled,
    setAudioCuesEnabled,
    pauseMediaOnDictation,
    setPauseMediaOnDictation,
    showTranscriptionPreview,
    setShowTranscriptionPreview,
    autoPasteEnabled,
    setAutoPasteEnabled,
    keepTranscriptionInClipboard,
    setKeepTranscriptionInClipboard,
    floatingIconAutoHide,
    setFloatingIconAutoHide,
    startMinimized,
    setStartMinimized,
    panelStartPosition,
    setPanelStartPosition,
    cloudBackupEnabled,
    setCloudBackupEnabled,
    insightsSyncEnabled,
    telemetryEnabled,
    setTelemetryEnabled,
    audioRetentionDays,
    setAudioRetentionDays,
    transcriptRetentionDays,
    setTranscriptRetentionDays,
    dataRetentionEnabled,
    setDataRetentionEnabled,
    saveDiscardedTranscriptions,
    setSaveDiscardedTranscriptions,
    customDictionary,
    noteFilesEnabled,
    setNoteFilesEnabled,
    noteFilesPath,
    setNoteFilesPath,
    dictationSileroEnabled,
    setDictationSileroEnabled,
    noteRecordingSileroEnabled,
    setNoteRecordingSileroEnabled,
    meetingSileroEnabled,
    setMeetingSileroEnabled,
    whisperVadThreshold,
    setWhisperVadThreshold,
    whisperVadMinSpeechDurationMs,
    setWhisperVadMinSpeechDurationMs,
    whisperVadMinSilenceDurationMs,
    setWhisperVadMinSilenceDurationMs,
    whisperVadMaxSpeechDurationS,
    setWhisperVadMaxSpeechDurationS,
    whisperVadSpeechPadMs,
    setWhisperVadSpeechPadMs,
    whisperVadSamplesOverlap,
    setWhisperVadSamplesOverlap,
  } = useSettings();
  const voiceAgentKey = useSettingsStore((s) => s.voiceAgentKey);
  const translationKey = useSettingsStore((s) => s.translationKey);

  const settingsPolicyState = usePolicySnapshot();
  const historyLockedByPolicy = lockedLocalHistoryValue(settingsPolicyState) !== null;
  const effectiveDataRetentionEnabled = effectiveLocalHistoryEnabled(
    settingsPolicyState,
    dataRetentionEnabled
  );
  const audioRetentionCap = maxAudioRetentionDays(settingsPolicyState);
  const enforcedAudioRetentionDays = effectiveAudioRetentionDays(
    settingsPolicyState,
    audioRetentionDays
  );

  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [isRemovingModels, setIsRemovingModels] = useState(false);
  const [cachePathHint, setCachePathHint] = useState(
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
      ? "%USERPROFILE%\\.cache\\openwhispr"
      : "~/.cache/openwhispr"
  );

  const permissionsHook = usePermissions(showAlertDialog);
  const systemAudio = useSystemAudioPermission();
  useClipboard(showAlertDialog);
  const [audioStorageUsage, setAudioStorageUsage] = useState<{
    fileCount: number;
    totalBytes: number;
  }>({ fileCount: 0, totalBytes: 0 });

  useEffect(() => {
    if (activeSection !== "privacyData") return;
    window.electronAPI
      ?.getAudioStorageUsage?.()
      .then((usage: { fileCount: number; totalBytes: number }) => {
        if (usage) setAudioStorageUsage(usage);
      })
      .catch(() => {});
  }, [activeSection]);

  // Lazy keep-alive: mount AI sections only after the user has visited them once,
  // then keep them mounted so model-download progress and IPC listeners survive
  // section switches. The setState-during-render pattern flips the flag in the
  // same commit as the section change, so there's no blank frame on first visit.
  const [hasMountedSpeechToText, setHasMountedSpeechToText] = useState(
    activeSection === "speechToText"
  );
  if (activeSection === "speechToText" && !hasMountedSpeechToText) {
    setHasMountedSpeechToText(true);
  }

  const handleClearAllAudio = async () => {
    if (!window.electronAPI?.deleteAllAudio) return;
    try {
      await window.electronAPI.deleteAllAudio();
      setAudioStorageUsage({ fileCount: 0, totalBytes: 0 });
      toast({ title: t("settingsPage.privacy.clearHistoryAudio"), variant: "default" });
    } catch {
      // silent fail
    }
  };

  // Wayland paste tool status for diagnostics.
  const [ydotoolStatus, setYdotoolStatus] = useState<{
    isLinux: boolean;
    isWayland: boolean;
    hasYdotool: boolean;
    hasYdotoold: boolean;
    hasWtype: boolean;
    hasWlCopy: boolean;
    daemonRunning: boolean;
    hasService: boolean;
    hasUinput: boolean;
    hasUdevRule: boolean;
    hasGroup: boolean;
    isKde: boolean;
    isWlroots: boolean;
    isCosmic: boolean;
    requiresWlCopy: boolean;
    isNixOS: boolean;
  } | null>(null);
  const [ydotoolGuideKey, setYdotoolGuideKey] = useState<string | null>(null);

  const refreshYdotoolStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI?.getYdotoolStatus?.();
      if (status) setYdotoolStatus(status);
    } catch {}
  }, []);

  useEffect(() => {
    refreshYdotoolStatus();
  }, [refreshYdotoolStatus]);

  const { theme, setTheme } = useTheme();

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: true,
    showAlert: showAlertDialog,
  });

  const validateDictationHotkey = useCallback(
    (hotkey: string) =>
      validateHotkeyForSlot(
        hotkey,
        {
          "settingsPage.general.meetingHotkey.title": meetingKey,
          "settingsPage.general.voiceAgentHotkey.title": voiceAgentKey,
          "settingsPage.general.translationHotkey.title": translationKey,
        },
        t
      ),
    [meetingKey, voiceAgentKey, translationKey, t]
  );

  const {
    isUsingNativeShortcut,
    isUsingHyprland,
    hyprlandConfigStatus,
    pushToTalkUnavailableReason,
    linuxInputAccessDenied,
  } = useHotkeyModeInfo("settings", dictationKey);
  const [effectiveDefaultHotkey, setEffectiveDefaultHotkey] = useState<string | null>(null);
  const [linuxPttAvailable, setLinuxPttAvailable] = useState(true);

  const platform = getCachedPlatform();

  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartNeedsApproval, setAutoStartNeedsApproval] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);

  const readAutoStartState = useCallback(async () => {
    if (!window.electronAPI?.getAutoStartEnabled) return;
    try {
      const state = await window.electronAPI.getAutoStartEnabled();
      setAutoStartEnabled(state.enabled);
      setAutoStartNeedsApproval(state.requiresApproval);
    } catch (error) {
      logger.error("Failed to get auto-start status", error, "settings");
    }
  }, []);

  useEffect(() => {
    readAutoStartState().finally(() => setAutoStartLoading(false));
  }, [readAutoStartState]);

  const handleAutoStartChange = async (enabled: boolean) => {
    if (!window.electronAPI?.setAutoStartEnabled) return;
    try {
      setAutoStartLoading(true);
      const result = await window.electronAPI.setAutoStartEnabled(enabled);
      // Read the state back rather than assuming: on Windows the OS can have the
      // item disabled out from under us, and on macOS it can need approval first.
      if (result.success) await readAutoStartState();
    } catch (error) {
      logger.error("Failed to set auto-start", error, "settings");
    } finally {
      setAutoStartLoading(false);
    }
  };

  const [noteFilesDefaultPath, setNoteFilesDefaultPath] = useState("");
  const [noteFilesRebuilding, setNoteFilesRebuilding] = useState(false);

  useEffect(() => {
    if (!noteFilesEnabled) return;
    window.electronAPI?.noteFilesGetDefaultPath?.().then((p) => {
      if (p) setNoteFilesDefaultPath(p);
    });
  }, [noteFilesEnabled]);

  const handleNoteFilesToggle = useCallback(
    async (enabled: boolean) => {
      setNoteFilesEnabled(enabled);
      await window.electronAPI?.noteFilesSetEnabled?.(enabled, noteFilesPath || undefined);
    },
    [setNoteFilesEnabled, noteFilesPath]
  );

  const handleNoteFilesChangePath = useCallback(async () => {
    const result = await window.electronAPI?.noteFilesPickFolder?.();
    if (result?.canceled || !result?.path) return;
    setNoteFilesPath(result.path);
    await window.electronAPI?.noteFilesSetPath?.(result.path);
  }, [setNoteFilesPath]);

  const handleNoteFilesRebuild = useCallback(async () => {
    setNoteFilesRebuilding(true);
    try {
      const result = await window.electronAPI?.noteFilesRebuild?.();
      if (result && !result.success) {
        toast({
          title: t("settings.noteFiles.rebuildError.title"),
          description: result.error || t("settings.noteFiles.rebuildError.description"),
          variant: "destructive",
        });
      }
    } finally {
      setNoteFilesRebuilding(false);
    }
  }, [toast, t]);

  useEffect(() => {
    const loadEffectiveDefaultHotkey = async () => {
      try {
        const key = await window.electronAPI?.getEffectiveDefaultHotkey?.();
        if (key) setEffectiveDefaultHotkey(key);
      } catch (error) {
        logger.error("Failed to get effective default hotkey", error, "settings");
      }
    };
    loadEffectiveDefaultHotkey();
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI?.onLinuxPttPermissionDenied?.(() => {
      setLinuxPttAvailable(false);
      toast({
        title: t("settingsPage.general.hotkey.linuxPttPermissionTitle"),
        description: t("settingsPage.general.hotkey.linuxPttPermissionDescription"),
        variant: "destructive",
        duration: 15000,
      });
      setActivationMode("tap");
    });
    return () => cleanup?.();
  }, [toast, t, setActivationMode]);

  const resetAccessibilityPermissions = () => {
    const message = t("settingsPage.permissions.resetAccessibility.description");

    showConfirmDialog({
      title: t("settingsPage.permissions.resetAccessibility.title"),
      description: message,
      onConfirm: () => {
        permissionsHook.requestAccessibilityPermission();
      },
    });
  };

  const handleRemoveModels = useCallback(() => {
    if (isRemovingModels) return;

    showConfirmDialog({
      title: t("settingsPage.developer.removeModels.title"),
      description: t("settingsPage.developer.removeModels.description", { path: cachePathHint }),
      confirmText: t("settingsPage.developer.removeModels.confirmText"),
      variant: "destructive",
      onConfirm: async () => {
        setIsRemovingModels(true);
        try {
          const results = await Promise.allSettled([
            window.electronAPI?.deleteAllWhisperModels?.(),
            window.electronAPI?.deleteAllParakeetModels?.(),
            window.electronAPI?.modelDeleteAll?.(),
          ]);

          const anyFailed = results.some(
            (r) =>
              r.status === "rejected" || (r.status === "fulfilled" && r.value && !r.value.success)
          );

          if (anyFailed) {
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.failedTitle"),
              description: t("settingsPage.developer.removeModels.failedDescription"),
            });
          } else {
            window.dispatchEvent(new Event("openwhispr-models-cleared"));
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.successTitle"),
              description: t("settingsPage.developer.removeModels.successDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("settingsPage.developer.removeModels.failedTitle"),
            description: t("settingsPage.developer.removeModels.failedDescriptionShort"),
          });
        } finally {
          setIsRemovingModels(false);
        }
      },
    });
  }, [isRemovingModels, cachePathHint, showConfirmDialog, showAlertDialog, t]);
  const isSignedIn = false;

  const renderSectionContent = () => {
    switch (activeSection) {
      case "general":
        return (
          <div className="space-y-6">
            {/* Appearance */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.appearance.title")}
                description={t("settingsPage.general.appearance.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.appearance.theme")}
                    description={t("settingsPage.general.appearance.themeDescription")}
                  >
                    <div className="inline-flex items-center gap-px p-0.5 bg-muted/60 dark:bg-surface-2 rounded-md">
                      {(
                        [
                          {
                            value: "light",
                            icon: Sun,
                            label: t("settingsPage.general.appearance.light"),
                          },
                          {
                            value: "dark",
                            icon: Moon,
                            label: t("settingsPage.general.appearance.dark"),
                          },
                          {
                            value: "auto",
                            icon: Monitor,
                            label: t("settingsPage.general.appearance.auto"),
                          },
                        ] as const
                      ).map((option) => {
                        const Icon = option.icon;
                        const isSelected = theme === option.value;
                        return (
                          <button
                            key={option.value}
                            onClick={() => setTheme(option.value)}
                            className={`
                              flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-xs font-medium
                              transition-colors duration-100
                              ${
                                isSelected
                                  ? "bg-background dark:bg-surface-raised text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground"
                              }
                            `}
                          >
                            <Icon className={`w-3 h-3 ${isSelected ? "text-primary" : ""}`} />
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Sound Effects */}
            <div>
              <SectionHeader title={t("settingsPage.general.soundEffects.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.soundEffects.dictationSounds")}
                    description={t("settingsPage.general.soundEffects.dictationSoundsDescription")}
                  >
                    <Toggle checked={audioCuesEnabled} onChange={setAudioCuesEnabled} />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.soundEffects.pauseMedia")}
                    description={t("settingsPage.general.soundEffects.pauseMediaDescription")}
                  >
                    <Toggle checked={pauseMediaOnDictation} onChange={setPauseMediaOnDictation} />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Notifications */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.notifications.title")}
                description={t("settingsPage.general.notifications.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.notifications.disableAll")}
                    description={t("settingsPage.general.notifications.disableAllDescription")}
                  >
                    <Toggle
                      checked={!notificationsEnabled}
                      onChange={(v) => setNotificationsEnabled(!v)}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.notifications.meetingDetection")}
                    description={t(
                      "settingsPage.general.notifications.meetingDetectionDescription"
                    )}
                  >
                    <Toggle
                      checked={notifyMeetingDetection}
                      onChange={setNotifyMeetingDetection}
                      disabled={!notificationsEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.notifications.calendarReminders")}
                    description={t(
                      "settingsPage.general.notifications.calendarRemindersDescription"
                    )}
                  >
                    <Toggle
                      checked={notifyCalendarReminders}
                      onChange={setNotifyCalendarReminders}
                      disabled={!notificationsEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Clipboard */}
            <div>
              <SectionHeader title={t("settingsPage.general.clipboard.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.clipboard.autoPaste")}
                    description={t("settingsPage.general.clipboard.autoPasteDescription")}
                  >
                    <Toggle checked={autoPasteEnabled} onChange={setAutoPasteEnabled} />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.clipboard.keepInClipboard")}
                    description={t("settingsPage.general.clipboard.keepInClipboardDescription")}
                  >
                    <Toggle
                      checked={keepTranscriptionInClipboard}
                      onChange={setKeepTranscriptionInClipboard}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Save Notes as Files */}
            <div>
              <SectionHeader title={t("settings.noteFiles.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.noteFiles.title")}
                    description={t("settings.noteFiles.description")}
                  >
                    <Toggle checked={noteFilesEnabled} onChange={handleNoteFilesToggle} />
                  </SettingsRow>
                </SettingsPanelRow>
                {noteFilesEnabled && (
                  <>
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settings.noteFiles.path")}
                        description={
                          <span dir="ltr" className="block break-all">
                            {noteFilesPath || noteFilesDefaultPath || "..."}
                          </span>
                        }
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={handleNoteFilesChangePath}
                        >
                          {t("settings.noteFiles.changePath")}
                        </Button>
                      </SettingsRow>
                    </SettingsPanelRow>
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settings.noteFiles.rebuild")}
                        description={t("settings.noteFiles.rebuildDescription")}
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={noteFilesRebuilding}
                          onClick={handleNoteFilesRebuild}
                        >
                          {noteFilesRebuilding ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            t("settings.noteFiles.rebuild")
                          )}
                        </Button>
                      </SettingsRow>
                    </SettingsPanelRow>
                  </>
                )}
              </SettingsPanel>
            </div>

            {/* Floating Icon */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.floatingIcon.title")}
                description={t("settingsPage.general.floatingIcon.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.floatingIcon.autoHide")}
                    description={t("settingsPage.general.floatingIcon.autoHideDescription")}
                  >
                    <Toggle checked={floatingIconAutoHide} onChange={setFloatingIconAutoHide} />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.floatingIcon.startPosition")}
                    description={t("settingsPage.general.floatingIcon.startPositionDescription")}
                  >
                    <select
                      value={panelStartPosition}
                      onChange={(e) =>
                        setPanelStartPosition(
                          e.target.value as "bottom-right" | "center" | "bottom-left"
                        )
                      }
                      className="h-7 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm hover:border-border-hover hover:bg-surface-2/70 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1 transition-colors duration-200"
                    >
                      <option value="bottom-right">
                        {t("settingsPage.general.floatingIcon.bottomRight")}
                      </option>
                      <option value="center">
                        {t("settingsPage.general.floatingIcon.center")}
                      </option>
                      <option value="bottom-left">
                        {t("settingsPage.general.floatingIcon.bottomLeft")}
                      </option>
                    </select>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Language */}
            <div>
              <SectionHeader
                title={t("settings.language.sectionTitle")}
                description={t("settings.language.sectionDescription")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.language.transcriptionLabel")}
                    description={t("settings.language.transcriptionDescription")}
                  >
                    <LanguageSelector
                      value={preferredLanguage}
                      onChange={(value) =>
                        updateTranscriptionSettings({ preferredLanguage: value })
                      }
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Startup */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.startup.title")}
                description={t("settingsPage.general.startup.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.startup.launchAtLogin")}
                    description={t("settingsPage.general.startup.launchAtLoginDescription")}
                  >
                    <Toggle
                      checked={autoStartEnabled}
                      onChange={(checked: boolean) => handleAutoStartChange(checked)}
                      disabled={autoStartLoading}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                {autoStartNeedsApproval && (
                  <SettingsPanelRow>
                    <Alert
                      variant="warning"
                      className="dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-200 dark:[&>svg]:text-amber-400"
                    >
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>
                        {t("settingsPage.general.startup.needsApproval.title")}
                      </AlertTitle>
                      <AlertDescription className="space-y-2">
                        <p>{t("settingsPage.general.startup.needsApproval.description")}</p>
                        <Button
                          onClick={() => void window.electronAPI?.openLoginItemsSettings?.()}
                          variant="outline"
                          size="sm"
                        >
                          {t("settingsPage.general.startup.needsApproval.action")}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  </SettingsPanelRow>
                )}
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.startup.startMinimized")}
                    description={t("settingsPage.general.startup.startMinimizedDescription")}
                  >
                    <Toggle checked={startMinimized} onChange={setStartMinimized} />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Microphone */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.microphone.title")}
                description={t("settingsPage.general.microphone.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <MicrophoneSettings
                    microphoneSelectionMode={microphoneSelectionMode}
                    selectedMicDeviceId={selectedMicDeviceId}
                    selectedMicDeviceLabel={selectedMicDeviceLabel}
                    micWarmHoldSeconds={micWarmHoldSeconds}
                    onSelectionModeChange={setMicrophoneSelectionMode}
                    onDeviceSelect={setSelectedMicDevice}
                    onMicWarmHoldSecondsChange={setMicWarmHoldSeconds}
                  />
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Wayland Paste Diagnostics — only on Linux + Wayland */}
            {ydotoolStatus?.isLinux && ydotoolStatus?.isWayland && (
              <div>
                <SectionHeader
                  title={t("settingsPage.general.waylandPaste.title", {
                    defaultValue: "Wayland Paste Setup",
                  })}
                  description={t("settingsPage.general.waylandPaste.description", {
                    defaultValue:
                      "Auto-paste on Wayland uses ydotool or wtype. wtype is preferred on wlroots compositors.",
                  })}
                />
                {(() => {
                  if (ydotoolStatus.isNixOS) {
                    return (
                      <NixOsPasteInfo status={ydotoolStatus} onRecheck={refreshYdotoolStatus} />
                    );
                  }
                  const checks = [
                    {
                      key: "hasWtype",
                      label: "wtype",
                      ok: ydotoolStatus.hasWtype,
                      required: ydotoolStatus.isWlroots || ydotoolStatus.isCosmic,
                      desc: t("settingsPage.general.waylandPaste.wtypeDesc"),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.wtype.step1Title"),
                          desc: t("settingsPage.general.waylandPaste.guide.wtype.step1Desc"),
                          cmds: getLinuxPasteInstallCommands(t, "wtype"),
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.wtype.step2Title"),
                          cmds: [{ cmd: "which wtype" }],
                        },
                      ],
                    },
                    {
                      key: "hasYdotool",
                      label: "ydotool",
                      ok: ydotoolStatus.hasYdotool,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.ydotoolDesc", {
                        defaultValue: "Input automation tool for Wayland",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.ydotool.step1Title", {
                            defaultValue: "Install ydotool",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.ydotool.step1Desc", {
                            defaultValue:
                              "Use your distribution's package manager to install ydotool.",
                          }),
                          cmds: getLinuxPasteInstallCommands(t, "ydotool"),
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.ydotool.step2Title", {
                            defaultValue: "Verify installation",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.ydotool.step2Desc", {
                            defaultValue: "Check that ydotool is available in your PATH.",
                          }),
                          cmds: [{ cmd: "which ydotool" }],
                        },
                      ],
                    },
                    {
                      key: "hasYdotoold",
                      label: "ydotoold",
                      ok: ydotoolStatus.hasYdotoold,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.ydotooldDesc", {
                        defaultValue: "Daemon for ydotool (separate package on Ubuntu/Pop!_OS)",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.ydotoold.step1Title", {
                            defaultValue: "Install ydotoold",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.ydotoold.step1Desc", {
                            defaultValue:
                              "On Ubuntu and Pop!_OS, ydotoold is a separate package. On Fedora, it's included with ydotool.",
                          }),
                          cmds: [
                            {
                              label: "Ubuntu / Pop!_OS / Debian",
                              cmd: "sudo apt install ydotoold",
                            },
                            { label: "Fedora", cmd: "# Already included in the ydotool package" },
                            { label: "Arch Linux", cmd: "# Included in the ydotool package" },
                          ],
                        },
                      ],
                    },
                    {
                      key: "hasUinput",
                      label: "/dev/uinput",
                      ok: ydotoolStatus.hasUinput,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.uinputDesc", {
                        defaultValue: "Kernel input device access",
                      }),
                      note: !ydotoolStatus.hasUinput
                        ? ydotoolStatus.hasUdevRule
                          ? t("settingsPage.general.waylandPaste.uinputRuleFound", {
                              defaultValue: "Rule present but not active. A reboot should fix it.",
                            })
                          : t("settingsPage.general.waylandPaste.uinputRuleMissing", {
                              defaultValue: "no udev rule found",
                            })
                        : undefined,
                      steps:
                        ydotoolStatus.hasUdevRule && !ydotoolStatus.hasUinput
                          ? [
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.ruleFoundTitle",
                                  {
                                    defaultValue: "udev rule already configured",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.ruleFoundDesc",
                                  {
                                    defaultValue:
                                      "The udev rule for /dev/uinput is already on your system but hasn't taken effect. Try reloading:",
                                  }
                                ),
                                cmds: [
                                  {
                                    cmd: "sudo udevadm control --reload-rules && sudo udevadm trigger /dev/uinput",
                                  },
                                ],
                              },
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.rebootTitle",
                                  {
                                    defaultValue: "If reloading didn't help, reboot",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.rebootDesc",
                                  {
                                    defaultValue:
                                      "On some distros, udev changes only apply after a full reboot. Restart your computer and come back to re-check.",
                                  }
                                ),
                              },
                            ]
                          : [
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step1Title",
                                  {
                                    defaultValue: "Create a udev rule",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step1Desc",
                                  {
                                    defaultValue:
                                      "This rule grants access to /dev/uinput for users in the input group.",
                                  }
                                ),
                                cmds: [
                                  {
                                    cmd: 'echo \'KERNEL=="uinput", GROUP="input", MODE="0660", TAG+="uaccess"\' | sudo tee /etc/udev/rules.d/70-uinput.rules',
                                  },
                                ],
                              },
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step2Title",
                                  {
                                    defaultValue: "Reload udev rules",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step2Desc",
                                  {
                                    defaultValue: "Apply the new rule without rebooting.",
                                  }
                                ),
                                cmds: [
                                  {
                                    cmd: "sudo udevadm control --reload-rules && sudo udevadm trigger /dev/uinput",
                                  },
                                ],
                              },
                            ],
                    },
                    {
                      key: "hasGroup",
                      label: t("settingsPage.general.waylandPaste.inputGroup", {
                        defaultValue: "input group",
                      }),
                      ok: ydotoolStatus.hasGroup,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.inputGroupDesc", {
                        defaultValue: "User must be in the input group (requires re-login)",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.group.step1Title", {
                            defaultValue: "Add your user to the input group",
                          }),
                          cmds: [{ cmd: "sudo usermod -aG input $USER" }],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.group.step2Title", {
                            defaultValue: "Log out and back in",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.group.step2Desc", {
                            defaultValue:
                              "Group changes only take effect after a new login session. Log out of your desktop and log back in, then reopen OpenWhispr.",
                          }),
                        },
                      ],
                    },
                    {
                      key: "hasService",
                      label: t("settingsPage.general.waylandPaste.service", {
                        defaultValue: "systemd service",
                      }),
                      ok: ydotoolStatus.hasService,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.serviceDesc", {
                        defaultValue: "User service file for auto-starting ydotoold",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.service.step1Title", {
                            defaultValue: "Create the service directory",
                          }),
                          cmds: [{ cmd: "mkdir -p ~/.config/systemd/user" }],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.service.step2Title", {
                            defaultValue: "Create the service file",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.service.step2Desc", {
                            defaultValue:
                              "This creates a user-level systemd service that starts ydotoold automatically when you log in.",
                          }),
                          cmds: [
                            {
                              cmd: `cat > ~/.config/systemd/user/ydotoold.service << 'EOF'
[Unit]
Description=ydotoold - ydotool daemon
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=/usr/bin/ydotoold
Restart=on-failure
RestartSec=1s

[Install]
WantedBy=graphical-session.target
EOF`,
                            },
                          ],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.service.step3Title", {
                            defaultValue: "Reload and enable",
                          }),
                          cmds: [
                            {
                              cmd: "systemctl --user daemon-reload && systemctl --user enable ydotoold",
                            },
                          ],
                        },
                      ],
                    },
                    {
                      key: "daemonRunning",
                      label: t("settingsPage.general.waylandPaste.daemon", {
                        defaultValue: "ydotoold daemon",
                      }),
                      ok: ydotoolStatus.daemonRunning,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.daemonDesc", {
                        defaultValue: "Background service must be running",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.daemon.step1Title", {
                            defaultValue: "Start the daemon",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.daemon.step1Desc", {
                            defaultValue: "Start ydotoold and enable it so it runs on every login.",
                          }),
                          cmds: [
                            {
                              cmd: "systemctl --user enable ydotoold && systemctl --user start ydotoold",
                            },
                            {
                              label: "Arch Linux (service is named ydotool.service)",
                              cmd: "systemctl --user enable --now ydotool.service",
                            },
                          ],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.daemon.step2Title", {
                            defaultValue: "Verify it's running",
                          }),
                          cmds: [
                            { cmd: "systemctl --user status ydotoold" },
                            {
                              label: "Arch Linux",
                              cmd: "systemctl --user status ydotool.service",
                            },
                          ],
                        },
                      ],
                    },
                  ];

                  if (ydotoolStatus.requiresWlCopy || ydotoolStatus.isKde) {
                    checks.push({
                      key: "hasWlCopy",
                      label: "wl-copy",
                      ok: ydotoolStatus.hasWlCopy,
                      required: ydotoolStatus.requiresWlCopy || ydotoolStatus.isKde,
                      desc: t("settingsPage.general.waylandPaste.wlCopyDesc"),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.wlCopy.step1Title"),
                          cmds: getLinuxPasteInstallCommands(t, "wl-clipboard"),
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.wlCopy.step2Title"),
                          cmds: [{ cmd: "which wl-copy" }],
                        },
                      ],
                    });
                  }

                  const allOk = checks.filter((c) => c.required).every((c) => c.ok);
                  const activeGuide = checks.find((c) => c.key === ydotoolGuideKey);

                  return (
                    <>
                      {allOk ? (
                        <SettingsPanel>
                          <SettingsPanelRow>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <CircleCheck className="h-4 w-4 text-emerald-500" />
                                <span className="text-sm">
                                  {t("settingsPage.general.waylandPaste.allGoodDesc", {
                                    defaultValue: "Auto-paste is ready to go.",
                                  })}
                                </span>
                              </div>
                              <button
                                onClick={refreshYdotoolStatus}
                                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                              >
                                <RotateCw className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </SettingsPanelRow>
                        </SettingsPanel>
                      ) : (
                        <>
                          <div className="rounded-xl border border-border overflow-hidden">
                            <div className="divide-y divide-border">
                              {checks.map((item) => (
                                <div key={item.key} className="px-4 py-3">
                                  <div className="flex items-center gap-2.5">
                                    {item.ok ? (
                                      <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" />
                                    ) : (
                                      <CircleX className="h-4 w-4 shrink-0 text-red-500" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <span className="text-sm font-medium">{item.label}</span>
                                      <span className="text-xs text-muted-foreground ms-2">
                                        {item.desc}
                                      </span>
                                      {item.note && (
                                        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                                          {item.note}
                                        </p>
                                      )}
                                    </div>
                                    {!item.ok && (
                                      <button
                                        onClick={() => setYdotoolGuideKey(item.key)}
                                        className="shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted transition-colors text-foreground"
                                      >
                                        <BookOpen className="w-3 h-3" />
                                        {t("settingsPage.general.waylandPaste.guide.open", {
                                          defaultValue: "Guide",
                                        })}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                          <button
                            onClick={refreshYdotoolStatus}
                            className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <RotateCw className="w-3 h-3" />
                            {t("settingsPage.general.waylandPaste.recheck", {
                              defaultValue: "Re-check",
                            })}
                          </button>
                        </>
                      )}

                      {/* Step-by-step guide dialog */}
                      <Dialog
                        open={!!activeGuide}
                        onOpenChange={(open) => !open && setYdotoolGuideKey(null)}
                      >
                        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
                          {activeGuide && (
                            <>
                              <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                  <BookOpen className="w-4 h-4" />
                                  {activeGuide.label}
                                </DialogTitle>
                                <DialogDescription>{activeGuide.desc}</DialogDescription>
                              </DialogHeader>
                              <div className="space-y-5 mt-2">
                                {activeGuide.steps.map((step, i) => (
                                  <div key={i}>
                                    <div className="flex items-start gap-3">
                                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">
                                        {i + 1}
                                      </span>
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium">{step.title}</p>
                                        {step.desc && (
                                          <p className="text-xs text-muted-foreground mt-0.5">
                                            {step.desc}
                                          </p>
                                        )}
                                        {step.cmds && step.cmds.length > 0 && (
                                          <div className="mt-2 space-y-2">
                                            {step.cmds.map((c, j) => (
                                              <div key={j}>
                                                {c.label && (
                                                  <p className="text-[11px] text-muted-foreground mb-1">
                                                    {c.label}
                                                  </p>
                                                )}
                                                <div className="flex items-start gap-1.5">
                                                  <pre
                                                    dir="ltr"
                                                    className="flex-1 text-[11px] bg-muted/60 rounded-md px-3 py-2 font-mono whitespace-pre-wrap break-all select-all overflow-x-auto"
                                                  >
                                                    {c.cmd}
                                                  </pre>
                                                  <button
                                                    onClick={() =>
                                                      navigator.clipboard.writeText(c.cmd)
                                                    }
                                                    className="shrink-0 p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                                                    title={t(
                                                      "settingsPage.general.waylandPaste.copy",
                                                      { defaultValue: "Copy" }
                                                    )}
                                                  >
                                                    <Copy className="w-3.5 h-3.5" />
                                                  </button>
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                        </DialogContent>
                      </Dialog>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        );

      case "hotkeys":
        return (
          <div className="space-y-6">
            {isUsingHyprland && hyprlandConfigStatus && !hyprlandConfigStatus.canWrite && (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertTitle>
                  {t("settingsPage.general.hotkey.hyprlandConfigWriteWarningTitle")}
                </AlertTitle>
                <AlertDescription>
                  <BidiInterpolatedText
                    text={t("settingsPage.general.hotkey.hyprlandConfigWriteWarningDescription", {
                      path: BIDI_VALUE_TOKEN,
                    })}
                    value={hyprlandConfigStatus.path}
                  />
                </AlertDescription>
              </Alert>
            )}
            {/* Dictation Hotkey */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.hotkey.title")}
                description={t("settingsPage.general.hotkey.description")}
                note={isUsingHyprland && t("settingsPage.general.hotkey.hyprlandUnbindDescription")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <HotkeyListInput
                    value={dictationKey}
                    onChange={(list) => registerHotkey(list)}
                    validate={validateDictationHotkey}
                    disabled={isHotkeyRegistering}
                    maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
                    required
                    footerEnd={
                      effectiveDefaultHotkey &&
                      dictationKey &&
                      dictationKey !== effectiveDefaultHotkey ? (
                        <button
                          onClick={() => registerHotkey(effectiveDefaultHotkey)}
                          disabled={isHotkeyRegistering}
                          className="text-xs text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-50"
                        >
                          <BidiInterpolatedText
                            text={t("settingsPage.general.hotkey.resetToDefault", {
                              hotkey: BIDI_VALUE_TOKEN,
                            })}
                            value={formatHotkeyLabel(effectiveDefaultHotkey)}
                          />
                        </button>
                      ) : null
                    }
                  />
                </SettingsPanelRow>

                {(!isUsingNativeShortcut || getCachedPlatform() === "linux") && (
                  <SettingsPanelRow>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-muted-foreground/80">
                        {t("settingsPage.general.hotkey.activationMode")}
                      </span>
                      <ActivationModeSelector
                        value={activationMode}
                        onChange={setActivationMode}
                        pushDisabledReason={pushToTalkUnavailableReason ?? undefined}
                      />
                    </div>
                    {/* Denied input access gets the setup box below instead. */}
                    {pushToTalkUnavailableReason && !linuxInputAccessDenied && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {pushToTalkUnavailableReason}
                      </p>
                    )}
                    {getCachedPlatform() === "linux" &&
                      (activationMode === "push" || linuxInputAccessDenied) && (
                        <LinuxPttSetupInfo
                          isAvailable={!linuxInputAccessDenied && linuxPttAvailable}
                        />
                      )}
                  </SettingsPanelRow>
                )}
              </SettingsPanel>
            </div>
          </div>
        );

      case "speechToText":
        return null;

      case "privacyData":
        return (
          <div className="space-y-6">
            {/* Audio Retention */}
            <div>
              <SectionHeader
                title={t("settingsPage.privacy.audioRetention")}
                description={t("settingsPage.privacy.audioRetentionDescription")}
              />

              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.audioRetention")}
                    description={t("settingsPage.privacy.audioRetentionDescription")}
                  >
                    <select
                      value={enforcedAudioRetentionDays}
                      onChange={(e) => {
                        const days = parseInt(e.target.value, 10);
                        if (audioRetentionCap !== null && days > audioRetentionCap) return;
                        setAudioRetentionDays(days);
                      }}
                      className={RETENTION_SELECT_CLASS}
                    >
                      <option value={0}>{t("settingsPage.privacy.audioRetentionDisabled")}</option>
                      {enforcedAudioRetentionDays > 0 &&
                        !RETENTION_DAY_OPTIONS.includes(enforcedAudioRetentionDays) && (
                          <option value={enforcedAudioRetentionDays}>
                            {t("settingsPage.privacy.retentionDays", {
                              count: enforcedAudioRetentionDays,
                            })}
                          </option>
                        )}
                      {RETENTION_DAY_OPTIONS.map((days) => (
                        <option
                          key={days}
                          value={days}
                          disabled={audioRetentionCap !== null && days > audioRetentionCap}
                        >
                          {t("settingsPage.privacy.retentionDays", { count: days })}
                        </option>
                      ))}
                    </select>
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.audioStorageUsage")}
                    description={
                      audioStorageUsage.fileCount > 0
                        ? t("settingsPage.privacy.audioStorageHistoryFiles", {
                            count: audioStorageUsage.fileCount,
                            size: formatBytes(audioStorageUsage.totalBytes),
                          })
                        : t("settingsPage.privacy.audioStorageHistoryEmpty")
                    }
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={audioStorageUsage.fileCount === 0}
                      onClick={handleClearAllAudio}
                    >
                      {t("settingsPage.privacy.clearHistoryAudio")}
                    </Button>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Data Retention */}
            <div className="border-t border-border/70 pt-6">
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.dataRetention")}
                    description={
                      historyLockedByPolicy
                        ? t("common.managedByOrg")
                        : t("settingsPage.privacy.dataRetentionDescription")
                    }
                  >
                    <Toggle
                      checked={effectiveDataRetentionEnabled}
                      disabled={historyLockedByPolicy}
                      onChange={setDataRetentionEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.transcriptRetention")}
                    description={t("settingsPage.privacy.transcriptRetentionDescription")}
                  >
                    <select
                      value={transcriptRetentionDays}
                      disabled={!effectiveDataRetentionEnabled}
                      onChange={(e) => {
                        setTranscriptRetentionDays(parseInt(e.target.value, 10));
                        // A shorter period may remove counters, and Insights would otherwise
                        // open on the kept totals that still count them.
                        clearInsightsCache();
                      }}
                      className={RETENTION_SELECT_CLASS}
                    >
                      <option value={0}>
                        {t("settingsPage.privacy.transcriptRetentionForever")}
                      </option>
                      {RETENTION_DAY_OPTIONS.map((days) => (
                        <option key={days} value={days}>
                          {t("settingsPage.privacy.retentionDays", { count: days })}
                        </option>
                      ))}
                    </select>
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.saveDiscarded")}
                    description={t("settingsPage.privacy.saveDiscardedDescription")}
                  >
                    <Toggle
                      checked={saveDiscardedTranscriptions}
                      disabled={!effectiveDataRetentionEnabled || enforcedAudioRetentionDays === 0}
                      onChange={setSaveDiscardedTranscriptions}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Permissions */}
            <div className="border-t border-border/70 pt-6">
              <SectionHeader
                title={t("settingsPage.permissions.title")}
                description={t("settingsPage.permissions.description")}
              />

              <div className="space-y-3">
                <PermissionCard
                  icon={Mic}
                  title={t("settingsPage.permissions.microphoneTitle")}
                  description={t("settingsPage.permissions.microphoneDescription")}
                  granted={permissionsHook.micPermissionGranted}
                  onRequest={permissionsHook.requestMicPermission}
                  buttonText={t("settingsPage.permissions.grantAccess")}
                />

                {(platform === "darwin" || canManageSystemAudioInApp(systemAudio)) && (
                  <>
                    {platform === "darwin" && (
                      <PermissionCard
                        icon={Shield}
                        title={t("settingsPage.permissions.accessibilityTitle")}
                        description={t("settingsPage.permissions.accessibilityDescription")}
                        granted={permissionsHook.accessibilityPermissionGranted}
                        onRequest={permissionsHook.requestAccessibilityPermission}
                        buttonText={t("settingsPage.permissions.grantAccess")}
                      />
                    )}
                    {canManageSystemAudioInApp(systemAudio) && (
                      <PermissionCard
                        icon={Monitor}
                        title={t("settingsPage.permissions.systemAudioTitle")}
                        description={t("settingsPage.permissions.systemAudioDescription")}
                        granted={systemAudio.granted}
                        onRequest={systemAudio.request}
                        buttonText={t("settingsPage.permissions.grantAccess")}
                        badge={t("settingsPage.permissions.optional")}
                      />
                    )}
                  </>
                )}
              </div>

              {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
                <MicPermissionWarning
                  error={permissionsHook.micPermissionError}
                  onOpenSoundSettings={permissionsHook.openSoundInputSettings}
                  onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
                />
              )}

              {platform === "linux" &&
                permissionsHook.pasteToolsInfo &&
                needsLinuxPasteToolGuidance(permissionsHook.pasteToolsInfo) && (
                  <PasteToolsInfo
                    pasteToolsInfo={permissionsHook.pasteToolsInfo}
                    isChecking={permissionsHook.isCheckingPasteTools}
                    onCheck={permissionsHook.checkPasteToolsAvailability}
                  />
                )}

              {platform === "darwin" && (
                <div className="mt-5">
                  <p className="text-xs font-medium text-foreground mb-3">
                    {t("settingsPage.permissions.troubleshootingTitle")}
                  </p>
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settingsPage.permissions.resetAccessibility.label")}
                        description={t(
                          "settingsPage.permissions.resetAccessibility.rowDescription"
                        )}
                      >
                        <Button
                          onClick={resetAccessibilityPermissions}
                          variant="ghost"
                          size="sm"
                          className="text-foreground/70 hover:text-foreground"
                        >
                          {t("settingsPage.permissions.troubleshoot")}
                        </Button>
                      </SettingsRow>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>
              )}
            </div>
          </div>
        );

      case "system":
        return (
          <div className="space-y-6">
            {/* Developer Tools */}
            <div>
              <DeveloperSection />
            </div>

            {/* Data Management */}
            <div className="border-t border-border/70 pt-6">
              <SectionHeader
                title={t("settingsPage.developer.dataManagementTitle")}
                description={t("settingsPage.developer.dataManagementDescription")}
              />

              <div className="space-y-4">
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.modelCache")}
                      description={
                        <span dir="ltr" className="block break-all">
                          {cachePathHint}
                        </span>
                      }
                    >
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => window.electronAPI?.openWhisperModelsFolder?.()}
                        >
                          <FolderOpen className="me-1.5 h-3.5 w-3.5" />
                          {t("settingsPage.developer.open")}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={handleRemoveModels}
                          disabled={isRemovingModels}
                        >
                          {isRemovingModels
                            ? t("settingsPage.developer.removing")
                            : t("settingsPage.developer.clearCache")}
                        </Button>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.resetAppData")}
                      description={t("settingsPage.developer.resetAppDataDescription")}
                    >
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: t("settingsPage.developer.resetAll.title"),
                            description: t("settingsPage.developer.resetAll.description"),
                            onConfirm: async () => {
                              try {
                                try {
                                  undefined;
                                } catch {}
                                await window.electronAPI?.cleanupApp();
                                showAlertDialog({
                                  title: t("settingsPage.developer.resetAll.successTitle"),
                                  description: t(
                                    "settingsPage.developer.resetAll.successDescription"
                                  ),
                                });
                                setTimeout(() => window.electronAPI?.relaunchApp(), 1000);
                              } catch {
                                showAlertDialog({
                                  title: t("settingsPage.developer.resetAll.failedTitle"),
                                  description: t(
                                    "settingsPage.developer.resetAll.failedDescription"
                                  ),
                                });
                              }
                            },
                            variant: "destructive",
                            confirmText: t("settingsPage.developer.resetAll.confirmText"),
                          });
                        }}
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                      >
                        {t("common.reset")}
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Mounted on first visit and kept alive so model-download progress and IPC listeners survive section switches. */}
      {hasMountedSpeechToText && (
        <TabPanel active={activeSection === "speechToText"}>
          <SpeechToTextTabs
            initialTab={
              activeSection === "speechToText"
                ? (initialSubTab as SpeechTab | undefined)
                : undefined
            }
            renderDictation={() => (
              <div className="space-y-6">
                <TranscriptionSection
                  isSignedIn={isSignedIn ?? false}
                  cloudTranscriptionMode={cloudTranscriptionMode}
                  setCloudTranscriptionMode={setCloudTranscriptionMode}
                  useLocalWhisper={useLocalWhisper}
                  setUseLocalWhisper={setUseLocalWhisper}
                  updateTranscriptionSettings={updateTranscriptionSettings}
                  cloudTranscriptionProvider={cloudTranscriptionProvider}
                  setCloudTranscriptionProvider={setCloudTranscriptionProvider}
                  cloudTranscriptionModel={cloudTranscriptionModel}
                  setCloudTranscriptionModel={setCloudTranscriptionModel}
                  localTranscriptionProvider={localTranscriptionProvider}
                  setLocalTranscriptionProvider={setLocalTranscriptionProvider}
                  whisperModel={whisperModel}
                  setWhisperModel={setWhisperModel}
                  parakeetModel={parakeetModel}
                  setParakeetModel={setParakeetModel}
                  cohereModel={cohereModel}
                  setCohereModel={setCohereModel}
                  cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
                  setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
                  transcriptionMode={transcriptionMode}
                  setTranscriptionMode={setTranscriptionMode}
                  remoteTranscriptionUrl={remoteTranscriptionUrl}
                  setRemoteTranscriptionUrl={setRemoteTranscriptionUrl}
                  remoteTranscriptionModel={remoteTranscriptionModel}
                  setRemoteTranscriptionModel={setRemoteTranscriptionModel}
                  showTranscriptionPreview={showTranscriptionPreview}
                  setShowTranscriptionPreview={setShowTranscriptionPreview}
                  toast={toast}
                />
              </div>
            )}
            renderNoteRecording={() => (
              <div className="space-y-6">
                <MeetingTranscriptionPanel />
              </div>
            )}
            renderUpload={() => (
              <div className="space-y-6">
                <UploadTranscriptionPanel />
              </div>
            )}
          />
        </TabPanel>
      )}
      {renderSectionContent()}
    </>
  );
}
