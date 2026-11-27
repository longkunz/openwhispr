const { contextBridge, ipcRenderer, webUtils } = require("electron");

// BYOK API-key bridges, built once instead of hand-listed per key. Sandboxed
// preloads can't require local modules, so the {base, get, save} tuples are
// inlined here; keep them in sync with the BYOK_API_KEYS manifest in
// src/config/secretKeys.js (the main process derives its plumbing from that).
const BYOK_KEY_BRIDGES = [
  { base: "openai", get: "getOpenAIKey", save: "saveOpenAIKey" },
  { base: "anthropic", get: "getAnthropicKey", save: "saveAnthropicKey" },
  { base: "gemini", get: "getGeminiKey", save: "saveGeminiKey" },
  { base: "groq", get: "getGroqKey", save: "saveGroqKey" },
  { base: "xai", get: "getXaiKey", save: "saveXaiKey" },
  { base: "mistral", get: "getMistralKey", save: "saveMistralKey" },
  { base: "openrouter", get: "getOpenrouterKey", save: "saveOpenrouterKey" },
  { base: "tinfoil", get: "getTinfoilKey", save: "saveTinfoilKey" },
  { base: "corti", get: "getCortiKey", save: "saveCortiKey" },
  { base: "deepgram", get: "getDeepgramKey", save: "saveDeepgramKey" },
  { base: "assemblyai", get: "getAssemblyAIKey", save: "saveAssemblyAIKey" },
  { base: "elevenlabs", get: "getElevenlabsKey", save: "saveElevenlabsKey" },
  {
    base: "note-formatting-custom",
    get: "getNoteFormattingCustomKey",
    save: "saveNoteFormattingCustomKey",
  },
  { base: "translation-custom", get: "getTranslationCustomKey", save: "saveTranslationCustomKey" },
  {
    base: "dictation-agent-custom",
    get: "getDictationAgentCustomKey",
    save: "saveDictationAgentCustomKey",
  },
  {
    base: "dictation-agent-vision-custom",
    get: "getDictationAgentVisionCustomKey",
    save: "saveDictationAgentVisionCustomKey",
  },
  { base: "chat-agent-custom", get: "getChatAgentCustomKey", save: "saveChatAgentCustomKey" },
];
const secretKeyApi = {};
for (const k of BYOK_KEY_BRIDGES) {
  secretKeyApi[k.get] = () => ipcRenderer.invoke(`get-${k.base}-key`);
  secretKeyApi[k.save] = (key) => ipcRenderer.invoke(`save-${k.base}-key`, key);
}

/**
 * Helper to register an IPC listener and return a cleanup function.
 * Ensures renderer code can easily remove listeners to avoid leaks.
 */
const registerListener = (channel, handlerFactory) => {
  return (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }

    const listener =
      typeof handlerFactory === "function"
        ? handlerFactory(callback)
        : (event, ...args) => callback(event, ...args);

    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
};

contextBridge.exposeInMainWorld("electronAPI", {
  initialModelRegistrySnapshot: ipcRenderer.sendSync?.("model-registry-initial"),
  getModelRegistry: () => ipcRenderer.invoke("get-model-registry"),
  onModelRegistryUpdated: registerListener(
    "model-registry-updated",
    (callback) => (_event, snapshot) => callback(snapshot)
  ),
  setOnboardingWindowMode: (mode) => ipcRenderer.invoke("onboarding-set-window-mode", mode),
  setOnboardingActive: (active) => ipcRenderer.invoke("onboarding-set-active", active),
  openPermissionGuide: (state) => ipcRenderer.invoke("permission-guide-open", state),
  closePermissionGuide: () => ipcRenderer.invoke("permission-guide-close"),
  getPermissionGuideState: () => ipcRenderer.invoke("permission-guide-state"),
  permissionGuideAction: (action) => ipcRenderer.send("permission-guide-action", action),
  startPermissionGuideDrag: (target) => ipcRenderer.send("permission-guide-drag", target),
  onPermissionGuideState: registerListener(
    "permission-guide-state-changed",
    (callback) => (_event, state) => callback(state)
  ),
  onPermissionGuideAction: registerListener(
    "permission-guide-action",
    (callback) => (_event, action) => callback(action)
  ),
  onAgentWindowHotkey: registerListener(
    "agent-window-hotkey",
    (callback) => (_event, payload) => callback(payload)
  ),
  onAgentWindowOpen: registerListener(
    "agent-window-open",
    (callback) => (_event, payload) => callback(payload)
  ),
  onAgentWindowCommand: registerListener(
    "agent-window-command",
    (callback) => (_event, command) => callback(command)
  ),
  onAgentWindowDismiss: registerListener("agent-window-dismiss", (callback) => () => callback()),
  onAgentRecordingChanged: registerListener(
    "agent-recording-changed",
    (callback) => (_event, recording) => callback(recording)
  ),
  markMacAccessibilityFeaturesReady: (expectedAccountScope) =>
    expectedAccountScope
      ? ipcRenderer.send("mac-accessibility-features-ready", expectedAccountScope)
      : ipcRenderer.send("mac-accessibility-features-ready"),
  onOnboardingDemoEvent: registerListener(
    "onboarding-demo-event",
    (callback) => (_event, payload) => callback(payload)
  ),
  testProviderConnection: (config) => ipcRenderer.invoke("test-provider-connection", config),
  pasteText: (text, options) => ipcRenderer.invoke("paste-text", text, options),
  captureSelectedText: (options) => ipcRenderer.invoke("capture-selected-text", options),
  cancelSelectionEdit: (sessionId) => ipcRenderer.invoke("cancel-selection-edit", sessionId),
  replaceSelectedText: (sessionId, text, options) =>
    ipcRenderer.invoke("replace-selected-text", sessionId, text, options),
  pasteAtCapturedTarget: (sessionId, text) =>
    ipcRenderer.invoke("paste-at-captured-target", sessionId, text),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  showDictationPanel: () => ipcRenderer.invoke("show-dictation-panel"),
  openSettingsSection: (section) => ipcRenderer.invoke("open-settings-section", section),
  captureDictationTarget: () => ipcRenderer.invoke("capture-dictation-target"),
  captureDictationAppCategory: () => ipcRenderer.invoke("capture-dictation-app-category"),
  onToggleDictation: registerListener("toggle-dictation", (callback) => () => callback()),
  onToggleVoiceAgent: registerListener("toggle-voice-agent", (callback) => () => callback()),
  onToggleTranslation: registerListener("toggle-translation", (callback) => () => callback()),
  onMeetingStartRefused: registerListener(
    "meeting-start-refused",
    (callback) => (_event, code) => callback(code)
  ),
  onStartDictation: registerListener("start-dictation", (callback) => () => callback()),
  onStopDictation: registerListener("stop-dictation", (callback) => () => callback()),
  onPrepareDictation: registerListener("prepare-dictation", (callback) => () => callback()),
  onCancelDictationPreparation: registerListener(
    "cancel-dictation-preparation",
    (callback) => () => callback()
  ),
  onDictationForceStopped: registerListener(
    "dictation-force-stopped",
    (callback) => (_event, payload) => callback(payload)
  ),
  micWarmHoldChanged: (active) => ipcRenderer.send("mic-warm-hold-changed", active),
  dictationLifecycleStateChanged: (state, attempt, voiceAgentRequested = false) =>
    ipcRenderer.invoke("dictation-lifecycle-state-changed", state, attempt, voiceAgentRequested),

  // Database functions
  saveTranscription: (text, rawText, options) =>
    ipcRenderer.invoke("db-save-transcription", text, rawText, options),
  getTranscriptions: (limit, options) =>
    ipcRenderer.invoke("db-get-transcriptions", limit, options),
  recordAnalyticsEvent: (input) => ipcRenderer.invoke("analytics-record-event", input),
  getAnalyticsSummary: () => ipcRenderer.invoke("analytics-get-summary"),
  clearTranscriptions: () => ipcRenderer.invoke("db-clear-transcriptions"),
  deleteTranscription: (id) => ipcRenderer.invoke("db-delete-transcription", id),

  // Audio storage functions
  saveTranscriptionAudio: (id, audioBuffer, metadata) =>
    ipcRenderer.invoke("save-transcription-audio", id, audioBuffer, metadata),
  mergeAudioSegments: (segments) => ipcRenderer.invoke("merge-audio-segments", segments),
  getAudioPath: (id) => ipcRenderer.invoke("get-audio-path", id),
  showAudioInFolder: (id) => ipcRenderer.invoke("show-audio-in-folder", id),
  getAudioBuffer: (id) => ipcRenderer.invoke("get-audio-buffer", id),
  deleteTranscriptionAudio: (id) => ipcRenderer.invoke("delete-transcription-audio", id),
  getAudioStorageUsage: () => ipcRenderer.invoke("get-audio-storage-usage"),
  deleteAllAudio: () => ipcRenderer.invoke("delete-all-audio"),
  syncRetentionSettings: (settings) => ipcRenderer.send("retention-settings-changed", settings),
  retryTranscription: (id, settings) => ipcRenderer.invoke("retry-transcription", id, settings),
  updateTranscriptionText: (id, text, rawText) =>
    ipcRenderer.invoke("update-transcription-text", id, text, rawText),
  getTranscriptionById: (id) => ipcRenderer.invoke("get-transcription-by-id", id),
  onSnippetsUpdated: (callback) => {
    const listener = (_event, snippets) => callback?.(snippets);
    ipcRenderer.on("snippets-updated", listener);
    return () => ipcRenderer.removeListener("snippets-updated", listener);
  },

  // Note functions
  saveNote: (
    title,
    content,
    noteType,
    sourceFile,
    audioDuration,
    folderId,
    spaceId,
    transcript,
    writeGuard
  ) =>
    ipcRenderer.invoke(
      "db-save-note",
      title,
      content,
      noteType,
      sourceFile,
      audioDuration,
      folderId,
      spaceId,
      transcript,
      writeGuard
    ),
  getNote: (id) => ipcRenderer.invoke("db-get-note", id),
  getNotes: (noteType, limit, folderId, spaceId, spaceIds) =>
    ipcRenderer.invoke("db-get-notes", noteType, limit, folderId, spaceId, spaceIds),
  getSpaceNotes: (spaceId, limit) => ipcRenderer.invoke("db-get-space-notes", spaceId, limit),
  updateNote: (id, updates, options) => ipcRenderer.invoke("db-update-note", id, updates, options),
  deleteNote: (id) => ipcRenderer.invoke("db-delete-note", id),
  exportNote: (noteId, format) => ipcRenderer.invoke("export-note", noteId, format),
  exportTranscript: (noteId, format, options) =>
    ipcRenderer.invoke("export-transcript", noteId, format, options),
  searchNotes: (query, limit, spaceId, folderId, spaceIds) =>
    ipcRenderer.invoke("db-search-notes", query, limit, spaceId, folderId, spaceIds),
  updateNoteShareState: (id, state) => ipcRenderer.invoke("db-update-note-share-state", id, state),

  // Folder functions
  getFolders: (spaceId) => ipcRenderer.invoke("db-get-folders", spaceId),
  getDeviceNotes: () => ipcRenderer.invoke("db-get-device-notes"),
  getDeviceNote: (id) => ipcRenderer.invoke("db-get-device-note", id),
  moveDeviceNotes: (request) => ipcRenderer.invoke("db-move-device-notes", request),
  getStandInOwnershipCandidates: () => ipcRenderer.invoke("db-get-stand-in-ownership-candidates"),
  resolveStandInOwnership: (request) =>
    ipcRenderer.invoke("db-resolve-stand-in-ownership", request),
  createFolder: (name, spaceId, writeGuard, parentFolderId) =>
    ipcRenderer.invoke("db-create-folder", name, spaceId, writeGuard, parentFolderId),
  deleteFolder: (id) => ipcRenderer.invoke("db-delete-folder", id),
  renameFolder: (id, name) => ipcRenderer.invoke("db-rename-folder", id, name),
  moveFolderToSpace: (id, spaceId) => ipcRenderer.invoke("db-move-folder-to-space", id, spaceId),
  setFolderParent: (id, parentFolderId, writeGuard) =>
    ipcRenderer.invoke("db-set-folder-parent", id, parentFolderId, writeGuard),
  getFolderNoteCounts: () => ipcRenderer.invoke("db-get-folder-note-counts"),

  // Space functions
  getSpaces: () => ipcRenderer.invoke("db-get-spaces"),
  hasOtherAccountRows: () => ipcRenderer.invoke("db-has-other-account-rows"),
  accountChangedSince: (occurredAt) => ipcRenderer.invoke("db-account-changed-since", occurredAt),
  hasUnclaimedLegacyRows: () => ipcRenderer.invoke("db-has-unclaimed-legacy-rows"),
  getPrivateSpaceId: (workspaceId, authGeneration) =>
    ipcRenderer.invoke("get-private-space-id", workspaceId, authGeneration),
  getDefaultPrivateSpaceId: (authGeneration) =>
    ipcRenderer.invoke("get-default-private-space-id", authGeneration),
  getActiveAccountScope: () => ipcRenderer.invoke("get-active-account-scope"),
  getNoteWriteGuard: () => ipcRenderer.invoke("get-note-write-guard"),
  getDatabaseAccountScope: () => ipcRenderer.invoke("get-database-account-scope"),
  onDatabaseAccountScopeChanged: registerListener(
    "database-account-scope-changed",
    (callback) => (_event, scope) => callback(scope)
  ),
  onDeviceNotesChanged: registerListener("device-notes-changed", (callback) => () => callback()),
  onActiveAccountScopeChanged: registerListener(
    "active-account-scope-changed",
    (callback) => (_event, scope) => callback(scope)
  ),
  deleteAccountData: (accountId, expectedAuthGeneration, options) =>
    ipcRenderer.invoke("delete-account-data", accountId, expectedAuthGeneration, options),
  updateSpace: (id, updates) => ipcRenderer.invoke("db-update-space", id, updates),
  purgeSpace: (id, options) => ipcRenderer.invoke("db-purge-space", id, options),
  setSpaceSyncStatus: (id, status) => ipcRenderer.invoke("db-set-space-sync-status", id, status),
  onSpacePurged: (callback) => {
    const listener = (_event, payload) => callback?.(payload);
    ipcRenderer.on("space-purged", listener);
    return () => ipcRenderer.removeListener("space-purged", listener);
  },
  onSpaceSynced: (callback) => {
    const listener = (_event, space) => callback?.(space);
    ipcRenderer.on("space-synced", listener);
    return () => ipcRenderer.removeListener("space-synced", listener);
  },

  // Note files (markdown mirror) functions
  noteFilesSetEnabled: (enabled, customPath, options) =>
    ipcRenderer.invoke("note-files-set-enabled", enabled, customPath, options),
  noteFilesSetPath: (path) => ipcRenderer.invoke("note-files-set-path", path),
  noteFilesRebuild: () => ipcRenderer.invoke("note-files-rebuild"),
  noteFilesSetWorkspaceNames: (workspaces) =>
    ipcRenderer.invoke("note-files-set-workspace-names", workspaces),
  noteFilesGetDefaultPath: () => ipcRenderer.invoke("note-files-get-default-path"),
  noteFilesPickFolder: () => ipcRenderer.invoke("note-files-pick-folder"),
  dragonImportPickFile: () => ipcRenderer.invoke("dragon-import-pick-file"),
  showNoteFile: (noteId) => ipcRenderer.invoke("show-note-file", noteId),
  showFolderInExplorer: (folderId) => ipcRenderer.invoke("show-folder-in-explorer", folderId),

  // Audio file operations
  selectAudioFile: (options) => ipcRenderer.invoke("select-audio-file", options),
  getFileSize: (filePath) => ipcRenderer.invoke("get-file-size", filePath),
  getPathForFile: (file) => {
    const filePath = webUtils.getPathForFile(file);
    // Register real dropped-file paths so the main-process audio allowlist accepts them.
    if (filePath) ipcRenderer.send("approve-audio-path", filePath);
    return filePath;
  },

  // URL audio download
  downloadUrlAudio: (url, downloadId) => ipcRenderer.invoke("download-url-audio", url, downloadId),
  cancelUrlDownload: (downloadId) => ipcRenderer.invoke("cancel-url-download", downloadId),
  deleteTempFile: (filePath) => ipcRenderer.invoke("delete-temp-file", filePath),
  onUrlDownloadProgress: registerListener(
    "url-download-progress",
    (callback) => (_event, data) => callback(data)
  ),

  onNoteAdded: (callback) => {
    const listener = (_event, note) => callback?.(note);
    ipcRenderer.on("note-added", listener);
    return () => ipcRenderer.removeListener("note-added", listener);
  },
  onNoteUpdated: (callback) => {
    const listener = (_event, note) => callback?.(note);
    ipcRenderer.on("note-updated", listener);
    return () => ipcRenderer.removeListener("note-updated", listener);
  },
  onNoteDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("note-deleted", listener);
    return () => ipcRenderer.removeListener("note-deleted", listener);
  },
  onNoteSynced: (callback) => {
    const listener = (_event, note) => callback?.(note);
    ipcRenderer.on("note-synced", listener);
    return () => ipcRenderer.removeListener("note-synced", listener);
  },
  onFolderSynced: (callback) => {
    const listener = (_event, folder) => callback?.(folder);
    ipcRenderer.on("folder-synced", listener);
    return () => ipcRenderer.removeListener("folder-synced", listener);
  },
  onFolderDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("folder-deleted", listener);
    return () => ipcRenderer.removeListener("folder-deleted", listener);
  },
  onSyncEvent: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("sync-event", listener);
    return () => ipcRenderer.removeListener("sync-event", listener);
  },

  onActionCreated: (callback) => {
    const listener = (_event, action) => callback?.(action);
    ipcRenderer.on("action-created", listener);
    return () => ipcRenderer.removeListener("action-created", listener);
  },
  onActionUpdated: (callback) => {
    const listener = (_event, action) => callback?.(action);
    ipcRenderer.on("action-updated", listener);
    return () => ipcRenderer.removeListener("action-updated", listener);
  },
  onActionDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("action-deleted", listener);
    return () => ipcRenderer.removeListener("action-deleted", listener);
  },

  onTranscriptionAdded: (callback) => {
    const listener = (_event, transcription) => callback?.(transcription);
    ipcRenderer.on("transcription-added", listener);
    return () => ipcRenderer.removeListener("transcription-added", listener);
  },
  onTranscriptionDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcription-deleted", listener);
    return () => ipcRenderer.removeListener("transcription-deleted", listener);
  },
  onTranscriptionsCleared: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcriptions-cleared", listener);
    return () => ipcRenderer.removeListener("transcriptions-cleared", listener);
  },
  onTranscriptionUpdated: (callback) => {
    const listener = (_event, transcription) => callback?.(transcription);
    ipcRenderer.on("transcription-updated", listener);
    return () => ipcRenderer.removeListener("transcription-updated", listener);
  },
  onAnalyticsChanged: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("analytics-changed", listener);
    return () => ipcRenderer.removeListener("analytics-changed", listener);
  },

  // BYOK API keys (get/save for every provider in the secretKeys manifest)
  ...secretKeyApi,

  // Clipboard functions
  checkAccessibilityPermission: (silent) =>
    ipcRenderer.invoke("check-accessibility-permission", silent),
  promptAccessibilityPermission: () => ipcRenderer.invoke("prompt-accessibility-permission"),
  readClipboard: () => ipcRenderer.invoke("read-clipboard"),
  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),
  checkPasteTools: () => ipcRenderer.invoke("check-paste-tools"),

  // Voice drafts (chat input recordings)
  saveTempAudio: (buffer) => ipcRenderer.invoke("save-temp-audio", buffer),
  deleteTempAudio: (tempPath) => ipcRenderer.invoke("delete-temp-audio", tempPath),
  checkFFmpegAvailability: () => ipcRenderer.invoke("check-ffmpeg-availability"),
  getAudioDiagnostics: () => ipcRenderer.invoke("get-audio-diagnostics"),

  // Speaker name mapping
  getSpeakerMappings: (noteId) => ipcRenderer.invoke("get-speaker-mappings", noteId),
  setSpeakerMapping: (noteId, speakerId, displayName, email, profileId) =>
    ipcRenderer.invoke("set-speaker-mapping", noteId, speakerId, displayName, email, profileId),
  removeSpeakerMapping: (noteId, speakerId) =>
    ipcRenderer.invoke("remove-speaker-mapping", noteId, speakerId),
  getSpeakerProfiles: () => ipcRenderer.invoke("get-speaker-profiles"),
  attachSpeakerEmail: (profileId, email) =>
    ipcRenderer.invoke("attach-speaker-email", profileId, email),
  saveNoteSpeakerEmbeddings: (noteId, embeddings) =>
    ipcRenderer.invoke("save-note-speaker-embeddings", noteId, embeddings),

  // Window control functions
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  snapToMeetingMode: () => ipcRenderer.invoke("snap-to-meeting-mode"),
  restoreFromMeetingMode: () => ipcRenderer.invoke("restore-from-meeting-mode"),
  meetingNoteOpenedWithoutRecording: (id) =>
    ipcRenderer.invoke("meeting-note-opened-without-recording", id),
  meetingNoteClosed: (id) => ipcRenderer.invoke("meeting-note-closed", id),
  getPlatform: () => process.platform,

  // Cleanup function
  cleanupApp: () => ipcRenderer.invoke("cleanup-app"),
  relaunchApp: () => ipcRenderer.invoke("relaunch-app"),
  updateHotkey: (hotkey) => ipcRenderer.invoke("update-hotkey", hotkey),
  setHotkeyListeningMode: (enabled) => ipcRenderer.invoke("set-hotkey-listening-mode", enabled),
  getHotkeyModeInfo: (hotkey) => ipcRenderer.invoke("get-hotkey-mode-info", hotkey),
  getHyprlandConfigStatus: () => ipcRenderer.invoke("get-hyprland-config-status"),
  startWindowDrag: () => ipcRenderer.invoke("start-window-drag"),
  stopWindowDrag: () => ipcRenderer.invoke("stop-window-drag"),
  startControlPanelDrag: () => ipcRenderer.invoke("start-control-panel-drag"),
  onControlPanelReleaseRequested: registerListener(
    "control-panel-release-requested",
    (callback) => (_event, requestId) => callback(requestId)
  ),
  controlPanelReleaseReady: (requestId, ready) =>
    ipcRenderer.send("control-panel-release-ready", requestId, ready),
  stopControlPanelDrag: () => ipcRenderer.invoke("stop-control-panel-drag"),
  getMainWindowHorizontalDirection: () =>
    ipcRenderer.invoke("get-main-window-horizontal-direction"),
  onMainWindowHorizontalDirectionChanged: registerListener(
    "main-window-horizontal-direction-changed",
    (callback) => (_event, direction) => callback(direction)
  ),
  onMainWindowWillResize: registerListener(
    "main-window-will-resize",
    (callback) => (_event, resize) => callback(resize)
  ),
  ackMainWindowResizeMask: (token) => ipcRenderer.send("main-window-resize-mask-ready", token),
  setMainWindowInteractivity: (interactive) =>
    ipcRenderer.invoke("set-main-window-interactivity", interactive),
  setMainWindowInputRegion: (region) => ipcRenderer.invoke("set-main-window-input-region", region),
  onMainWindowVisibilityChanged: registerListener(
    "main-window-visibility-changed",
    (callback) => (_event, visible) => callback(visible)
  ),
  setNotificationInteractivity: (interactive) =>
    ipcRenderer.invoke("set-notification-interactivity", interactive),
  resizeMainWindow: (sizeKey) => ipcRenderer.invoke("resize-main-window", sizeKey),
  resizeAssistantWindowToContent: (surfaceHeight) =>
    ipcRenderer.invoke("resize-assistant-window-to-content", surfaceHeight),
  resizeDictationErrorWindowToContent: (surfaceHeight) =>
    ipcRenderer.invoke("resize-dictation-error-window-to-content", surfaceHeight),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getPostMigrationState: () => ipcRenderer.invoke("get-post-migration-state"),
  markBundleMigrated: () => ipcRenderer.invoke("mark-bundle-migrated"),
  markBundleMigrationDismissed: () => ipcRenderer.invoke("mark-bundle-migration-dismissed"),

  // Update event listeners
  onUpdateStatusChanged: registerListener(
    "update-status-changed",
    (callback) => (_event, status) => callback(status)
  ),
  onUpdateAvailable: registerListener("update-available"),
  onUpdateNotAvailable: registerListener("update-not-available"),
  onUpdateDownloaded: registerListener("update-downloaded"),
  onUpdateDownloadProgress: registerListener("update-download-progress"),
  onUpdateError: registerListener("update-error"),

  // Audio event listeners
  onCancelHotkeyPressed: registerListener("cancel-hotkey-pressed", (cb) => () => cb()),
  registerCancelHotkey: (key) => ipcRenderer.invoke("register-cancel-hotkey", key),
  unregisterCancelHotkey: () => ipcRenderer.invoke("unregister-cancel-hotkey"),

  // External link opener
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  getUiLanguage: () => ipcRenderer.invoke("get-ui-language"),
  saveUiLanguage: (language) => ipcRenderer.invoke("save-ui-language", language),
  setUiLanguage: (language) => ipcRenderer.invoke("set-ui-language", language),

  // xAI / AssemblyAI / Mistral transcription proxies (keys handled by the manifest bridge)
  proxyXaiTranscription: (data) => ipcRenderer.invoke("proxy-xai-transcription", data),
  proxyAssemblyAiTranscription: (data) =>
    ipcRenderer.invoke("proxy-assemblyai-transcription", data),
  proxyMistralTranscription: (data) => ipcRenderer.invoke("proxy-mistral-transcription", data),
  proxyGeminiTranscription: (data) => ipcRenderer.invoke("proxy-gemini-transcription", data),
  proxyElevenlabsTranscription: (data) =>
    ipcRenderer.invoke("proxy-elevenlabs-transcription", data),

  // Corti API
  getCortiClientId: () => ipcRenderer.invoke("get-corti-client-id"),
  saveCortiClientId: (key) => ipcRenderer.invoke("save-corti-client-id", key),
  getCortiClientSecret: () => ipcRenderer.invoke("get-corti-client-secret"),
  saveCortiClientSecret: (key) => ipcRenderer.invoke("save-corti-client-secret", key),
  proxyCortiTranscription: (data) => ipcRenderer.invoke("proxy-corti-transcription", data),
  proxyTinfoilTranscription: (data) => ipcRenderer.invoke("proxy-tinfoil-transcription", data),
  proxySelfHostedTranscription: (data) =>
    ipcRenderer.invoke("proxy-self-hosted-transcription", data),
  cancelSelfHostedTranscription: (requestId) =>
    ipcRenderer.send("cancel-self-hosted-transcription", requestId),

  // Custom endpoint API keys
  getSelfHostedSttHeaders: () => ipcRenderer.invoke("get-self-hosted-stt-headers"),
  saveSelfHostedSttHeaders: (value) => ipcRenderer.invoke("save-self-hosted-stt-headers", value),
  getCustomTranscriptionKey: () => ipcRenderer.invoke("get-custom-transcription-key"),
  saveCustomTranscriptionKey: (key) => ipcRenderer.invoke("save-custom-transcription-key", key),

  // Dictation key persistence (file-based for reliable startup)
  getDictationKey: () => ipcRenderer.invoke("get-dictation-key"),
  getActiveDictationKey: () => ipcRenderer.invoke("get-active-dictation-key"),
  getEffectiveDefaultHotkey: () => ipcRenderer.invoke("get-effective-default-hotkey"),
  saveDictationKey: (key) => ipcRenderer.invoke("save-dictation-key", key),

  // Activation mode persistence (file-based for reliable startup)
  getActivationMode: () => ipcRenderer.invoke("get-activation-mode"),
  saveActivationMode: (mode) => ipcRenderer.invoke("save-activation-mode", mode),

  saveAllKeysToEnv: () => ipcRenderer.invoke("save-all-keys-to-env"),
  syncStartupPreferences: (prefs) => ipcRenderer.invoke("sync-startup-preferences", prefs),
  onEnterpriseStreamPart: registerListener(
    "enterprise-stream-part",
    (callback) => (_event, payload) => callback(payload)
  ),
  onManagedEnterpriseConfigChanged: registerListener(
    "managed-enterprise-config-changed",
    (callback) => (_event, snapshot) => callback(snapshot)
  ),
  getPendingEnterpriseAudioTest: (consume = false) =>
    ipcRenderer.invoke("get-pending-enterprise-audio-test", consume),
  claimEnterpriseAudioTest: () => ipcRenderer.invoke("claim-enterprise-audio-test"),
  onEnterpriseAudioTestRequested: registerListener(
    "enterprise-audio-test-requested",
    (callback) => () => callback()
  ),
  enterpriseAudioImportBootstrap: (data) =>
    ipcRenderer.invoke("enterprise-audio-import-bootstrap", data),
  enterpriseAudioStatus: (data) => ipcRenderer.invoke("enterprise-audio-status", data),
  enterpriseAudioSaveCredential: (data) =>
    ipcRenderer.invoke("enterprise-audio-save-credential", data),
  enterpriseAudioTest: (data) => ipcRenderer.invoke("enterprise-audio-test", data),

  getLogLevel: () => ipcRenderer.invoke("get-log-level"),
  onLogLevelChanged: registerListener("log-level-changed", (callback) => () => callback()),
  log: (entry) => ipcRenderer.invoke("app-log", entry),

  // ydotool status check
  getYdotoolStatus: () => ipcRenderer.invoke("get-ydotool-status"),

  // Debug logging management
  getDebugState: () => ipcRenderer.invoke("get-debug-state"),
  setDebugLogging: (enabled) => ipcRenderer.invoke("set-debug-logging", enabled),
  getModelRegistryUpdates: () => ipcRenderer.invoke("get-model-registry-updates"),
  setModelRegistryUpdates: (enabled) => ipcRenderer.invoke("set-model-registry-updates", enabled),
  openLogsFolder: () => ipcRenderer.invoke("open-logs-folder"),

  // System settings helpers for microphone/audio permissions
  requestMicrophoneAccess: () => ipcRenderer.invoke("request-microphone-access"),
  checkMicrophoneAccess: () => ipcRenderer.invoke("check-microphone-access"),
  getSystemDefaultMicrophone: (options) =>
    ipcRenderer.invoke("get-system-default-microphone", options),
  checkSystemAudioAccess: () => ipcRenderer.invoke("check-system-audio-access"),
  verifySystemAudioAccess: () => ipcRenderer.invoke("permission-guide-verify-system-audio"),
  requestSystemAudioAccess: () => ipcRenderer.invoke("request-system-audio-access"),
  openMicrophoneSettings: () => ipcRenderer.invoke("open-microphone-settings"),
  openSoundInputSettings: () => ipcRenderer.invoke("open-sound-input-settings"),
  openAccessibilitySettings: () => ipcRenderer.invoke("open-accessibility-settings"),
  openSystemAudioSettings: () => ipcRenderer.invoke("open-system-audio-settings"),
  openScreenRecordingSettings: () => ipcRenderer.invoke("open-screen-recording-settings"),
  openLoginItemsSettings: () => ipcRenderer.invoke("open-login-items-settings"),
  checkScreenRecordingAccess: () => ipcRenderer.invoke("check-screen-recording-access"),
  requestScreenRecordingAccess: () => ipcRenderer.invoke("request-screen-recording-access"),
  toggleMediaPlayback: () => ipcRenderer.invoke("toggle-media-playback"),
  pauseMediaPlayback: () => ipcRenderer.invoke("pause-media-playback"),
  resumeMediaPlayback: () => ipcRenderer.invoke("resume-media-playback"),
  onAuthTokenStateChanged: registerListener(
    "auth-token-state-changed",
    (callback) => (_event, state) => callback(state)
  ),
  onAffiliateLink: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("affiliate-link", handler);
    return () => ipcRenderer.removeListener("affiliate-link", handler);
  },
  getSttConfig: () => ipcRenderer.invoke("get-stt-config"),
  getEffectivePolicy: (options) => ipcRenderer.invoke("get-effective-policy", options),
  onEffectivePolicyChanged: registerListener(
    "effective-policy-changed",
    (callback) => (_event, snapshot) => callback(snapshot)
  ),
  getNoteRecordingConfig: () => ipcRenderer.invoke("get-note-recording-config"),
  cancelUploadTranscription: (requestId) =>
    ipcRenderer.invoke("cancel-upload-transcription", requestId),
  transcribeAudioFileByok: (options) => ipcRenderer.invoke("transcribe-audio-file-byok", options),
  onUploadTranscriptionProgress: registerListener(
    "upload-transcription-progress",
    (callback) => (_event, data) => callback(data)
  ),

  // Assembly AI Streaming
  assemblyAiStreamingWarmup: (options) =>
    ipcRenderer.invoke("assemblyai-streaming-warmup", options),
  assemblyAiStreamingStart: (options) => ipcRenderer.invoke("assemblyai-streaming-start", options),
  assemblyAiStreamingSend: (audioBuffer) =>
    ipcRenderer.send("assemblyai-streaming-send", audioBuffer),
  assemblyAiStreamingForceEndpoint: () => ipcRenderer.send("assemblyai-streaming-force-endpoint"),
  assemblyAiStreamingStop: () => ipcRenderer.invoke("assemblyai-streaming-stop"),
  assemblyAiStreamingStatus: () => ipcRenderer.invoke("assemblyai-streaming-status"),
  onAssemblyAiPartialTranscript: registerListener(
    "assemblyai-partial-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onAssemblyAiFinalTranscript: registerListener(
    "assemblyai-final-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onAssemblyAiError: registerListener(
    "assemblyai-error",
    (callback) => (_event, error) => callback(error)
  ),
  onAssemblyAiSessionEnd: registerListener(
    "assemblyai-session-end",
    (callback) => (_event, data) => callback(data)
  ),

  // Deepgram Streaming
  deepgramStreamingWarmup: (options) => ipcRenderer.invoke("deepgram-streaming-warmup", options),
  deepgramStreamingStart: (options) => ipcRenderer.invoke("deepgram-streaming-start", options),
  deepgramStreamingSend: (audioBuffer) => ipcRenderer.send("deepgram-streaming-send", audioBuffer),
  deepgramStreamingFinalize: () => ipcRenderer.send("deepgram-streaming-finalize"),
  deepgramStreamingStop: () => ipcRenderer.invoke("deepgram-streaming-stop"),
  deepgramStreamingStatus: () => ipcRenderer.invoke("deepgram-streaming-status"),
  onDeepgramPartialTranscript: registerListener(
    "deepgram-partial-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onDeepgramFinalTranscript: registerListener(
    "deepgram-final-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onDeepgramError: registerListener(
    "deepgram-error",
    (callback) => (_event, error) => callback(error)
  ),
  onDeepgramSessionEnd: registerListener(
    "deepgram-session-end",
    (callback) => (_event, data) => callback(data)
  ),

  // Gemini Live Streaming
  geminiStreamingWarmup: (options) => ipcRenderer.invoke("gemini-streaming-warmup", options),
  geminiStreamingStart: (options) => ipcRenderer.invoke("gemini-streaming-start", options),
  geminiStreamingSend: (audioBuffer) => ipcRenderer.send("gemini-streaming-send", audioBuffer),
  geminiStreamingFinalize: () => ipcRenderer.send("gemini-streaming-finalize"),
  geminiStreamingStop: () => ipcRenderer.invoke("gemini-streaming-stop"),
  geminiStreamingStatus: () => ipcRenderer.invoke("gemini-streaming-status"),
  onGeminiPartialTranscript: registerListener(
    "gemini-partial-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onGeminiFinalTranscript: registerListener(
    "gemini-final-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onGeminiError: registerListener("gemini-error", (callback) => (_event, error) => callback(error)),
  onGeminiSessionEnd: registerListener(
    "gemini-session-end",
    (callback) => (_event, data) => callback(data)
  ),

  // Corti streaming (BYOK)
  cortiStreamingWarmup: (options) => ipcRenderer.invoke("corti-streaming-warmup", options),
  cortiStreamingStart: (options) => ipcRenderer.invoke("corti-streaming-start", options),
  cortiStreamingSend: (audioBuffer) => ipcRenderer.send("corti-streaming-send", audioBuffer),
  cortiStreamingFinalize: () => ipcRenderer.send("corti-streaming-finalize"),
  cortiStreamingStop: () => ipcRenderer.invoke("corti-streaming-stop"),
  cortiStreamingStatus: () => ipcRenderer.invoke("corti-streaming-status"),
  onCortiPartialTranscript: registerListener(
    "corti-partial-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onCortiFinalTranscript: registerListener(
    "corti-final-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onCortiError: registerListener("corti-error", (callback) => (_event, error) => callback(error)),
  onCortiSessionEnd: registerListener(
    "corti-session-end",
    (callback) => (_event, data) => callback(data)
  ),

  // Meeting transcription (streaming, dual-channel)
  meetingTranscriptionPrepare: (options) =>
    ipcRenderer.invoke("meeting-transcription-prepare", options),
  meetingTranscriptionStart: (options) =>
    ipcRenderer.invoke("meeting-transcription-start", options),
  checkMeetingRecordingStart: (options) =>
    ipcRenderer.invoke("check-meeting-recording-start", options),
  releaseMeetingRecordingStart: (sessionId) =>
    ipcRenderer.send("release-meeting-recording-start", sessionId),
  onMeetingRecordingAdmissionRevoked: registerListener(
    "meeting-recording-admission-revoked",
    (callback) => (_event, data) => callback(data)
  ),
  isMeetingRecordingDisabled: () => ipcRenderer.invoke("is-meeting-recording-disabled"),
  meetingRecordingRefused: (details) => ipcRenderer.invoke("meeting-recording-refused", details),
  meetingTranscriptionSend: (buffer, source, capturedAt) =>
    ipcRenderer.send("meeting-transcription-send", buffer, source, capturedAt),
  meetingTranscriptionSetSystemAudioAvailable: (sessionId, available) =>
    ipcRenderer.invoke("meeting-transcription-set-system-audio-available", sessionId, available),
  meetingTranscriptionSetMicMuted: (sessionId, muted) =>
    ipcRenderer.invoke("meeting-transcription-set-mic-muted", sessionId, muted),
  meetingTranscriptionStop: (expectedSessionId, reason) =>
    ipcRenderer.invoke("meeting-transcription-stop", expectedSessionId, reason),
  meetingTranscriptionCancel: () => ipcRenderer.invoke("meeting-transcription-cancel"),
  onMeetingTranscriptionSegment: registerListener(
    "meeting-transcription-segment",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSpeakerIdentified: registerListener(
    "meeting-speaker-identified",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSpeakersMerged: registerListener(
    "meeting-speakers-merged",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSessionSpeakerConfigUpdated: registerListener(
    "meeting-session-speaker-config-updated",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingTranscriptionError: registerListener(
    "meeting-transcription-error",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingTranscriptionFatalError: registerListener(
    "meeting-transcription-fatal-error",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioSilent: registerListener(
    "meeting-system-audio-silent",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioDegraded: registerListener(
    "meeting-system-audio-degraded",
    (callback) => () => callback()
  ),
  onMeetingSystemAudioInterrupted: registerListener(
    "meeting-system-audio-interrupted",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioResumed: registerListener(
    "meeting-system-audio-resumed",
    (callback) => () => callback()
  ),

  // Dictation realtime streaming
  dictationRealtimeWarmup: (options) => ipcRenderer.invoke("dictation-realtime-warmup", options),
  dictationRealtimeStart: (options) => ipcRenderer.invoke("dictation-realtime-start", options),
  dictationRealtimeSend: (buffer) => ipcRenderer.send("dictation-realtime-send", buffer),
  dictationRealtimeFinalize: () => ipcRenderer.invoke("dictation-realtime-finalize"),
  dictationRealtimeStop: () => ipcRenderer.invoke("dictation-realtime-stop"),
  onDictationRealtimePartial: registerListener(
    "dictation-realtime-partial",
    (callback) => (_event, data) => callback(data)
  ),
  onDictationRealtimeFinal: registerListener(
    "dictation-realtime-final",
    (callback) => (_event, data) => callback(data)
  ),
  onDictationRealtimeLanguage: registerListener(
    "dictation-realtime-language",
    (callback) => (_event, data) => callback(data)
  ),
  onDictationRealtimeError: registerListener(
    "dictation-realtime-error",
    (callback) => (_event, data) => callback(data)
  ),
  onDictationRealtimeSessionEnd: registerListener(
    "dictation-realtime-session-end",
    (callback) => (_event, data) => callback(data)
  ),

  // Usage limit events (for showing UpgradePrompt in ControlPanel)
  notifyLimitReached: (data) => ipcRenderer.send("limit-reached", data),
  onLimitReached: registerListener("limit-reached", (callback) => (_event, data) => callback(data)),

  // Workspace invitation deep link
  onWorkspaceInvitationToken: registerListener(
    "workspace-invitation-token",
    (callback) => (_event, token) => callback(token)
  ),
  getPendingInvitationToken: () => ipcRenderer.invoke("get-pending-invitation-token"),

  // Globe key listener for hotkey capture (macOS only)
  onGlobeKeyPressed: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-pressed", listener);
    return () => ipcRenderer.removeListener("globe-key-pressed", listener);
  },
  onGlobeKeyReleased: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-released", listener);
    return () => ipcRenderer.removeListener("globe-key-released", listener);
  },

  // Hotkey registration events (for notifying user when hotkey fails)
  onHotkeyFallbackUsed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-fallback-used", listener);
    return () => ipcRenderer.removeListener("hotkey-fallback-used", listener);
  },
  onHotkeyRegistrationFailed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-registration-failed", listener);
    return () => ipcRenderer.removeListener("hotkey-registration-failed", listener);
  },
  onApiKeyUpdated: registerListener(
    "api-key-updated",
    (callback) => (_event, storeKey) => callback(storeKey)
  ),
  onSettingUpdated: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("setting-updated", listener);
    return () => ipcRenderer.removeListener("setting-updated", listener);
  },
  onDictationKeyActive: (callback) => {
    const listener = (_event, key) => callback?.(key);
    ipcRenderer.on("dictation-key-active", listener);
    return () => ipcRenderer.removeListener("dictation-key-active", listener);
  },
  onWindowsPushToTalkUnavailable: registerListener("windows-ptt-unavailable"),
  onLinuxPttPermissionDenied: registerListener(
    "linux-ptt-permission-denied",
    (callback) => () => callback()
  ),

  // Settings shortcut (Cmd+, / Ctrl+,)
  onShowSettings: registerListener("show-settings", (callback) => () => callback()),
  getPendingSettingsSection: () => ipcRenderer.invoke("get-pending-settings-section"),

  // Accessibility permission events (macOS)
  onAccessibilityMissing: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("accessibility-missing", listener);
    return () => ipcRenderer.removeListener("accessibility-missing", listener);
  },
  checkAccessibilityTrusted: () => ipcRenderer.invoke("check-accessibility-trusted"),

  // Notify main process of activation mode changes (for Windows Push-to-Talk)
  notifyActivationModeChanged: (mode) => ipcRenderer.send("activation-mode-changed", mode),
  notifyHotkeyChanged: (hotkey) => ipcRenderer.send("hotkey-changed", hotkey),
  registerMeetingHotkey: (hotkey) => ipcRenderer.invoke("register-meeting-hotkey", hotkey),

  // Floating icon auto-hide
  notifyFloatingIconAutoHideChanged: (enabled) =>
    ipcRenderer.send("floating-icon-auto-hide-changed", enabled),
  onFloatingIconAutoHideChanged: registerListener(
    "floating-icon-auto-hide-changed",
    (callback) => (_event, enabled) => callback(enabled)
  ),

  // Panel start position
  notifyPanelStartPositionChanged: (position) =>
    ipcRenderer.send("panel-start-position-changed", position),

  // Start minimized
  notifyStartMinimizedChanged: (enabled) => ipcRenderer.send("start-minimized-changed", enabled),

  // Auto-start management
  getAutoStartEnabled: () => ipcRenderer.invoke("get-auto-start-enabled"),
  setAutoStartEnabled: (enabled) => ipcRenderer.invoke("set-auto-start-enabled", enabled),
  onPreviewText: registerListener("preview-text", (callback) => (_event, text) => callback(text)),
  onPreviewAppend: registerListener(
    "preview-append",
    (callback) => (_event, text) => callback(text)
  ),
  onPreviewHold: registerListener(
    "preview-hold",
    (callback) => (_event, payload) => callback(payload)
  ),
  onPreviewResult: registerListener(
    "preview-result",
    (callback) => (_event, payload) => callback(payload)
  ),
  onPreviewHide: registerListener("preview-hide", (callback) => () => callback()),
  startDictationPreview: (opts) => ipcRenderer.invoke("start-dictation-preview", opts),
  stopDictationPreview: (opts) => ipcRenderer.invoke("stop-dictation-preview", opts),
  dismissDictationPreview: () => ipcRenderer.invoke("dismiss-dictation-preview"),
  updateDictationPreview: (text) => ipcRenderer.invoke("update-dictation-preview", text),
  completeDictationPreview: (payload) => ipcRenderer.invoke("complete-dictation-preview", payload),
  hideDictationPreview: () => ipcRenderer.invoke("hide-dictation-preview"),
  sendDictationPreviewAudio: (data) => ipcRenderer.send("dictation-preview-audio", data),
  onAgentStreamChunk: registerListener(
    "cloud-agent-stream-chunk",
    (callback) => (_event, payload) => callback(payload)
  ),
  onAgentStreamError: registerListener(
    "cloud-agent-stream-error",
    (callback) => (_event, payload) => callback(payload)
  ),
  onAgentStreamEnd: registerListener(
    "cloud-agent-stream-end",
    (callback) => (_event, payload) => callback(payload)
  ),

  // Agent cloud tools
  productHelp: (id, input) => ipcRenderer.invoke("product-help", id, input),
  cancelProductHelp: (id) => ipcRenderer.send("product-help-cancel", id),
  productHelpBasics: () => ipcRenderer.invoke("product-help-basics"),
  onAgentConversationReleased: registerListener(
    "agent-conversation-released",
    (callback) => (_event, payload) => callback(payload)
  ),
  addAgentMessage: (conversationId, role, content, metadata) =>
    ipcRenderer.invoke("db-add-agent-message", conversationId, role, content, metadata),
  updateAgentMessage: (id, content, metadata) =>
    ipcRenderer.invoke("db-update-agent-message", id, content, metadata),
  getAgentMessages: (conversationId) => ipcRenderer.invoke("db-get-agent-messages", conversationId),
  getNoteByClientId: (clientNoteId) => ipcRenderer.invoke("db-get-note-by-client-id", clientNoteId),
  hardDeleteNote: (id, authGeneration, options) =>
    ipcRenderer.invoke("db-hard-delete-note", id, authGeneration, options),
  getFolderByClientId: (clientFolderId) =>
    ipcRenderer.invoke("db-get-folder-by-client-id", clientFolderId),
  ensureAccountDefaultFolders: (foreignCloudIds, expectedScope) =>
    ipcRenderer.invoke("db-ensure-account-default-folders", foreignCloudIds, expectedScope),
  getFolderIdMap: () => ipcRenderer.invoke("db-get-folder-id-map"),
  hardDeleteFolder: (id, authGeneration, options) =>
    ipcRenderer.invoke("db-hard-delete-folder", id, authGeneration, options),
  getTranscriptionByClientId: (clientId) =>
    ipcRenderer.invoke("db-get-transcription-by-client-id", clientId),
  hardDeleteTranscription: (id, expectedAuthGeneration) =>
    ipcRenderer.invoke("db-hard-delete-transcription", id, expectedAuthGeneration),

  // Contacts
  searchContacts: (query) => ipcRenderer.invoke("search-contacts", query),
  upsertContact: (contact) => ipcRenderer.invoke("upsert-contact", contact),

  // Meeting detection
  syncNotificationPreferences: (prefs) =>
    ipcRenderer.invoke("sync-notification-preferences", prefs),
  setMeetingSessionSpeakerConfig: (config) =>
    ipcRenderer.invoke("meeting-set-session-speaker-config", config),
  onMeetingNotificationData: registerListener(
    "meeting-notification-data",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingAutoEndRequested: registerListener(
    "meeting-auto-end-requested",
    (callback) => (_event, data) => callback(data)
  ),
  getMeetingNotificationDestination: () =>
    ipcRenderer.invoke("get-meeting-notification-destination"),
  selectMeetingNotificationFolder: (folder) =>
    ipcRenderer.invoke("select-meeting-notification-folder", folder),
  createMeetingNotificationFolder: (request) =>
    ipcRenderer.invoke("create-meeting-notification-folder", request),
  onMeetingNotificationFolderCreated: registerListener(
    "meeting-notification-folder-created",
    (callback) => (_event, data) => callback(data)
  ),
  setMeetingNotificationSurface: (state) =>
    ipcRenderer.invoke("set-meeting-notification-surface", state),
  onMeetingNotificationSurfaceClosed: registerListener(
    "meeting-notification-surface-closed",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingNotificationSurfaceResized: registerListener(
    "meeting-notification-surface-resized",
    (callback) => (_event, data) => callback(data)
  ),
  getMeetingNotificationData: () => ipcRenderer.invoke("get-meeting-notification-data"),
  meetingNotificationReady: () => ipcRenderer.invoke("meeting-notification-ready"),
  meetingNotificationRespond: (detectionId, action, options) =>
    ipcRenderer.invoke("meeting-notification-respond", detectionId, action, options),
  confirmMeetingNoteNavigation: (navigationId, status) =>
    ipcRenderer.invoke("confirm-meeting-note-navigation", navigationId, status),
  joinCalendarMeeting: (eventId, notesOnly) =>
    ipcRenderer.invoke("join-calendar-meeting", eventId, notesOnly),
  startManualMeeting: () => ipcRenderer.invoke("start-manual-meeting"),
  getPendingMeetingNoteNavigation: () => ipcRenderer.invoke("get-pending-meeting-note-navigation"),
  onMeetingNoteNavigationPending: registerListener(
    "meeting-note-navigation-pending",
    (callback) => () => callback()
  ),
  getPendingNoteNavigation: () => ipcRenderer.invoke("get-pending-note-navigation"),
  onNoteNavigationPending: registerListener(
    "note-navigation-pending",
    (callback) => () => callback()
  ),
});
