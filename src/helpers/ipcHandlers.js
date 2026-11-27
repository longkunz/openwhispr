const { VietAsrStreaming } = require("./vietAsrStreaming");
const { parseSelfHostedSttHeaders, selfHostedSttRequest } = require("./selfHostedSttHeaders.js");
const { registryData: modelRegistryData } = require("../models/registryData.js");
const { OrukeetStreaming, MANAGED_STREAM_OPTIONS } = require("./orukeetStreaming");
const { connectManagedOrukeet } = require("./orukeetCloudSession");
const {
  ipcMain,
  app,
  shell,
  BrowserWindow,
  systemPreferences,
  net,
  session,
  globalShortcut,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { isRestorablePasteTarget } = require("./windowsPasteTarget");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const debugLogger = require("./debugLogger");
const { ANALYTICS_HISTORY_BACKFILL_VERSION } = require("./analytics");
const { broadcastToWindows } = require("./windowBroadcast");
const { isFromWindow } = require("./ipcSender");
const { openExternalUrl } = require("./externalUrlOpener");
const { PRIVACY_SETTINGS_URL, usesAppControlPicker } = require("./macAppControl");
const { BYOK_API_KEYS } = require("../config/secretKeys");
const tokenStore = require("./tokenStore");
const accountScopeBinding = require("./accountScopeBinding");
const { createNoteFilesSync } = require("./noteFilesSync");
const { registerProductHelpIpc, remoteHelpPolicyState } = require("./productHelp");
const { withPolicyRequestHeaders } = require("./policyRequestHeaders");
// Pure compatibility checks for saved settings and in-flight IPC. These do
// not load the retired local engines or start any background services.
const isSherpaLocalProvider = (provider) => provider === "nvidia" || provider === "cohere";
const POLICY_TIMEOUT_MS = 10_000;
const { createEffectivePolicyManager } = require("./effectivePolicyManager");
const { devicePolicyNetworkAllowed } = require("./devicePolicyNetwork");
const {
  policyRefusalKey,
  productOperationAllowed,
  productPolicyState,
  runningOperationAllowed,
} = require("./productPolicy");
const { createPolicyResponseError, toPolicyFailure } = require("./policyResponseError");
const { resolveSystemDefaultMicrophone } = require("./systemDefaultMicrophone");
const { ipcErrorFields } = require("./ipcErrorFields");
const {
  PROVIDER_ERROR_CODES,
  isProviderSettingsTarget,
  providerHttpError,
  providerError,
  asProviderError,
  redactProviderBody,
} = require("./providerHttpErrors");
const { isSettingsTarget, isPlansBillingTarget } = require("./settingsTargets");
// The renderer's ModelRegistry is not main-loadable; the route resolver only
// needs {id, baseUrl} per provider.
const transcriptionProviderBaseUrls = () => modelRegistryData.transcriptionProviders;
// Classified errors show the provider's display name; routes only carry its id.
const transcriptionProviderName = (id) =>
  modelRegistryData.transcriptionProviders.find((p) => p.id === id)?.name || id;
// ipcMain.handle keeps only the message when a promise rejects, dropping custom
// props — proxy handlers return the classified fields so the renderer can
// rebuild the error.
const serializeIpcError =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return ipcErrorFields(error);
    }
  };
const STALE_SYNC_ACK = { success: false, changes: 0, stale: true };
// The account each sign-in (token generation) was scoped to. A chat ack names
// the account it was sent as, and main accepts that only when it is the one
// the push's sign-in was scoped to, so a window left over from another sign-in
// can't move a row. A renderer can only name an account it has scoped to.
const scopedAccountByGeneration = new Map();

function isWorkspaceIdArgument(value) {
  return value === null || (typeof value === "string" && value.trim().length > 0);
}
// A local row id from the renderer.
function isRowIdArgument(value) {
  return Number.isInteger(value) && value > 0;
}
// The spaces a search may read: null when the caller names none, and nothing
// when it names them in any other shape than a list of row ids.
function spaceIdsArgument(value) {
  if (value == null) return null;
  return Array.isArray(value) && value.every(isRowIdArgument) ? value : [];
}
// Workspace calls may name the account they were made for. One that arrives
// after another account signed in is refused rather than applied to it.
function isForOtherAccount(accountId, activeAccountId) {
  return accountId !== undefined && accountId !== activeAccountId;
}
const INVALID_DEVICE_NOTES_REQUEST = {
  success: false,
  code: "invalid_request",
  error: "The request is malformed",
};
const ACCOUNT_CHANGED_RESULT = {
  success: false,
  code: "ACCOUNT_CHANGED",
  error: "The account changed before the workspace call arrived",
};
// Local engines resolve a failed decode instead of throwing. Retry turns that
// into a coded error so the toast says what went wrong rather than blaming a
// missing engine.
function localTranscriptionFailure(result) {
  const error = new Error(result.message || result.error || "Local transcription failed");
  if (result.code === "NO_SPEECH_DETECTED" || result.message === "No audio detected") {
    error.code = "NO_SPEECH_DETECTED";
  } else if (result.error === "invalid_response") {
    error.code = "INVALID_RESPONSE";
    error.messageKey = "controlPanel.history.retryErrors.invalidResponse";
  }
  return error;
}
// The answer product work gets when the policy refuses or retires it.
const policyBlockedMessage = (snapshot) => i18nMain.t(policyRefusalKey(snapshot));
const policyBlockedFailure = (snapshot) => ({
  success: false,
  code: "DEVICE_POLICY_BLOCKED",
  error: policyBlockedMessage(snapshot),
});
// Which diarization dialect a resolved endpoint speaks, for Custom endpoints
// that front a known provider. Null when the host offers no known dialect.
const diarizationHost = (endpoint) => {
  try {
    const host = new URL(endpoint).hostname;
    if (host === "mistral.ai" || host.endsWith(".mistral.ai")) return "mistral";
    if (host === "openai.com" || host.endsWith(".openai.com")) return "openai";
  } catch {}
  return null;
};
const autoStart = require("./autoStart");
const { getRelaunchOptions, getRelaunchWaiter } = require("./autoStartPolicy");
const { i18nMain, changeLanguage } = require("./i18nMain");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const { getCortiToken } = require("./cortiAuth");
const { focusWindowsHotkeyCaptureWindow } = require("./hotkeyCaptureFocus");
const { createTinfoilRealtimeSocket } = require("./tinfoilSecureClient");
const { TINFOIL_REALTIME_MODEL } = require("./tinfoilRealtimeStreaming");
const { transcribeWithTinfoil } = require("./tinfoilTranscription");
const { transcribeWithGemini } = require("./geminiTranscription");
const { transcribeAssemblyAiRecording } = require("./assemblyAiDictation");
const { transcribeWithElevenLabs } = require("./elevenLabsTranscription");
const AudioStorageManager = require("./audioStorage");
const AgentStreamRequestRegistry = require("./agentStreamRequestRegistry");
const { applySmartSpacing } = require("./smartSpacing");
const {
  DEFAULT_RETENTION_SETTINGS,
  createRetentionSettingsHandler,
} = require("./retentionSettings");
const postMigrationDetector = require("./postMigrationDetector");
const screenContextCapture = require("./screenContextCapture");
const { classifyToneAppCategory } = require("./toneAppCategories");
const { UPLOAD_AUDIO_EXTENSIONS } = require("../constants/uploadAudioFormats.json");
const { providerContentType, prepareProviderUpload } = require("./providerUploadAudio");
const sanitizeWhisperVadConfig = (v) => v || {};
const { fetchRealtimeTokenForProvider } = require("./realtimeTokenProviders");

const MISTRAL_TRANSCRIPTION_URL = "https://api.mistral.ai/v1/audio/transcriptions";

const XAI_STT_URL = "https://api.x.ai/v1/stt";

// Route caps vary by provider (Gemini's inline-base64 limit is the lowest), so
// the message reports the cap that actually applied.
const byokSizeCapError = (sizeCapBytes) =>
  `File too large. Maximum size for bring-your-own-key is ${Math.floor(sizeCapBytes / (1024 * 1024))} MB.`;

const CLOUD_INLINE_LIMIT = 4 * 1024 * 1024;
const CLOUD_CHUNK_SEGMENT_SECONDS = 240;

const { createAbortError } = require("./abortError");
const { describeCortiTokenFailure, testProviderConnection } = require("./providerConnectionTest");
const { createConnectionCheckCache } = require("./connectionCheckCache");
const { PAID_KEY_CHECKS_FILE, createPaidKeyCheck } = require("./paidKeyCheck");
const productEventsFile = () => path.join(app.getPath("userData"), "product-events.json");
const { ENTERPRISE_AUDIO_DEVICE_ID_FILE } = require("./enterpriseAudioSetup");
const { createUploadCancelRegistry } = require("./uploadCancelRegistry");
const { applyOpenWhisprOriginHeader } = require("./sessionHeaders");
const {
  CLOUD_UPLOAD_TIMEOUT_MS,
  CLOUD_CHUNK_MAX_ATTEMPTS,
  CLOUD_CHUNK_GLOBAL_CONCURRENCY,
  CLOUD_CHUNK_MAX_TEARDOWN_REFUNDS,
  CLOUD_CHUNK_MAX_LOSS_RATIO,
  SILENT_CHUNK,
  FATAL_CHUNK_CODES,
  isTransientChunkError,
  isNetworkLevelFailure,
  isConnectionPoisoningFailure,
  isTeardownCollateral,
  summarizeChunkResults,
  assembleChunkTranscript,
  chunkRetryDelayMs,
  abortableSleep,
  createTeardownGate,
  createUploadSlots,
  withoutChunkAnalytics,
} = require("./cloudChunkPolicy");
const { transcribeOpenRouterChunks } = require("./openRouterChunkedUpload");

// Chunk retries need their own connection pool: recovering a wedged chunk pool
// must not abort an unrelated inline upload that has no collateral retry path.
const CLOUD_CHUNK_UPLOAD_SESSION_PARTITION = "ow-cloud-chunk-uploads";
const CLOUD_INLINE_UPLOAD_SESSION_PARTITION = "ow-cloud-uploads";
const cloudUploadSlots = createUploadSlots(CLOUD_CHUNK_GLOBAL_CONCURRENCY);
const shouldDropUploadPool = createTeardownGate();
const cloudUploadSessions = new Map();

function getCloudUploadSession(partition) {
  if (!cloudUploadSessions.has(partition)) {
    const uploadSession = session.fromPartition(partition);
    applyOpenWhisprOriginHeader(uploadSession);
    cloudUploadSessions.set(partition, uploadSession);
  }
  return cloudUploadSessions.get(partition);
}

function getChunkCloudUploadSession() {
  return getCloudUploadSession(CLOUD_CHUNK_UPLOAD_SESSION_PARTITION);
}

function getInlineCloudUploadSession() {
  return getCloudUploadSession(CLOUD_INLINE_UPLOAD_SESSION_PARTITION);
}

// Counts initiated pool drops so a chunk can tell whether its failure was
// collateral from a teardown that happened while its body was on the wire.
let uploadPoolTeardowns = 0;

async function dropUploadConnections(force = false) {
  if (!shouldDropUploadPool(force)) return;
  uploadPoolTeardowns++;
  try {
    await getChunkCloudUploadSession().closeAllConnections();
  } catch {
    // pool teardown is best-effort
  }
}

const { formatTimestamp: formatDiarTime } = require("./speakerMerge");
const { dropNoSpeechSegments } = require("./noSpeechSegments");
const { SCRIBE_SILENCE_MARKER } = require("../utils/scribeSilence.js");
const {
  supportsWhisperSegments,
  timestampRequestFields,
  mapVerboseSegments,
} = require("./uploadTimestamps");

// Canonicalize allowed dirs so realpath'd inputs match on macOS (/var -> /private/var).
// Deliberately narrow: user-picked paths anywhere else are approved individually via
// approvedAudioPaths, so a compromised renderer can't read arbitrary files.
function getCanonicalAllowedAudioDirs() {
  const os = require("os");
  const { getSafeTempDir } = require("./safeTempDir");
  const dirs = [os.tmpdir(), getSafeTempDir(), app.getPath("userData")];
  return dirs.map((d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return d;
    }
  });
}

// User-picked paths (OS file dialog, real drag-dropped files) may live outside the
// static dirs (external volumes, /mnt, D:\) and are approved individually.
const approvedAudioPaths = new Set();

function approveAudioPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return;
  try {
    approvedAudioPaths.add(fs.realpathSync(path.resolve(filePath)));
  } catch {
    // File vanished or unreadable; nothing to approve.
  }
}

// Recordings save-temp-audio wrote for the chat voice draft, until deleted.
const voiceDraftAudioPaths = new Set();

// The audio controls exempt dictation, so only a voice draft main itself saved
// counts as one; any other file the renderer names is an upload.
function audioFilePurpose(filePath, requestedPurpose) {
  return requestedPurpose === "dictation" &&
    typeof filePath === "string" &&
    voiceDraftAudioPaths.has(path.resolve(filePath))
    ? "dictation"
    : "upload";
}

// Returns the realpath'd file path if it lives under an allowed dir, else null.
function resolveAllowedAudioPath(filePath) {
  const real = fs.realpathSync(path.resolve(filePath));
  if (approvedAudioPaths.has(real)) {
    return real;
  }
  const allowed = getCanonicalAllowedAudioDirs();
  if (allowed.some((dir) => real === dir || real.startsWith(dir + path.sep))) {
    return real;
  }
  return null;
}

function buildMultipartBody(fileBuffer, fileName, contentType, fields = {}) {
  const boundary = `----OpenWhispr${Date.now()}`;
  const parts = [];

  parts.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  parts.push(fileBuffer);
  parts.push("\r\n");

  for (const [name, value] of Object.entries(fields)) {
    if (value != null) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`
      );
    }
  }

  parts.push(`--${boundary}--\r\n`);

  const bodyParts = parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p));
  return { body: Buffer.concat(bodyParts), boundary };
}

async function postMultipart(
  url,
  body,
  boundary,
  headers = {},
  { signal, session: fetchSession, redirect } = {}
) {
  const response = await (fetchSession ?? net).fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      ...headers,
    },
    body,
    useSessionCookies: false,
    signal,
    redirect,
  });
  const text = await response.text();
  try {
    return { statusCode: response.status, data: JSON.parse(text) };
  } catch {
    // Vercel platform errors (413 payload cap, 504 timeout) return non-JSON bodies.
    throw Object.assign(new Error(`Server error ${response.status}: ${text.slice(0, 120)}`), {
      code: "SERVER_ERROR",
      statusCode: response.status,
    });
  }
}

async function transcribeElevenLabsSpeech(options) {
  const result = await transcribeWithElevenLabs(options);
  if (!result.text) {
    throw Object.assign(new Error("No speech detected in audio"), { code: "NO_SPEECH_DETECTED" });
  }
  return result;
}

function interpretTranscribeResponse(data) {
  if (data.statusCode === 401) {
    throw Object.assign(new Error("Session expired"), { code: "AUTH_EXPIRED" });
  }
  if (data.statusCode === 503) {
    throw Object.assign(new Error("Request timed out"), { code: "SERVER_ERROR" });
  }
  if (data.statusCode === 429) {
    throw Object.assign(new Error("Weekly Cloud word limit reached"), {
      code: "LIMIT_REACHED",
      ...data.data,
    });
  }
  if (data.statusCode === 422 && data.data?.code === "NO_SPEECH_DETECTED") {
    throw Object.assign(new Error(data.data.error || "No speech detected in audio"), {
      code: "NO_SPEECH_DETECTED",
    });
  }
  if (data.statusCode !== 200) {
    throw createPolicyResponseError(data.statusCode, data.data, `API error: ${data.statusCode}`);
  }
  return data.data;
}

async function chunkedCloudTranscribe({
  buffer = null,
  filePath = null,
  apiUrl,
  policyHeaders,
  multipartFields = {},
  onProgress,
  signal,
  segmentDuration = CLOUD_CHUNK_SEGMENT_SECONDS,
}) {
  const { splitAudioFile } = require("./ffmpegUtils");

  // Aborted by the caller cancelling or by the first fatal chunk error, so a
  // doomed job stops uploading its remaining chunks immediately.
  const jobController = new AbortController();
  const { signal: jobSignal } = jobController;
  const abortJob = () => jobController.abort();
  signal?.addEventListener("abort", abortJob, { once: true });
  if (signal?.aborted) abortJob();

  const jobId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const chunkDir = path.join(os.tmpdir(), `ow-chunks-${jobId}`);
  let tmpInputPath = null;

  let inputPath = filePath;
  if (!inputPath && buffer) {
    tmpInputPath = path.join(os.tmpdir(), `ow-audio-${jobId}.webm`);
    fs.writeFileSync(tmpInputPath, buffer);
    inputPath = tmpInputPath;
  }

  fs.mkdirSync(chunkDir, { recursive: true });

  try {
    onProgress?.({ stage: "splitting", chunksTotal: 0, chunksCompleted: 0 });

    const { chunkPaths, durationSeconds } = await splitAudioFile(inputPath, chunkDir, {
      segmentDuration,
      signal: jobSignal,
    });
    const totalChunks = chunkPaths.length;

    onProgress?.({ stage: "transcribing", chunksTotal: totalChunks, chunksCompleted: 0 });

    const url = new URL(`${apiUrl}/api/transcribe`);
    const results = new Array(totalChunks).fill(null);
    let fatalError = null;
    let completedCount = 0;

    const transcribeChunk = async (index) => {
      let attempt = 1;
      let teardownRefunds = CLOUD_CHUNK_MAX_TEARDOWN_REFUNDS;
      while (true) {
        if (jobSignal.aborted) throw createAbortError();

        // Held only while a body is on the wire, so the backoff below never
        // occupies a slot and queue time never eats the upload timeout.
        const releaseSlot = await cloudUploadSlots.acquire(jobSignal);
        const timeoutSignal = AbortSignal.timeout(CLOUD_UPLOAD_TIMEOUT_MS);
        const teardownsAtStart = uploadPoolTeardowns;
        let failure = null;
        let timedOut = false;
        let collateral = false;
        try {
          try {
            const { body, boundary } = buildMultipartBody(
              fs.readFileSync(chunkPaths[index]),
              path.basename(chunkPaths[index]),
              "audio/mpeg",
              withoutChunkAnalytics(multipartFields)
            );
            const data = await postMultipart(url, body, boundary, policyHeaders, {
              signal: AbortSignal.any([jobSignal, timeoutSignal]),
              session: getChunkCloudUploadSession(),
            });
            results[index] = interpretTranscribeResponse(data);
          } catch (err) {
            failure = err;
            timedOut = timeoutSignal.aborted;
            collateral = isTeardownCollateral(err, {
              timedOut,
              teardownsDuringAttempt: uploadPoolTeardowns - teardownsAtStart,
            });
            // Drop the pool while still holding the slot — released first, a
            // queued sibling is admitted onto the pool microseconds before
            // closeAllConnections() kills it and burns an attempt it never
            // owned. A fatal TLS/protocol alert proves the pool is poisoned,
            // so that drop is forced through the cooldown gate.
            if (!jobSignal.aborted && !collateral) {
              const poisoned = isConnectionPoisoningFailure(err);
              if (poisoned || isNetworkLevelFailure(err, { timedOut })) {
                await dropUploadConnections(poisoned);
              }
            }
          }
        } finally {
          releaseSlot();
        }
        if (!failure) break;

        if (failure.code === "NO_SPEECH_DETECTED") {
          results[index] = SILENT_CHUNK;
          break;
        }

        if (jobSignal.aborted) throw createAbortError();
        if (collateral && teardownRefunds > 0) {
          teardownRefunds--;
          debugLogger.warn(`Chunk ${index} attempt ${attempt} killed by pool teardown, refunded`, {
            error: failure.message,
          });
          await abortableSleep(chunkRetryDelayMs(1), jobSignal);
          continue;
        }
        if (attempt >= CLOUD_CHUNK_MAX_ATTEMPTS || !(timedOut || isTransientChunkError(failure))) {
          throw failure;
        }
        debugLogger.warn(`Chunk ${index} attempt ${attempt} failed, retrying`, {
          error: failure.message,
          timedOut,
        });
        await abortableSleep(chunkRetryDelayMs(attempt), jobSignal);
        attempt++;
      }

      completedCount++;
      onProgress?.({
        stage: "transcribing",
        chunksTotal: totalChunks,
        chunksCompleted: completedCount,
      });
    };

    await Promise.all(
      chunkPaths.map((_, index) =>
        transcribeChunk(index).catch((err) => {
          // Only aborts the job itself caused, reported once below. A chunk's
          // own upload timeout also aborts, and that is a real failure.
          if (jobSignal.aborted && err.name === "AbortError") return;
          if (FATAL_CHUNK_CODES.has(err.code)) {
            fatalError ??= err;
            abortJob();
            return;
          }
          debugLogger.warn(`Chunk ${index} failed`, { error: err.message, code: err.code });
        })
      )
    );

    if (signal?.aborted) {
      throw Object.assign(createAbortError("Upload cancelled"), { code: "UPLOAD_CANCELLED" });
    }
    if (fatalError) throw fatalError;

    const { responses, failedChunks: failed, silentChunks } = summarizeChunkResults(results);
    if (responses.length === 0) {
      if (silentChunks === totalChunks) {
        throw Object.assign(new Error("No speech detected in audio"), {
          code: "NO_SPEECH_DETECTED",
        });
      }
      throw new Error("All chunks failed to transcribe");
    }

    if (failed / totalChunks > CLOUD_CHUNK_MAX_LOSS_RATIO) {
      throw Object.assign(new Error(`${failed} of ${totalChunks} audio segments were lost`), {
        code: "CHUNK_LOSS_EXCEEDED",
      });
    }

    const text = assembleChunkTranscript(results, segmentDuration, durationSeconds);
    return {
      text,
      responses,
      lastResponse: responses[responses.length - 1],
      ...(failed > 0
        ? {
            warning: `${failed} of ${totalChunks} chunks failed`,
            failedChunks: failed,
            totalChunks,
          }
        : {}),
    };
  } finally {
    signal?.removeEventListener("abort", abortJob);
    if (tmpInputPath) {
      try {
        fs.unlinkSync(tmpInputPath);
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(chunkDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      debugLogger.warn("Failed to cleanup chunk dir", { error: cleanupErr.message });
    }
  }
}

// A replaced or revoked session must go quiet and drop what it holds: a commit
// would send its audio on, and a late final or socket error would land in the
// renderer as if it came from the live session.
function retireStreaming(streaming) {
  if (!streaming) return;
  streaming.onPartialTranscript = null;
  streaming.onFinalTranscript = null;
  streaming.onError = null;
  streaming.onSessionEnd = null;
  if (streaming.cleanupAll) streaming.cleanupAll();
  else streaming.cleanupWarmConnection?.();
  streaming.disconnect({ commit: false }).catch(() => {});
}

// The dictation's renderer hears of the revocation at once and falls back,
// rather than streaming into a closed session behind a frozen preview.
function retireProductStream(handlers, property) {
  handlers[property]?.onError?.(new Error(i18nMain.t("common.policyTranscriptionRestricted")));
  retireStreaming(handlers[property]);
  handlers[property] = null;
  handlers._remoteStreamPolicies.delete(property);
}

function cancelWindowRequests(registry) {
  for (const win of BrowserWindow.getAllWindows()) registry.cancelSender(win.webContents.id);
}

// What both policy retirements end: a disallowed preview, product request or
// cloud request. `remoteStopped` also ends every request that leaves the device.
function abortDisallowedRequests(handlers, snapshot, remoteStopped = false) {
  const allowed = (channel, args, accountId = snapshot.accountId) =>
    runningOperationAllowed(snapshot, accountId, app.getVersion(), channel, args);
  if (!allowed("start-dictation-preview")) handlers._stopLocalDictationPreview?.();
  for (const [controller, operation] of handlers._productRequests ?? []) {
    if (
      (remoteStopped && operation.remote) ||
      !allowed(operation.channel, operation.args, operation.accountId)
    )
      controller.abort();
  }
  for (const [channel, registry] of [
    ["cloud-agent-stream-start", handlers._agentStreamRequests],
    ["cloud-reason", handlers._cloudReasonRequests],
    ["cloud-transcribe", handlers._cloudTranscriptionRequests],
  ]) {
    if (remoteStopped || !allowed(channel)) cancelWindowRequests(registry);
  }
}

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this._authTokenHeld = Boolean(tokenStore.get());
    this.windowManager = managers.windowManager;
    this.windowsKeyManager = managers.windowsKeyManager;
    this.linuxKeyManager = managers.linuxKeyManager;
    this.textEditMonitor = managers.textEditMonitor;
    this.selectionManager = managers.selectionManager;
    this.getTrayManager = managers.getTrayManager;
    this.meetingDetectionEngine = managers.meetingDetectionEngine;
    this.managedMeetingPolicy = managers.managedMeetingPolicy;
    this.managedDevicePolicy = managers.managedDevicePolicy;
    this.meetingAuditLog = managers.meetingAuditLog;
    this._remoteProductRetirement = new AbortController();
    this.audioTapManager = managers.audioTapManager;
    this.linuxPortalAudioManager = managers.linuxPortalAudioManager;
    this.windowsLoopbackAudioManager = managers.windowsLoopbackAudioManager;
    this.meetingAecManager = managers.meetingAecManager;
    this.oauthProtocolRegistered = managers.oauthProtocolRegistered === true;
    this.oauthProtocol = managers.oauthProtocol || "openwhispr";
    this.sessionId = crypto.randomUUID();
    // requestId -> AbortControllers for in-flight audio-upload work (cloud
    // upload, bring-your-own-key upload, or local transcription + diarization
    // sharing one id), so a cancel can abort the exact job.
    this._uploadCancelRegistry = createUploadCancelRegistry();
    this._agentStreamRequests = new AgentStreamRequestRegistry();
    this._cloudReasonRequests = new AgentStreamRequestRegistry();
    this._cloudTranscriptionRequests = new AgentStreamRequestRegistry();
    // webContents id -> its release listener, for renderers holding the mic open.
    this._micHoldSenders = new Map();
    this.assemblyAiStreaming = null;
    this.deepgramStreaming = null;
    this.geminiStreaming = null;
    this.cortiStreaming = null;
    this._dictationStreaming = null;
    this._dictationConnectPromise = null;
    this._dictationIdleTimer = null;
    this._dictationPreviewEnabled = false;
    this._hotkeyCaptureMode = false;
    this._textEditHandler = null;
    this._onboardingDemoSession = null;
    this.audioStorageManager = new AudioStorageManager();
    this._retentionCleanupInterval = null;
    this._retentionSettings = { ...DEFAULT_RETENTION_SETTINGS }; // Synced from renderer
    this._retentionSettingsSynced = false;
    this._granolaImportPending = null;
    this._analyticsHistoryBackfillPromise = null;
    this.speakerDiarizationEnabled = false;
    // Default for the saved process-detection toggle. The engine keeps both detectors
    // off until the renderer syncs (see meetingDetectionPreferencePolicy.js).
    this.meetingProcessDetection = true;
    this.activeMeetingSpeakerConfig = null;
    this._diarizationSpeakerReservations = new Map();
    this._setupRetentionCleanup();
    // Warm the OS default mic answer before the first hotkey press (~2s on Windows).
    resolveSystemDefaultMicrophone();
    this.setupHandlers();
  }

  createFolderWithEffects(name, spaceId, parentFolderId) {
    const result = this.databaseManager.createFolder(name, spaceId, parentFolderId);
    if (result?.success && result?.folder) {
      setImmediate(() => {
        broadcastToWindows("folder-created", result.folder);
        this.noteFiles.ensureFolder(result.folder.id);
      });
    }
    return result;
  }

  // Every window caches the dictionary and snippets in its store and in
  // localStorage, and a whole-list save writes that cache back. After an
  // account switch the cache must hold the new account's lists, or the next
  // save would copy the previous account's words into this one.
  // The account the database scopes rows by, and whose rows are in view. The
  // credential scope broadcast says neither: it stays quiet on a token rotation,
  // and it is null on any sign-out, even when the device's only account stays
  // in view.
  _broadcastDatabaseAccountScope() {
    broadcastToWindows("database-account-scope-changed", this.databaseManager.getAccountScope());
  }

  // Reconstructing counters from the transcripts already on disk records exactly
  // what "keep local history" turns off, so it answers to the same switch the
  // live path checks in audioManager.saveTranscription. The main process boots
  // with defaults rather than the user's choice, so an unsynced setting is not
  // consent either -- the renderer's first sync is what starts this (#1370).
  _canReconstructAnalyticsHistory() {
    return this._retentionSettingsSynced && this._retentionSettings.dataRetentionEnabled;
  }

  /** Whether a signed-in account is bound to this install. */
  _hasActiveAccountScope() {
    return Boolean(accountScopeBinding.read());
  }

  // The switch alone is not enough to start: a managed workspace can force local
  // history off, and that policy arrives over the network while this scan takes
  // milliseconds, so the renderer reports the permissive personal default until
  // it lands. Waiting for the real answer is only possible where there is one --
  // signed out the policy store stays idle forever and the user's own preference
  // is the only authority there is. Mid-scan arrival needs no separate check:
  // a policy that resolves "always_off" flips the switch, which the loop reads.
  _mayStartAnalyticsHistoryReconstruction() {
    if (!this._canReconstructAnalyticsHistory()) return false;
    if (this._retentionSettings.localHistoryPolicyResolved === true) return true;
    return !this._hasActiveAccountScope();
  }

  // Reconciliation is best-effort. Analytics reads await it so later-eligible
  // history shows up before the numbers are read, which means a failure here
  // must never fail the read itself: a broken scan would otherwise blank an
  // Insights summary that SQLite could have answered perfectly well.
  async _ensureAnalyticsHistoryBackfilled() {
    if (!this._mayStartAnalyticsHistoryReconstruction()) return { inserted: 0, scanned: 0 };
    if (this._analyticsHistoryBackfillPromise) return this._analyticsHistoryBackfillPromise;
    // The failure is absorbed inside this promise rather than around the
    // creator's await, because callers that join an in-flight pass are handed
    // this promise directly and would otherwise receive the raw rejection --
    // which is every analytics read that arrives while the startup pass is
    // still scanning.
    const backfillPromise = (async () => {
      let inserted = 0;
      let scanned = 0;
      let skipped = 0;
      let stoppedEarly = false;
      const state = this.databaseManager.getAnalyticsHistoryBackfillState(
        ANALYTICS_HISTORY_BACKFILL_VERSION
      );
      if (state.scannedThroughId >= state.targetId) return { inserted, scanned };
      while (true) {
        // The database reads its persisted cursor again for every batch. An
        // older row made eligible while this pass yields can move that cursor
        // backward without being overwritten by stale in-memory progress.
        const batch = this.databaseManager.backfillAnalyticsHistoryBatch({
          throughId: state.targetId,
          checkpointVersion: ANALYTICS_HISTORY_BACKFILL_VERSION,
        });
        inserted += batch.inserted;
        scanned += batch.scanned;
        skipped += batch.skipped;
        if (batch.complete) break;
        await new Promise((resolve) => setImmediate(resolve));
        // The switch can be turned off while this pass yields -- by the user, or
        // by a managed policy that resolved after the renderer's first sync sent
        // the personal default. Re-reading it here stops the scan at the next
        // batch boundary instead of mining the rest of a history the user has
        // just opted out of.
        if (!this._canReconstructAnalyticsHistory()) {
          stoppedEarly = true;
          break;
        }
      }
      if (inserted > 0) broadcastToWindows("analytics-changed");
      if (scanned > 0) {
        debugLogger.info(
          stoppedEarly
            ? "Analytics history backfill stopped: local history was turned off mid-scan"
            : "Analytics history backfill complete",
          { inserted, skipped, scanned },
          "analytics"
        );
      }
      return { inserted, scanned };
    })().catch((error) => {
      debugLogger.error("Analytics history backfill failed", { error: error.message }, "analytics");
      return { inserted: 0, scanned: 0 };
    });
    this._analyticsHistoryBackfillPromise = backfillPromise;
    // Cleared after the assignment above, never inside the pass: a scan that
    // finishes without ever awaiting would otherwise strand its own resolved
    // promise here and every later read would join a pass that already ended.
    void backfillPromise.then(() => {
      if (this._analyticsHistoryBackfillPromise === backfillPromise) {
        this._analyticsHistoryBackfillPromise = null;
      }
    });
    return backfillPromise;
  }

  // The dictation slot reports its own changes from the renderer. Slots
  // registered through IPC have to announce theirs here so macOS can re-derive
  // which keys the native Globe listener owns.
  _notifyHotkeyChanged(hotkey) {
    ipcMain.emit("hotkey-changed", null, hotkey);
  }

  _releaseMicHold(sender) {
    const release = this._micHoldSenders.get(sender.id);
    if (!release) return;
    this._micHoldSenders.delete(sender.id);
    sender.off("destroyed", release);
    sender.off("did-finish-load", release);
    this.meetingDetectionEngine?.setMicWarmHold(this._micHoldSenders.size > 0);
  }

  _getWhisperVadSettings() {
    const current = this.whisperVadSettings || {};
    return {
      dictationSileroEnabled: current.dictationSileroEnabled === true,
      noteRecordingSileroEnabled: current.noteRecordingSileroEnabled !== false,
      meetingSileroEnabled: current.meetingSileroEnabled !== false,
      ...sanitizeWhisperVadConfig(current),
    };
  }

  _setWhisperVadSettings(update = {}) {
    const ALLOWED_KEYS = new Set([
      "dictationSileroEnabled",
      "noteRecordingSileroEnabled",
      "meetingSileroEnabled",
      ...Object.keys(require("../constants/whisperVad.json").DEFAULTS),
    ]);
    const filtered = {};
    for (const [k, v] of Object.entries(update)) {
      if (ALLOWED_KEYS.has(k)) filtered[k] = v;
    }
    this.whisperVadSettings = { ...this._getWhisperVadSettings(), ...filtered };
    return this._getWhisperVadSettings();
  }

  approveAudioPath(filePath) {
    approveAudioPath(filePath);
  }

  // Note writes are journaled by SQLite triggers (pending_vector_changes); this
  // only wakes an active semantic index to drain them.
  notifyVectorChanges() {
    this.getSemanticSearch?.()?.notifyChanges();
  }

  get noteFiles() {
    this._noteFilesSync ??= createNoteFilesSync({
      getDatabase: () => this.databaseManager,
      // Mirrors include inactive accounts; their speaker names need the same scope.
      getSpeakerMappings: (noteId) =>
        Object.fromEntries(
          this.databaseManager.db
            .prepare("SELECT speaker_id, display_name FROM speaker_mappings WHERE note_id = ?")
            .all(noteId)
            .map((mapping) => [mapping.speaker_id, mapping.display_name])
        ),
    });
    return this._noteFilesSync;
  }

  _asyncMirrorWrite(note) {
    this.noteFiles.writeNote(note);
  }

  _flushAccountRepairMirrors() {
    const { noteFiles } = this;
    if (!noteFiles.enabled) return;
    noteFiles.queueAccountRepairNotes();
    noteFiles.containersChanged();
  }

  _captureMirrorDeletionNotes(filter) {
    if (!this.noteFiles.enabled) return new Map();
    const notes =
      filter.id !== undefined
        ? this.databaseManager.getNotesForMirror([filter.id])
        : this.databaseManager.getNotesForMirrorDeletion(filter);
    return new Map(
      notes.map((note) => [
        note.id,
        {
          note,
          speakerMappings: this._buildSpeakerMappings(note.id),
        },
      ])
    );
  }

  _buildSpeakerMappings(noteId) {
    return Object.fromEntries(
      this.databaseManager
        .getSpeakerMappings(noteId)
        .map((mapping) => [mapping.speaker_id, mapping.display_name])
    );
  }

  _asyncMirrorDelete(noteId, snapshots) {
    const snapshot = snapshots?.get(noteId);
    this.noteFiles.deleteNote(noteId, snapshot?.note, snapshot?.speakerMappings);
  }

  // A deleted folder's files go by note id, not with its directory: another
  // account's folder can share that directory, and so can files of the user's.
  // Other accounts' notes were released to the space root, so they're rewritten.
  _mirrorRemovedFolder({ noteIds = [], relocatedNotes = [] }, snapshots) {
    const removedIds = new Set(noteIds);
    // Local folder deletes also erase tombstones omitted from the live-note result.
    const otherIds = [...(snapshots?.keys() ?? [])].filter((noteId) => !removedIds.has(noteId));
    if (otherIds.length > 0) {
      const existingIds = new Set(this.databaseManager.getExistingNoteIds(otherIds));
      for (const noteId of otherIds) if (!existingIds.has(noteId)) removedIds.add(noteId);
    }
    for (const noteId of removedIds) this._asyncMirrorDelete(noteId, snapshots);
    for (const note of relocatedNotes) {
      if (!note.deleted_at) this._asyncMirrorWrite(note);
    }
    this.noteFiles.containersChanged();
  }

  // Deleting a folder deletes its subfolders, and their notes, with it.
  _captureSubfolderDeletionNotes(folderId, snapshots) {
    if (!this.noteFiles.enabled) return;
    for (const subfolder of this.databaseManager.getSubfolders(folderId)) {
      const subfolderSnapshots = this._captureMirrorDeletionNotes({ folder_id: subfolder.id });
      for (const [noteId, snapshot] of subfolderSnapshots) snapshots.set(noteId, snapshot);
    }
  }

  _setupRetentionCleanup() {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    // No sweep at startup: _retentionSettings still holds the 30-day default
    // until the renderer syncs, so sweeping here deletes audio a user set to
    // keep for 60/90 days or forever (#1370). The first sync runs the first
    // sweep instead.
    this._retentionCleanupInterval = setInterval(() => {
      if (this._retentionSettingsSynced) this._runRetentionCleanup();
    }, SIX_HOURS_MS);
  }

  _runRetentionCleanup() {
    const { audioRetentionDays, transcriptRetentionDays } = this._retentionSettings;
    try {
      if (transcriptRetentionDays > 0) {
        const { ids, analyticsPurged } =
          this.databaseManager.deleteTranscriptionsExpiredBefore(transcriptRetentionDays);
        for (const id of ids) {
          this.audioStorageManager.deleteAudio(id);
          broadcastToWindows("transcription-deleted", { id });
        }
        if (analyticsPurged > 0) broadcastToWindows("analytics-changed");
      }
      if (audioRetentionDays > 0) {
        this.audioStorageManager.cleanupExpiredAudio(audioRetentionDays, this.databaseManager);
      }
    } catch (error) {
      debugLogger.error("Retention cleanup failed", { error: error.message }, "audio-storage");
    }
  }

  _syncStartupEnv(setVars, clearVars = []) {
    let changed = false;
    for (const [key, value] of Object.entries(setVars)) {
      if (process.env[key] !== value) {
        process.env[key] = value;
        changed = true;
      }
    }
    for (const key of clearVars) {
      if (process.env[key]) {
        delete process.env[key];
        changed = true;
      }
    }
    if (changed) {
      debugLogger.debug("Synced startup env vars", {
        set: Object.keys(setVars),
        cleared: clearVars.filter((k) => !process.env[k]),
      });
      // A swallowed .env write failure here left GPU enablement flags silently
      // out of sync with the packs on disk (#1340) — log which keys were lost.
      this.environmentManager.saveAllKeysToEnvFile().catch((err) => {
        debugLogger.error("Failed to persist startup env vars to .env", {
          set: Object.keys(setVars),
          clearRequested: clearVars,
          error: err.message,
        });
      });
    }
  }

  // Mints a Corti access token from stored BYOK credentials. Shared by the
  // dictation streaming handlers and the meeting realtime-token resolver.
  async _mintStoredCortiToken(options = {}) {
    const clientId = this.environmentManager.getCortiClientId();
    const clientSecret = this.environmentManager.getCortiClientSecret();
    if (!clientId || !clientSecret) {
      const err = new Error("No Corti credentials configured. Add them in Settings.");
      err.code = "NO_API";
      throw err;
    }
    const environment = options.environment || "us";
    const tenant = (options.tenant || "").trim() || "base";
    const token = await getCortiToken({ environment, tenant, clientId, clientSecret });
    return { token, environment, tenant };
  }

  _stopRemoteProductWork() {
    this._remoteProductRetirement?.abort();
    this._remoteProductRetirement = new AbortController();
    for (const controller of this.enterpriseStreamAborts?.values() ?? []) controller.abort();
    for (const controller of this.activeUrlDownloads?.values() ?? []) controller.abort();
    this._remoteCalendarsStarted = false;
    abortDisallowedRequests(this, this.effectivePolicyManager.getCurrent(), true);
    cancelWindowRequests(this._enterpriseReasoningRequests);
    if (this._meetingMicStreaming || this._meetingSystemStreaming)
      this._stopMeetingForPolicy?.("policyRestricted");
    for (const key of [
      "assemblyAiStreaming",
      "deepgramStreaming",
      "geminiStreaming",
      "cortiStreaming",
      "_dictationStreaming",
    ])
      retireProductStream(this, key);
    // The meeting stop above already told the meeting's renderer.
    for (const key of ["_meetingMicStreaming", "_meetingSystemStreaming"]) {
      retireStreaming(this[key]);
      this[key] = null;
    }
  }

  _retireDisallowedProductWork(snapshot) {
    abortDisallowedRequests(this, snapshot);
    const allowed = (channel, args, accountId = snapshot.accountId) =>
      runningOperationAllowed(snapshot, accountId, app.getVersion(), channel, args);
    for (const [property, operation] of this._remoteStreamPolicies) {
      if (!allowed(operation.channel, operation.args, operation.accountId))
        retireProductStream(this, property);
    }
    for (const [streamId, provider] of this._enterpriseStreamProviders) {
      if (!allowed("enterprise-stream-start", [{ provider }]))
        this.enterpriseStreamAborts.get(streamId)?.abort();
    }
    const meetingOptions = this.getMeetingTranscriptionOptions?.();
    if (meetingOptions && !allowed("meeting-transcription", [meetingOptions]))
      this._stopMeetingForPolicy?.("policyRestricted");
  }

  setupHandlers() {
    this._remoteStreamPolicies = new Map();
    this._retireAccountProductStreams = (accountId) => {
      for (const [property, operation] of this._remoteStreamPolicies) {
        if (operation.accountId !== accountId) continue;
        if (operation.pending) {
          // Drop held audio before a late handshake can flush it. The pending
          // marker stays until its owners finish and check their own clients.
          retireStreaming(operation.streaming);
          if (this[property] === operation.streaming) this[property] = null;
        } else retireProductStream(this, property);
      }
      for (const [controller, operation] of this._productRequests) {
        if (operation.accountId === accountId) controller.abort();
      }
    };
    this._productRequests = new Map();
    this._productRequestContext = new AsyncLocalStorage();
    // Work that leaves the device doesn't start on a verdict still on its way,
    // and waits for one: a held verdict answers at once, the network only as
    // long as a policy decision may take.
    const awaitVerdict = async (event) => {
      await this.refreshEffectivePolicy(event, { held: true });
      if (this.effectivePolicyManager.getCurrent().status !== "loading") return;
      let timer;
      await Promise.race([
        this.refreshEffectivePolicy(event),
        new Promise((resolve) => {
          timer = setTimeout(resolve, POLICY_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    };
    const mayStart = (operation) => {
      const policy = this.effectivePolicyManager.getCurrent();
      return (
        (!operation.remote || (!policy.localOnly && policy.status !== "loading")) &&
        productOperationAllowed(policy, app.getVersion(), operation.channel, operation.args)
      );
    };
    const createProductHandler = (channel, handler, remote = false) => {
      return async (event, ...args) => {
        const startedPolicy = this.effectivePolicyManager.getCurrent();
        const operation = { channel, args, remote, accountId: startedPolicy.accountId };
        // Only the pill's live request belongs to its Cancel button. History and file
        // uploads can later use the same provider through their own IPC channels.
        if (
          channel === "proxy-assemblyai-transcription" ||
          channel === "proxy-elevenlabs-transcription"
        )
          operation.liveDictationSenderId = event.sender.id;
        // Retry and file routing can select a different provider. Capture the
        // owner before dispatch waits, then enforce it only on the AssemblyAI route.
        if (
          channel === "proxy-assemblyai-transcription" ||
          (channel === "retry-transcription" &&
            args[1]?.cloudTranscriptionProvider === "assemblyai") ||
          (channel === "transcribe-audio-file-byok" && args[0]?.provider === "assemblyai")
        )
          operation.dictationWorkspaceAtDispatch = captureDictationWorkspace();
        if (channel === "cloud-api-request")
          operation.args = [
            args[0],
            {
              resolvingShareVisibility:
                args[0]?.method?.toUpperCase() === "POST" &&
                /^\/api\/notes\/[^/?#]+\/share\/rotate-token\/?(?:[?#]|$)/.test(args[0]?.path),
            },
          ];
        operation.guestLocalDictation =
          startedPolicy.workspaceRequired === false &&
          operation.accountId === null &&
          ["transcribe-local-whisper", "transcribe-local-parakeet"].includes(channel);
        operation.preserveCreateReceipt =
          channel === "cloud-api-request" &&
          !args[0]?.public &&
          args[0]?.method?.toUpperCase() === "POST" &&
          args[0]?.path === "/api/conversations/create";
        const streamProperty = channel.startsWith("dictation-realtime-")
          ? "_dictationStreaming"
          : /^(assemblyai|deepgram|gemini|corti)-streaming-(start|warmup)$/.test(channel)
            ? {
                assemblyai: "assemblyAiStreaming",
                deepgram: "deepgramStreaming",
                gemini: "geminiStreaming",
                corti: "cortiStreaming",
              }[channel.split("-")[0]]
            : null;
        let streamPolicy;
        const controller = new AbortController();
        operation.signal = controller.signal;
        const interrupted = () =>
          controller.signal.reason?.code === "TRANSCRIPTION_CANCELLED"
            ? { success: false, error: "Cancelled", code: "TRANSCRIPTION_CANCELLED" }
            : policyBlockedFailure(this.effectivePolicyManager.getCurrent());
        this._productRequests.set(controller, operation);
        try {
          void this.refreshEffectivePolicy(event);
          if (operation.remote && this.effectivePolicyManager.getCurrent().status === "loading")
            await awaitVerdict(event);
          if (
            controller.signal.aborted ||
            this.effectivePolicyManager.getCurrent().accountId !== operation.accountId ||
            !mayStart(operation)
          )
            return interrupted();
          if (streamProperty) {
            const previousStreamPolicy = this._remoteStreamPolicies.get(streamProperty);
            if (
              previousStreamPolicy?.pending &&
              previousStreamPolicy.accountId !== operation.accountId
            )
              return { success: false, error: "Operation in progress" };
            streamPolicy = previousStreamPolicy?.pending
              ? previousStreamPolicy
              : { channel, args, accountId: operation.accountId, pending: 0 };
            streamPolicy.pending += 1;
            this._remoteStreamPolicies.set(streamProperty, streamPolicy);
            operation.streamPolicy = streamPolicy;
          }
          const result = await this._productRequestContext.run(operation, () =>
            handler(event, ...args)
          );
          // The sender-bound acknowledgement must learn which cloud copy now exists.
          if (operation.preserveCreateReceipt && result?.success) return result;
          let snapshot = this.effectivePolicyManager.getCurrent();
          if (
            !controller.signal.aborted &&
            snapshot.status === "loading" &&
            snapshot.deviceReady &&
            snapshot.accountId === operation.accountId &&
            snapshot.authGeneration !== startedPolicy.authGeneration
          ) {
            await this.refreshEffectivePolicy(event);
            snapshot = this.effectivePolicyManager.getCurrent();
          }
          if (snapshot.accountId !== operation.accountId) {
            return {
              success: false,
              code: "AUTH_CONTEXT_CHANGED",
              error: "Authentication context changed during the request",
            };
          }
          if (controller.signal.aborted) return interrupted();
          if (operation.dictationCleanupSignal?.aborted)
            return { success: false, ...ipcErrorFields(operation.dictationCleanupSignal.reason) };
          if (
            (!operation.remote || !snapshot.localOnly) &&
            runningOperationAllowed(
              snapshot,
              operation.accountId,
              app.getVersion(),
              operation.channel,
              operation.args
            )
          )
            return result;
          if ((!snapshot.success && snapshot.status !== "loading") || snapshot.localOnly)
            this._stopRemoteProductWork();
          else if (snapshot.success) this._retireDisallowedProductWork(snapshot);
          return policyBlockedFailure(this.effectivePolicyManager.getCurrent());
        } finally {
          this._productRequests.delete(controller);
          if (streamPolicy) {
            streamPolicy.pending -= 1;
            const snapshot = this.effectivePolicyManager.getCurrent();
            if (
              operation.streaming &&
              (controller.signal.aborted ||
                !runningOperationAllowed(
                  snapshot,
                  operation.accountId,
                  app.getVersion(),
                  channel,
                  args
                ))
            ) {
              retireStreaming(operation.streaming);
              if (this[streamProperty] === operation.streaming) this[streamProperty] = null;
            }
            if (
              this._remoteStreamPolicies.get(streamProperty) === streamPolicy &&
              !streamPolicy.pending &&
              (!this[streamProperty] || !streamPolicy.streaming)
            )
              this._remoteStreamPolicies.delete(streamProperty);
          }
        }
      };
    };
    const handleProduct = (channel, handler, remote = false) =>
      ipcMain.handle(channel, createProductHandler(channel, handler, remote));
    const handleRemoteProduct = (channel, handler) => handleProduct(channel, handler, true);
    // Register file work before the product gate can await an effective policy.
    const handleRemoteFile = (channel, handler) =>
      ipcMain.handle(channel, (event, ...args) => {
        const options = channel === "transcribe-audio-file-cloud" ? args[1] : args[0];
        const { signal, release } = this._uploadCancelRegistry.register(options?.requestId);
        const guarded = createProductHandler(
          channel,
          () => handler({ signal }, event, ...args),
          true
        );
        return guarded(event, ...args).finally(release);
      });
    const ownProductStream = (streaming) => {
      const operation = this._productRequestContext.getStore();
      if (!operation?.streamPolicy) return streaming;
      if (this.effectivePolicyManager.getCurrent().accountId !== operation.accountId)
        throw Object.assign(new Error("Authentication context changed during the request"), {
          code: "AUTH_CONTEXT_CHANGED",
        });
      operation.signal.throwIfAborted();
      if (!streaming) return streaming;
      operation.streaming = streaming;
      operation.streamPolicy.streaming = streaming;
      if (
        operation.channel.endsWith("-start") ||
        !operation.streamPolicy.channel.endsWith("-start")
      ) {
        operation.streamPolicy.channel = operation.channel;
        operation.streamPolicy.args = operation.args;
      }
      return streaming;
    };
    // Work that turns remote here starts remote work, under new remote work's rules.
    const trackTranscriptionRoute = async (route, selectedMode) => {
      const operation = this._productRequestContext.getStore();
      if (route.transport === "error") return operation.signal;
      const mode =
        route.transport === "local"
          ? "local"
          : route.transport === "managed"
            ? "enterprise"
            : route.transport === "cloud"
              ? "openwhispr"
              : route.provider === "self-hosted" || selectedMode === "self-hosted"
                ? "self-hosted"
                : "providers";
      const turnsRemote = !operation.remote && mode !== "local";
      operation.channel =
        route.transport === "proxied" && route.provider === "assemblyai"
          ? "proxy-assemblyai-transcription"
          : "batch-transcription";
      operation.args = [{ mode, provider: route.provider ?? "" }];
      operation.remote = mode !== "local";
      if (turnsRemote) {
        if (this.effectivePolicyManager.getCurrent().status === "loading") await awaitVerdict();
        if (!mayStart(operation)) {
          throw Object.assign(
            new Error(policyBlockedMessage(this.effectivePolicyManager.getCurrent())),
            { code: "DEVICE_POLICY_BLOCKED" }
          );
        }
      }
      return operation.signal;
    };
    const handleProviderTranscription = (channel, handler) =>
      handleRemoteProduct(channel, (event, options) =>
        handler(event, options, this._productRequestContext.getStore().signal)
      );
    // A push is acked only under the sign-in that sent it. After an account switch
    // the ack would hand an unattributed row to the new account although the cloud
    // copy is the old one's, so it is dropped and the row stays pending. A pulled
    // row is written only under the sign-in that fetched it, for the same reason.
    // The account counts as well as the token: a session revoked under the same
    // token drops the scope to signed out, and a row still arriving from that
    // sign-in's pull would be stored with no owner.
    const isStaleSyncAck = (expectedAuthGeneration) =>
      tokenStore.getState().generation !== expectedAuthGeneration ||
      scopedAccountByGeneration.get(expectedAuthGeneration) !==
        this.databaseManager.activeAccountId;
    const isStaleNoteWrite = (guard) =>
      guard !== undefined &&
      (!guard ||
        !(guard.accountId === null || typeof guard.accountId === "string") ||
        !Number.isSafeInteger(guard.authGeneration) ||
        guard.accountId !== this.databaseManager.activeAccountId ||
        guard.authGeneration !== tokenStore.getState().generation);
    // Each handler takes at most one renderer argument, so the job's signal
    // always lands after it and can't be supplied by the renderer. onRefused
    // hears a refusal of work that did not go ahead, with that argument.
    const handleAudioFeature = (channel, purpose, handler, onRefused) =>
      ipcMain.handle(channel, (event, options) =>
        this._audioFeaturePolicy.run(event, purpose, (signal) => handler(event, options, signal), {
          onRefused: onRefused && ((failure) => onRefused(failure, options)),
        })
      );
    // Runs a job under the audio policy and the caller's own cancellation
    // ({ signal, release }); the handler gets one signal for both.
    const runAudioJob = (event, purpose, { signal, release }, handler) =>
      this._audioFeaturePolicy
        .run(event, purpose, handler, {
          signal: this._productRequestContext.getStore()?.signal
            ? AbortSignal.any(
                [signal, this._productRequestContext.getStore().signal].filter(Boolean)
              )
            : signal,
        })
        .finally(release);
    ipcMain.handle("onboarding-set-window-mode", (_event, mode) =>
      this.windowManager.setOnboardingWindowMode(mode)
    );

    ipcMain.handle("permission-guide-open", (event, state) =>
      this.windowManager.permissionGuide.open(event, state)
    );
    ipcMain.handle("permission-guide-close", (event) =>
      this.windowManager.permissionGuide.closeFromOwner(event)
    );
    ipcMain.handle("permission-guide-state", (event) =>
      this.windowManager.permissionGuide.stateFor(event)
    );
    ipcMain.on("permission-guide-action", (event, action) =>
      this.windowManager.permissionGuide.handleAction(event, action)
    );
    ipcMain.on("permission-guide-drag", (event, target) =>
      this.windowManager.permissionGuide.startDrag(event, target)
    );

    // WindowManager owns every teardown path for a demo (id-matched end,
    // onboarding-set-active(false), control panel closed); without this hook a
    // renderer crash mid-demo would leave the session set and broadcast every
    // later dictation's transcripts on onboarding-demo-event forever.
    this.windowManager.onOnboardingDemoTeardown = () => {
      this._onboardingDemoSession = null;
    };

    ipcMain.handle("onboarding-set-active", (_event, active) => {
      if (typeof active !== "boolean") return false;
      return this.windowManager.setOnboardingActive(active);
    });

    // Every panel showing the same credentials and model shares one answer.
    const cachedConnectionCheck = createConnectionCheckCache();
    const runPaidKeyCheck = createPaidKeyCheck(() =>
      path.join(app.getPath("userData"), PAID_KEY_CHECKS_FILE)
    );
    const checkProviderConnection = async (config) => {
      if (config?.provider === "corti" && config?.scope === "transcription") {
        try {
          const clientId = String(config.clientId || "").trim();
          const clientSecret = String(config.clientSecret || "").trim();
          if (clientId && clientSecret) {
            await getCortiToken({
              environment: config.environment || "us",
              tenant: String(config.tenant || "").trim() || "base",
              clientId,
              clientSecret,
            });
          } else {
            await this._mintStoredCortiToken({
              environment: config.environment,
              tenant: config.tenant,
            });
          }
          return { success: true };
        } catch (error) {
          return describeCortiTokenFailure(error);
        }
      }
      return testProviderConnection(config, proxyFetch, runPaidKeyCheck);
    };
    handleRemoteProduct("test-provider-connection", (_event, config) =>
      cachedConnectionCheck(config, () => checkProviderConnection(config))
    );

    ipcMain.handle("window-minimize", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.minimize();
      }
    });

    ipcMain.handle("window-maximize", () => {
      if (this.windowManager.controlPanelWindow) {
        if (this.windowManager.controlPanelWindow.isMaximized()) {
          this.windowManager.controlPanelWindow.unmaximize();
        } else {
          this.windowManager.controlPanelWindow.maximize();
        }
      }
    });

    ipcMain.handle("window-close", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.close();
      }
    });

    ipcMain.handle("window-is-maximized", () => {
      if (this.windowManager.controlPanelWindow) {
        return this.windowManager.controlPanelWindow.isMaximized();
      }
      return false;
    });

    ipcMain.handle("snap-to-meeting-mode", () => {
      this.windowManager.snapControlPanelToMeetingMode();
    });

    ipcMain.handle("restore-from-meeting-mode", () => {
      this.windowManager.restoreControlPanelFromMeetingMode();
      this.meetingDetectionEngine?.setMeetingModeActive(false);
    });

    ipcMain.handle("hide-window", () => {
      this.windowManager.hideDictationPanel();
    });

    ipcMain.handle("show-dictation-panel", () => {
      this.windowManager.showDictationPanel({ reposition: true });
    });

    ipcMain.handle("open-settings-section", async (_event, section) => {
      if (
        !isSettingsTarget(section) &&
        !isProviderSettingsTarget(section) &&
        !isPlansBillingTarget(section)
      ) {
        return { success: false };
      }
      await this.windowManager.openSettings(section);
      return { success: true };
    });

    ipcMain.handle("capture-dictation-target", async () => {
      // Recording start awaits this handler, so the Linux/Windows window probe
      // runs in the background: a stalled AT-SPI peer would otherwise hold the
      // microphone for seconds (#1944). Its consumers wait for it themselves.
      void this.selectionManager?.captureTarget?.();
      const pid = (await this.textEditMonitor?.captureTargetPid?.()) ?? null;
      return { success: true, pid };
    });

    // Tone & Style: which kind of app the dictation is going into. Runs while
    // the user speaks; only the category reaches the renderer.
    ipcMain.handle("capture-dictation-app-category", async () => {
      const context = await this.selectionManager?.getTargetAppContext?.();
      const category = classifyToneAppCategory(context);
      debugLogger.debug("Dictation app category", {
        category,
        hasWindowTitle: !!context?.windowTitle,
        hasUrlHost: !!context?.urlHost,
      });
      return category;
    });

    ipcMain.handle("force-stop-dictation", () => {
      if (this.windowManager?.forceStopMacCompoundPush) {
        this.windowManager.forceStopMacCompoundPush("manual");
      }
      return { success: true };
    });

    ipcMain.handle("set-main-window-interactivity", (event, shouldCapture) => {
      this.windowManager.setMainWindowInteractivity(Boolean(shouldCapture));
      return { success: true };
    });

    ipcMain.handle("set-main-window-input-region", (event, region) => {
      if (event.sender !== this.windowManager.mainWindow?.webContents) return null;
      return this.windowManager.setMainWindowInputRegion(region);
    });

    ipcMain.handle("get-main-window-horizontal-direction", () => {
      return this.windowManager.getMainWindowHorizontalDirection();
    });

    ipcMain.handle("set-notification-interactivity", (event, interactive) => {
      this.windowManager.setNotificationInteractivity(event.sender, Boolean(interactive));
      return { success: true };
    });

    ipcMain.handle("resize-main-window", (event, sizeKey) => {
      return this.windowManager.resizeMainWindow(sizeKey);
    });

    ipcMain.handle("resize-assistant-window-to-content", (event, surfaceHeight) => {
      return this.windowManager.resizeAssistantWindowToContent(surfaceHeight);
    });

    ipcMain.handle("resize-dictation-error-window-to-content", (event, surfaceHeight) => {
      return this.windowManager.resizeDictationErrorWindowToContent(surfaceHeight);
    });

    // Counts changes to any key in Settings. A streaming socket keeps the count it
    // was opened under, so a start never reuses one authenticated before a change.
    let credentialGeneration = 0;
    const saveSecretKey = (getter, saver, storeKey) => (event, key) => {
      if (typeof key !== "string") throw new TypeError("API key must be a string");
      // Committing an unedited key field saves the same value again.
      const changed = this.environmentManager[getter]() !== key;
      const result = this.environmentManager[saver](key);
      if (!changed) return result;
      credentialGeneration += 1;
      // Notify peers by setting name only; leave the editor's pending input alone.
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.webContents.id !== event.sender.id) {
          win.webContents.send("api-key-updated", storeKey);
        }
      }
      return result;
    };

    for (const k of BYOK_API_KEYS) {
      ipcMain.handle(`get-${k.base}-key`, () => this.environmentManager[k.get]());
      ipcMain.handle(`save-${k.base}-key`, saveSecretKey(k.get, k.save, k.storeKey));
    }

    ipcMain.handle("db-save-transcription", async (event, text, rawText, options) => {
      const result = this.databaseManager.saveTranscription(text, rawText, options);
      if (result?.success && result?.transcription) {
        setImmediate(() => {
          const transcription = this.databaseManager.getTranscriptionById(result.transcription.id);
          if (transcription) broadcastToWindows("transcription-added", transcription);
        });
      }
      return result;
    });

    ipcMain.handle("db-account-changed-since", (_event, occurredAt) =>
      this.databaseManager.accountChangedSince(occurredAt)
    );

    ipcMain.handle("db-get-transcriptions", async (event, limit = 50, options = {}) => {
      return this.databaseManager.getTranscriptions(limit, options);
    });

    ipcMain.handle("db-clear-transcriptions", async (event) => {
      const result = this.databaseManager.clearTranscriptions();
      if (result?.success) {
        // Only the cleared history's recordings: another account's stay.
        this.audioStorageManager.deleteAudioForTranscriptions(result.ids);
        setImmediate(() => {
          broadcastToWindows("transcriptions-cleared", {
            cleared: result.cleared,
          });
          broadcastToWindows("analytics-changed");
        });
      }
      return { success: result.success, cleared: result.cleared };
    });

    ipcMain.handle("db-delete-transcription", async (event, id) => {
      return this.deleteTranscriptionInternal(id);
    });

    // Audio storage handlers
    ipcMain.handle("save-transcription-audio", async (event, id, audioBuffer, metadata) => {
      const transcription = this.databaseManager.getTranscriptionById(id);
      const timestamp = transcription?.timestamp || null;
      const result = this.audioStorageManager.saveAudio(id, Buffer.from(audioBuffer), timestamp);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: metadata?.durationMs || null,
          provider: metadata?.provider || null,
          model: metadata?.model || null,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) broadcastToWindows("transcription-updated", updated);
      }
      return result;
    });

    ipcMain.handle("merge-audio-segments", async (_event, segments) => {
      try {
        if (!Array.isArray(segments) || segments.length < 2 || segments.length > 100) {
          throw new Error("Invalid audio segment count");
        }
        const normalized = segments.map((segment) => {
          if (!segment?.buffer || typeof segment.mimeType !== "string") {
            throw new Error("Invalid audio segment");
          }
          return { buffer: Buffer.from(segment.buffer), mimeType: segment.mimeType };
        });
        const { mergeAudioSegments } = require("./ffmpegUtils");
        const buffer = await mergeAudioSegments(normalized);
        // Slice to a real ArrayBuffer: Buffers sent over IPC arrive as Uint8Array,
        // and pooled Buffers share a larger underlying allocation.
        return {
          success: true,
          buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          mimeType: "audio/webm",
        };
      } catch (error) {
        debugLogger.error("Failed to merge recovered audio segments", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-audio-path", async (event, id) => {
      if (!this.databaseManager.getTranscriptionById(id)) return null;
      return this.audioStorageManager.getAudioPath(id);
    });

    ipcMain.handle("show-audio-in-folder", async (event, id) => {
      if (!this.databaseManager.getTranscriptionById(id)) return { success: false };
      const filePath = this.audioStorageManager.getAudioPath(id);
      if (!filePath) return { success: false };
      shell.showItemInFolder(filePath);
      return { success: true };
    });

    ipcMain.handle("get-audio-buffer", async (event, id) => {
      if (!this.databaseManager.getTranscriptionById(id)) return null;
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      return buffer ? buffer.buffer : null;
    });

    ipcMain.handle("delete-transcription-audio", async (event, id) => {
      // Only a recording of a dictation the active account can see.
      if (!this.databaseManager.getTranscriptionById(id)) return { success: false };
      const result = this.audioStorageManager.deleteAudio(id);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
      }
      return result;
    });

    ipcMain.handle("get-audio-storage-usage", async () => {
      return this.audioStorageManager.getStorageUsage({
        exceptTranscriptionIds: this.databaseManager.getOtherAccountTranscriptionIds(),
      });
    });

    ipcMain.on(
      "retention-settings-changed",
      createRetentionSettingsHandler({
        getCurrentSettings: () => this._retentionSettings,
        getOwner: () => this.windowManager.mainWindow?.webContents,
        hasSynced: () => this._retentionSettingsSynced,
        onSettingsChanged: (settings) => {
          this._retentionSettings = settings;
          this._retentionSettingsSynced = true;
          this._runRetentionCleanup();
          // First point at which the local-history switch is known to be real.
          // After the sweep, so expired transcripts are gone before they can be
          // reconstructed into counters the sweep would only have to purge.
          void this._ensureAnalyticsHistoryBackfilled();
        },
      })
    );

    ipcMain.handle("delete-all-audio", async () => {
      // Another account's recordings stay, as with Clear history.
      const result = this.audioStorageManager.deleteAllAudio({
        exceptTranscriptionIds: this.databaseManager.getOtherAccountTranscriptionIds(),
      });
      try {
        this.databaseManager.clearAudioFlags(this.databaseManager.getTranscriptionIdsWithAudio());
      } catch (error) {
        debugLogger.error(
          "Failed to clear audio flags after delete-all",
          { error: error.message },
          "audio-storage"
        );
      }
      return result;
    });

    ipcMain.handle("get-transcription-by-id", async (event, id) => {
      return this.databaseManager.getTranscriptionById(id);
    });

    // Every window's AudioManager can hold the mic open outside a recording, so
    // gate the audio-evidence meeting detector until they all release. A
    // renderer that reloads or goes away releases implicitly — otherwise a
    // crash mid-hold would gate detection for the rest of the session.
    ipcMain.on("mic-warm-hold-changed", (event, active) => {
      if (!active) {
        this._releaseMicHold(event.sender);
        return;
      }
      if (this._micHoldSenders.has(event.sender.id)) return;
      const release = () => this._releaseMicHold(event.sender);
      this._micHoldSenders.set(event.sender.id, release);
      event.sender.on("destroyed", release);
      event.sender.on("did-finish-load", release);
      this.meetingDetectionEngine?.setMicWarmHold(true);
    });

    // Hotkey handlers run in main, while AudioManager owns the real lifecycle
    // in the dictation renderer. Only confirmed renderer state may change the
    // main-process recording gate. Preparing reserves it before the renderer
    // opens the mic; an older attempt cannot release a newer reservation.
    ipcMain.handle(
      "dictation-lifecycle-state-changed",
      (event, state, attempt, voiceAgentRequested) => {
        const dictationWindow = this.windowManager.mainWindow;
        if (!isFromWindow(event, dictationWindow) || typeof attempt !== "string" || !attempt) {
          return false;
        }
        return this.windowManager.setDictationLifecycleState(
          state,
          attempt,
          voiceAgentRequested === true
        );
      }
    );

    ipcMain.handle(
      "db-save-note",
      async (
        event,
        title,
        content,
        noteType,
        sourceFile,
        audioDuration,
        folderId,
        spaceId,
        transcript,
        writeGuard
      ) => {
        if (isStaleNoteWrite(writeGuard)) return { success: false, error: "Account changed" };
        const result = this.databaseManager.saveNote(
          title,
          content,
          noteType,
          sourceFile,
          audioDuration,
          folderId,
          spaceId,
          transcript
        );
        if (result?.success && result?.note) {
          setImmediate(() => broadcastToWindows("note-added", result.note));
          this.notifyVectorChanges();
          this._asyncMirrorWrite(result.note);
        }
        return result;
      }
    );

    ipcMain.handle("db-get-note", async (event, id) => {
      return this.databaseManager.getNote(id);
    });

    ipcMain.handle("db-get-notes", async (event, noteType, limit, folderId, spaceId, spaceIds) => {
      return this.databaseManager.getNotes(noteType, limit, folderId, spaceId, spaceIds);
    });

    ipcMain.handle("db-get-space-notes", async (event, spaceId, limit) => {
      return this.databaseManager.getNotesForSpace(spaceId, limit);
    });

    ipcMain.handle("db-update-note", async (event, id, updates, options) => {
      if (isStaleNoteWrite(options?.writeGuard))
        return { success: false, error: "Account changed" };
      const result = this.databaseManager.updateNote(id, updates, options);
      if (result?.success && result?.note) {
        setImmediate(() => broadcastToWindows("note-updated", result.note));
        this.notifyVectorChanges();
        this._asyncMirrorWrite(result.note);
      }
      return result;
    });

    ipcMain.handle("db-delete-note", async (event, id) => {
      return this.deleteNoteInternal(id);
    });

    ipcMain.handle("db-search-notes", async (event, query, limit, spaceId, folderId, spaceIds) => {
      return this.databaseManager.searchNotes(
        query,
        limit,
        spaceId,
        folderId,
        spaceIdsArgument(spaceIds)
      );
    });

    ipcMain.handle("db-update-note-share-state", async (event, id, state) => {
      const note = this.databaseManager.updateNoteShareState(id, state);
      if (note) {
        setImmediate(() => broadcastToWindows("note-updated", note));
      }
      return note;
    });

    ipcMain.handle("db-get-folders", async (event, spaceId) => {
      return this.databaseManager.getFolders(spaceId);
    });

    // Notes that left the device-only list are filed, indexed and visible in
    // every window, and the list itself changed.
    const publishDeviceNoteChange = (movedNotes) => {
      this.notifyVectorChanges();
      this.noteFiles.notesMoved();
      setImmediate(() => {
        // A claimed tombstone syncs but must not appear in the renderer's list.
        for (const note of movedNotes) {
          if (!note.deleted_at) broadcastToWindows("note-updated", note);
        }
        broadcastToWindows("device-notes-changed");
      });
    };

    ipcMain.handle("db-get-device-notes", async () => this.databaseManager.getDeviceNotes());

    ipcMain.handle("db-get-device-note", async (_event, id) =>
      isRowIdArgument(id) ? this.databaseManager.getDeviceNote(id) : null
    );

    ipcMain.handle("db-move-device-notes", async (_event, request) => {
      const { noteIds, folderId, workspaceId = null, targetFolderId, accountId } = request ?? {};
      const namesNotes = Array.isArray(noteIds) && noteIds.length > 0;
      // The database reads a request naming neither as "move everything".
      if (
        !(namesNotes || isRowIdArgument(folderId)) ||
        (noteIds !== undefined && !(namesNotes && noteIds.every(isRowIdArgument))) ||
        (folderId !== undefined && !isRowIdArgument(folderId)) ||
        (targetFolderId !== undefined && !isRowIdArgument(targetFolderId)) ||
        !isWorkspaceIdArgument(workspaceId)
      ) {
        return INVALID_DEVICE_NOTES_REQUEST;
      }
      if (isForOtherAccount(accountId, this.databaseManager.activeAccountId)) {
        return ACCOUNT_CHANGED_RESULT;
      }
      const { moved, skipped, code } = this.databaseManager.moveDeviceNotesToPrivate({
        noteIds,
        folderId,
        workspaceId,
        targetFolderId,
      });
      if (code) return { success: false, code, error: "The folder is no longer available" };
      if (moved.length > 0) publishDeviceNoteChange(moved);
      return { success: true, moved, skipped };
    });

    ipcMain.handle("db-get-stand-in-ownership-candidates", async () =>
      this.databaseManager.getStandInOwnershipCandidates()
    );

    ipcMain.handle("db-resolve-stand-in-ownership", async (_event, request) => {
      const { noteId, cloudId, owned, accountId } = request ?? {};
      if (
        !isRowIdArgument(noteId) ||
        typeof cloudId !== "string" ||
        !cloudId ||
        typeof owned !== "boolean"
      ) {
        return INVALID_DEVICE_NOTES_REQUEST;
      }
      if (isForOtherAccount(accountId, this.databaseManager.activeAccountId)) {
        return ACCOUNT_CHANGED_RESULT;
      }
      const { claimed, note } = this.databaseManager.resolveStandInOwnership(
        noteId,
        cloudId,
        owned
      );
      if (claimed) publishDeviceNoteChange(note ? [note] : []);
      return { claimed };
    });

    ipcMain.handle("db-create-folder", (_event, name, spaceId, writeGuard, parentFolderId) =>
      isStaleNoteWrite(writeGuard)
        ? { success: false, error: "Account changed" }
        : this.createFolderWithEffects(name, spaceId, parentFolderId)
    );

    ipcMain.handle("db-delete-folder", async (event, id) => {
      const snapshots = this._captureMirrorDeletionNotes({ folder_id: id });
      this._captureSubfolderDeletionNotes(id, snapshots);
      const result = this.databaseManager.deleteFolder(id);
      if (result?.success) {
        this.notifyVectorChanges();
        this._mirrorRemovedFolder(result, snapshots);
        // Subfolders first, as the database deleted them. Each event names every
        // note the delete took, so a recording in one of them hears of it.
        const noteIds = result.noteIds ?? [];
        setImmediate(() => {
          for (const folderId of result.folderIds ?? [id]) {
            broadcastToWindows("folder-deleted", { id: folderId, noteIds });
          }
        });
      }
      return result;
    });

    ipcMain.handle("db-rename-folder", async (event, id, name) => {
      const result = this.databaseManager.renameFolder(id, name);
      if (result?.success && result?.folder) {
        this.noteFiles.containersChanged();
        setImmediate(() => broadcastToWindows("folder-renamed", result.folder));
      }
      return result;
    });

    ipcMain.handle("db-move-folder-to-space", async (event, id, spaceId) => {
      const result = this.databaseManager.moveFolderToSpace(id, spaceId);
      if (result?.success) {
        // Qdrant payloads carry space_id — the triggers journaled the moved notes.
        this.notifyVectorChanges();
        this.noteFiles.containersChanged();
        if (result.folder) {
          setImmediate(() => broadcastToWindows("folder-synced", result.folder));
        }
      }
      return result;
    });

    ipcMain.handle("db-set-folder-parent", async (event, id, parentFolderId, writeGuard) => {
      if (isStaleNoteWrite(writeGuard)) return { success: false, error: "Account changed" };
      const result = this.databaseManager.setFolderParent(id, parentFolderId ?? null);
      if (result?.success && result?.folder) {
        this.noteFiles.containersChanged();
        setImmediate(() => broadcastToWindows("folder-synced", result.folder));
      }
      return result;
    });

    ipcMain.handle("db-get-folder-note-counts", async () => {
      return this.databaseManager.getFolderNoteCounts();
    });

    ipcMain.handle("db-get-spaces", async () => {
      return this.databaseManager.getSpaces();
    });

    ipcMain.handle("db-has-other-account-rows", () => this.databaseManager.hasOtherAccountRows());
    ipcMain.handle("db-has-unclaimed-legacy-rows", () =>
      this.databaseManager.hasUnclaimedLegacyRows()
    );

    ipcMain.handle("get-private-space-id", (_event, workspaceId = null, expectedAuthGeneration) => {
      if (!isWorkspaceIdArgument(workspaceId)) return null;
      if (expectedAuthGeneration !== undefined && isStaleSyncAck(expectedAuthGeneration))
        return null;
      return this.databaseManager.getPrivateSpaceId(workspaceId);
    });

    // Personal cloud rows without recorded placement fall back to the account's
    // default Private, never the active workspace's.
    ipcMain.handle("get-default-private-space-id", (_event, expectedAuthGeneration) => {
      if (expectedAuthGeneration !== undefined && isStaleSyncAck(expectedAuthGeneration))
        return null;
      return this.databaseManager.getDefaultPrivateSpaceId();
    });

    ipcMain.handle("get-active-account-scope", () =>
      accountScopeBinding.resolveActiveAccountScope({
        ...tokenStore.getState(),
        binding: accountScopeBinding.read(),
      })
    );

    // A tool can wait on folder lookup or a lock before writing; keep its original account.
    ipcMain.handle("get-note-write-guard", () => ({
      accountId: this.databaseManager.activeAccountId,
      authGeneration: tokenStore.getState().generation,
    }));

    // The binding above stops matching as soon as the token rotates, while the
    // database keeps the account until the renderer re-scopes it, so a window
    // taking its baseline from the binding reads that re-scope as a change.
    ipcMain.handle("get-database-account-scope", () => this.databaseManager.getAccountScope());

    ipcMain.handle(
      "delete-account-data",
      async (_event, accountId, expectedGeneration, _options) => {
        const state = tokenStore.getState();
        if (
          typeof accountId !== "string" ||
          accountId.trim().length === 0 ||
          !state.token ||
          state.generation !== expectedGeneration
        ) {
          return {
            success: false,
            code: "AUTH_CONTEXT_CHANGED",
            error: "Authentication context changed before local account cleanup",
          };
        }
        try {
          const snapshots = this._captureMirrorDeletionNotes({ account_id: accountId });
          const result = this.databaseManager.deleteAccountData(accountId);
          let productEventsFailure;
          try {
            this.productEvents?.purge(accountId);
          } catch (error) {
            productEventsFailure = error;
          }
          this.audioStorageManager.deleteAudioForTranscriptions(result.deletedTranscriptionIds);
          this.metaActivation?.purge(accountId);
          this.notifyVectorChanges();
          for (const noteId of result.deletedNoteIds) {
            this._asyncMirrorDelete(noteId, snapshots);
          }
          for (const note of result.relocatedNotes) {
            if (!note.deleted_at) this._asyncMirrorWrite(note);
          }
          this.noteFiles.containersChanged();
          // The account's rows are already gone, so a vault that won't delete
          // must not report the deletion as failed; a later deletion retries it.
          try {
            await this.enterpriseAudioCredentials?.removeAccount(accountId);
          } catch (error) {
            debugLogger.warn("Enterprise audio credential removal failed", {
              error: error.message,
            });
          }
          if (productEventsFailure) throw productEventsFailure;
          return { success: true, ...result };
        } catch (error) {
          return { success: false, code: "LOCAL_ACCOUNT_CLEANUP_FAILED", error: error.message };
        }
      }
    );

    ipcMain.handle("db-update-space", async (event, id, updates) => {
      const result = this.databaseManager.updateSpace(id, updates);
      if (result?.success && result.space) {
        this.noteFiles.containersChanged();
        setImmediate(() => broadcastToWindows("space-synced", result.space));
      }
      return result;
    });

    ipcMain.handle("db-purge-space", async (event, id, options) => {
      if (options?.expectedAuthGeneration !== undefined) {
        const state = tokenStore.getState();
        if (!state.token || state.generation !== options.expectedAuthGeneration) {
          return {
            success: false,
            error: "Authentication context changed before account cleanup",
            code: "AUTH_CONTEXT_CHANGED",
          };
        }
      }
      const snapshots = this._captureMirrorDeletionNotes({ space_id: id });
      const result = this.databaseManager.purgeSpace(id, options);
      if (result?.success) {
        if (!result.preservedForOtherAccounts) {
          // The purge row and the relocated notes' trigger rows drain together.
          this.databaseManager.addPendingVectorPurge(result.spaceId);
          this.notifyVectorChanges();
          for (const note of result.relocatedNotes ?? []) {
            this._asyncMirrorWrite(note);
          }
          for (const noteId of result.noteIds ?? []) {
            this._asyncMirrorDelete(noteId, snapshots);
          }
        }
        this.noteFiles.containersChanged();
        setImmediate(() => broadcastToWindows("space-purged", { spaceId: result.spaceId }));
      }
      return result;
    });

    ipcMain.handle(
      "db-add-agent-message",
      async (event, conversationId, role, content, metadata) => {
        const result = this.databaseManager.addAgentMessage(
          conversationId,
          role,
          content,
          metadata
        );
        if (result && this.vectorIndex?.isReady?.()) {
          const conv = this.databaseManager.getAgentConversation(conversationId);
          if (conv && conv.messages?.length % 3 === 0) {
            this.vectorIndex
              .upsertConversationChunks(conversationId, conv.title, conv.messages)
              .catch(() => {});
          }
        }
        return result;
      }
    );

    ipcMain.handle("db-update-agent-message", async (event, id, content, metadata) => {
      return this.databaseManager.updateAgentMessage(id, content, metadata);
    });

    ipcMain.handle("db-get-agent-messages", async (event, conversationId) => {
      return this.databaseManager.getAgentMessages(conversationId);
    });
    ipcMain.handle("db-get-note-by-client-id", (_, clientNoteId) =>
      this.databaseManager.getNoteByClientId(clientNoteId)
    );
    // Scope changes run before useAuth waits for the sync lock. Cloud ownership
    // evidence must still belong to the active account when its queued IPC lands.
    const assertSyncAccountScope = (expectedScope) => {
      const activeScope = accountScopeBinding.resolveActiveAccountScope({
        ...tokenStore.getState(),
        binding: accountScopeBinding.read(),
      });
      if (
        !accountScopeBinding.matchesActiveAccountScope(expectedScope, activeScope) ||
        this.databaseManager.activeAccountId !== expectedScope.accountId
      ) {
        throw new Error("Authentication context changed during sync acknowledgement");
      }
    };
    // A pulled delete names the copy it decided from (options.expected); main
    // leaves a row written since, so its text is decided again, not deleted.
    ipcMain.handle("db-hard-delete-note", (_, id, expectedAuthGeneration, options) => {
      if (expectedAuthGeneration !== undefined && isStaleSyncAck(expectedAuthGeneration))
        return STALE_SYNC_ACK;
      const expected =
        options?.expected && typeof options.expected === "object" ? options.expected : undefined;
      const snapshots = this._captureMirrorDeletionNotes({ id });
      const result = this.databaseManager.hardDeleteNote(id, { expected });
      if (result?.success) {
        this.notifyVectorChanges();
        this._asyncMirrorDelete(id, snapshots);
        setImmediate(() => broadcastToWindows("note-deleted", { id }));
      }
      return result;
    });
    ipcMain.handle("db-get-folder-by-client-id", (_, clientFolderId) =>
      this.databaseManager.getFolderByClientId(clientFolderId)
    );
    ipcMain.handle("db-ensure-account-default-folders", (_, foreignCloudIds, expectedScope) => {
      assertSyncAccountScope(expectedScope);
      const before = this.databaseManager.getFolders();
      this.databaseManager.ensureAccountDefaultFolders(
        Array.isArray(foreignCloudIds)
          ? foreignCloudIds.filter((cloudId) => typeof cloudId === "string")
          : []
      );
      this._flushAccountRepairMirrors();
      // A folder proved to be another account's is gone from this scope.
      const kept = new Set(this.databaseManager.getFolders().map((folder) => folder.id));
      setImmediate(() => {
        for (const { id } of before) {
          if (!kept.has(id)) broadcastToWindows("folder-deleted", { id });
        }
      });
    });
    ipcMain.handle("db-get-folder-id-map", () => this.databaseManager.getFolderIdMap());
    ipcMain.handle("db-hard-delete-folder", (_, id, expectedAuthGeneration, options) => {
      if (expectedAuthGeneration !== undefined && isStaleSyncAck(expectedAuthGeneration))
        return STALE_SYNC_ACK;
      const snapshots = this._captureMirrorDeletionNotes({ folder_id: id });
      const result = this.databaseManager.hardDeleteFolder(id, options);
      if (result?.success) {
        this.notifyVectorChanges();
        // Notes a pulled delete unfiled to their space's top level are among the
        // relocated notes, so _mirrorRemovedFolder writes them.
        this._mirrorRemovedFolder(result, snapshots);
        setImmediate(() => {
          // Before the folder goes, so a window showing one of them keeps it open.
          for (const note of [...(result.preservedNotes ?? []), ...(result.unfiledNotes ?? [])]) {
            broadcastToWindows("note-updated", note);
          }
          broadcastToWindows("folder-deleted", { id, noteIds: result.noteIds ?? [] });
        });
      }
      return result;
    });
    ipcMain.handle("db-set-space-sync-status", (_, id, status) => {
      const result = this.databaseManager.setSpaceSyncStatus(id, status);
      if (result?.success && result.space) {
        // Live skeleton toggling: the tree keys pending/synced off this flag.
        setImmediate(() => broadcastToWindows("space-synced", result.space));
      }
      return result;
    });
    ipcMain.handle("db-get-transcription-by-client-id", (_, clientId) =>
      this.databaseManager.getTranscriptionByClientId(clientId)
    );
    ipcMain.handle("db-hard-delete-transcription", (_, id, expectedAuthGeneration) => {
      if (isStaleSyncAck(expectedAuthGeneration)) return STALE_SYNC_ACK;
      const result = this.databaseManager.hardDeleteTranscription(id);
      if (result?.success) {
        this.audioStorageManager.deleteAudio(id);
        setImmediate(() => broadcastToWindows("transcription-deleted", { id }));
      }
      return result;
    });

    ipcMain.handle("export-note", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const { dialog } = require("electron");
        const fs = require("fs");
        const exportFormat =
          format === "txt"
            ? { name: "Text", extension: "txt" }
            : { name: "Markdown", extension: "md" };
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${exportFormat.extension}`,
          filters: [{ name: exportFormat.name, extensions: [exportFormat.extension] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        let exportContent;
        if (format === "txt") {
          const { markdownToPlainText } = await import("./markdownToPlainText.ts");
          exportContent = markdownToPlainText(note.content || "");
          if (!exportContent.trim() && note.enhanced_content) {
            exportContent = markdownToPlainText(note.enhanced_content);
          }
        } else {
          exportContent = note.enhanced_content || note.content;
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting note", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("export-transcript", async (event, noteId, format, options) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const segments = JSON.parse(note.transcript || "[]");
        if (!segments.length) return { success: false, error: "No transcript available" };

        const speakerMappings = this._buildSpeakerMappings(noteId);

        const { dialog } = require("electron");
        const fs = require("fs");
        const exportFormats = {
          txt: { name: "Text", extension: "txt" },
          srt: { name: "SubRip Subtitles", extension: "srt" },
          json: { name: "JSON", extension: "json" },
          md: { name: "Markdown", extension: "md" },
        };
        const exportFormat = exportFormats[format] || exportFormats.txt;
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${exportFormat.extension}`,
          filters: [{ name: exportFormat.name, extensions: [exportFormat.extension] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        // The renderer resolves the original recorder from the space roster;
        // legacy segments need that fallback because they have no session recorder.
        const recorderLabel =
          typeof options?.recorderLabel === "string" ? options.recorderLabel.trim() : "";
        const formatOptions = { recorderLabel };
        const transcriptFormatter = require("./transcriptFormatter");
        let exportContent;
        if (format === "txt") {
          exportContent = transcriptFormatter.formatTxt(
            note,
            segments,
            speakerMappings,
            formatOptions
          );
        } else if (format === "srt") {
          exportContent = transcriptFormatter.formatSrt(
            segments,
            speakerMappings,
            note,
            formatOptions
          );
        } else if (format === "md") {
          exportContent = transcriptFormatter.formatMd(
            note,
            segments,
            speakerMappings,
            formatOptions
          );
        } else {
          exportContent = transcriptFormatter.formatJson(
            note,
            segments,
            speakerMappings,
            formatOptions
          );
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting transcript", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    handleAudioFeature("select-audio-file", "upload", async (event, options = {}) => {
      const { dialog } = require("electron");
      const properties = ["openFile"];
      if (options.multiple === true) properties.push("multiSelections");
      const result = await dialog.showOpenDialog({
        properties,
        filters: [{ name: "Audio and Video Files", extensions: UPLOAD_AUDIO_EXTENSIONS }],
      });
      if (result.canceled || !result.filePaths.length) {
        return { canceled: true };
      }
      result.filePaths.forEach(approveAudioPath);
      if (options.multiple === true) {
        return { canceled: false, filePaths: result.filePaths };
      }
      return { canceled: false, filePath: result.filePaths[0] };
    });

    // Fired by the preload's getPathForFile for real drag-dropped files; a
    // renderer-constructed File yields "" there, so this can't be forged.
    ipcMain.on("approve-audio-path", (_event, filePath) => {
      approveAudioPath(filePath);
    });

    ipcMain.handle("get-file-size", async (_event, filePath) => {
      const fs = require("fs");
      try {
        if (typeof filePath !== "string") return 0;
        const real = resolveAllowedAudioPath(filePath);
        if (!real) return 0;
        const stats = fs.statSync(real);
        return stats.size;
      } catch {
        return 0;
      }
    });

    const activeUrlDownloads = new Map();
    this.activeUrlDownloads = activeUrlDownloads;
    let urlDownloadSeq = 0;

    // Sweep ow-url-*/ow-diarize-* orphans from crashes or windows closed mid-download.
    require("./urlAudioDownloader").sweepStaleTempArtifacts();

    handleRemoteProduct("download-url-audio", async (event, url, downloadId) => {
      const id =
        typeof downloadId === "string" && downloadId ? downloadId : `dl-${++urlDownloadSeq}`;
      const abortController = new AbortController();
      activeUrlDownloads.set(id, abortController);

      const cancel = {
        signal: abortController.signal,
        release: () => {
          if (activeUrlDownloads.get(id) === abortController) {
            activeUrlDownloads.delete(id);
          }
        },
      };
      return runAudioJob(event, "upload", cancel, async (signal) => {
        try {
          signal.throwIfAborted();
          if (typeof url !== "string" || url.length > 2048) {
            return { success: false, error: "Invalid URL", code: "INVALID_URL" };
          }
          const { download } = require("./urlAudioDownloader");
          const result = await download(
            url,
            (progress) => {
              if (!event.sender.isDestroyed()) {
                event.sender.send("url-download-progress", { ...progress, downloadId: id });
              }
            },
            signal
          );
          return { success: true, ...result };
        } catch (error) {
          if (signal.aborted) {
            return {
              success: false,
              error: i18nMain.t("notes.upload.batchCancelled"),
              code: "DOWNLOAD_CANCELLED",
            };
          }
          debugLogger.error("URL audio download error", {
            error: error.message,
            code: error.code,
          });
          return { success: false, error: error.message, code: error.code || "DOWNLOAD_FAILED" };
        }
      });
    });

    // With an id, cancels that download; without, cancels all (unmount cleanup).
    ipcMain.handle("cancel-url-download", async (_event, downloadId) => {
      if (typeof downloadId === "string" && downloadId) {
        const controller = activeUrlDownloads.get(downloadId);
        if (!controller) return { success: false };
        controller.abort();
        activeUrlDownloads.delete(downloadId);
        return { success: true };
      }
      if (activeUrlDownloads.size === 0) return { success: false };
      for (const controller of activeUrlDownloads.values()) controller.abort();
      activeUrlDownloads.clear();
      return { success: true };
    });

    ipcMain.handle("delete-temp-file", async (event, filePath) => {
      try {
        if (typeof filePath !== "string") {
          return { success: false, error: "Invalid file path" };
        }
        const { getSafeTempDir } = require("./safeTempDir");
        const resolved = path.resolve(filePath);
        const basename = path.basename(resolved);
        if (!basename.startsWith("ow-url-") && !basename.startsWith("ow-diarize-")) {
          return { success: false, error: "Not an OpenWhispr temp file" };
        }
        const real = fs.realpathSync(resolved);
        let tempDir = getSafeTempDir();
        try {
          tempDir = fs.realpathSync(tempDir);
        } catch {}
        const rel = path.relative(tempDir, real);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return { success: false, error: "Not an OpenWhispr temp file" };
        }
        fs.unlinkSync(real);
        return { success: true };
      } catch (error) {
        debugLogger.warn("Failed to delete temp file", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("capture-selected-text", async (event, options = {}) => {
      if (!this.selectionManager) {
        return { status: "unavailable", code: "selection_manager_unavailable" };
      }
      return this.selectionManager.captureSelectedText({
        probeEditable: options.probeEditable === true,
      });
    });

    ipcMain.handle("cancel-selection-edit", (_event, sessionId) => {
      this.selectionManager?.cancelSelectionEdit(sessionId);
    });

    ipcMain.handle("replace-selected-text", async (event, sessionId, text, options = {}) => {
      if (!this.selectionManager) {
        return { success: false, code: "selection_manager_unavailable" };
      }
      return this.selectionManager.replaceSelectedText(sessionId, text, {
        restoreClipboard: options.restoreClipboard !== false,
        allowClipboardFallback: options.allowClipboardFallback === true,
        webContents: event.sender,
      });
    });

    ipcMain.handle("paste-at-captured-target", async (event, sessionId, text) => {
      if (!this.selectionManager) {
        return { success: false, code: "selection_manager_unavailable" };
      }
      return this.selectionManager.pasteAtCapturedTarget(sessionId, text, {
        webContents: event.sender,
      });
    });

    ipcMain.handle("paste-text", async (event, text, options) => {
      // An onboarding demo already puts the transcript in its own textarea from
      // the demo event, and that textarea is what has focus — pasting on top of
      // it appends the same sentence a second time. This is a successful no-op,
      // not a completed paste, so callers can avoid reporting paste-dependent
      // fallbacks as if text reached another application.
      if (this.windowManager?.isOnboardingDemoActive()) {
        return { success: true, pasted: false };
      }

      // A raw paste lands exactly as given: no smart space, and no AutoLearn watching edits.
      const { raw, ...pasteOptions } = options ?? {};

      const mainWindow = this.windowManager?.mainWindow;
      const targetPid = this.textEditMonitor?.lastTargetPid || null;

      // Activating the target by PID is more reliable than hide()'s implicit
      // focus hand-off for Chromium apps like Claude desktop and Brave (#668).
      let activated = false;
      if (process.platform === "darwin" && this.textEditMonitor) {
        activated = await this.textEditMonitor.activateTargetPid();
      }

      if (!activated && mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
        if (process.platform === "darwin") {
          mainWindow.hide();
          await new Promise((resolve) => setTimeout(resolve, 120));
          mainWindow.showInactive();
        } else {
          mainWindow.blur();
          // On Linux blur() leaves X focus on the pill, so the paste would land
          // in the pill.
          if (process.platform === "linux") this.windowManager.returnLinuxKeyboardFocus();
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      }

      // Smart spacing (#856): append a trailing space so the next paste's leading
      // space self-corrects the gap. Reading the char before the cursor to space
      // the front instead would take a macOS Accessibility read costing hundreds
      // of ms — too slow for the paste hot path.
      const textToPaste = raw === true ? text : applySmartSpacing(text);

      const winTarget =
        process.platform === "win32"
          ? ((await this.selectionManager?.getWinTarget?.()) ?? null)
          : null;
      const targetWindow =
        winTarget &&
        isRestorablePasteTarget({
          target: winTarget,
          ownExeName: path.basename(process.execPath),
          ownWindowHandles: BrowserWindow.getAllWindows()
            .filter((win) => !win.isDestroyed())
            .map((win) => win.getNativeWindowHandle()),
        })
          ? winTarget.id
          : null;
      let pasteResult;
      try {
        pasteResult = await this.clipboardManager.pasteText(textToPaste, {
          ...pasteOptions,
          webContents: event.sender,
          targetWindow,
          silentAccessibilityCheck: true,
        });
      } catch (error) {
        if (error?.code !== "ACCESSIBILITY_PERMISSION_REQUIRED" || error.clipboardCopied !== true) {
          throw error;
        }
        return {
          success: false,
          pasted: false,
          code: "ACCESSIBILITY_PERMISSION_REQUIRED",
          clipboardCopied: true,
        };
      }
      const pasted = pasteResult?.pasted !== false;
      debugLogger.debug("[AutoLearn] Paste completed", {
        autoLearnEnabled: this._autoLearnEnabled,
        hasMonitor: !!this.textEditMonitor,
        targetPid,
        pasted,
      });
      if (raw !== true && pasted && this.textEditMonitor && this._autoLearnEnabled) {
        setTimeout(() => {
          try {
            debugLogger.debug("[AutoLearn] Starting monitoring", {
              textPreview: text.substring(0, 80),
            });
            this.textEditMonitor.startMonitoring(text, 30000, { targetPid });
          } catch (err) {
            debugLogger.debug("[AutoLearn] Failed to start monitoring", { error: err.message });
          }
        }, 500);
      }
      // ClipboardManager returns `restoreComplete` so main-process callers can
      // serialize subsequent clipboard work behind its delayed restore. A
      // Promise cannot cross Electron's IPC boundary, though, and renderer
      // callers need to know whether text was pasted, but not the delayed
      // clipboard restoration promise. Successful platform paths predate the
      // explicit `pasted` outcome; only the clipboard-only fallback and a held-back paste
      // (held modifiers or a missing or failed wl-copy) set false, each with a `reason`.
      return {
        success: true,
        pasted,
        ...(pasteResult?.reason ? { reason: pasteResult.reason } : {}),
      };
    });

    ipcMain.handle("check-accessibility-permission", async (_event, silent = false) => {
      return this.clipboardManager.checkAccessibilityPermissions(silent);
    });

    // Passes `true` to isTrustedAccessibilityClient to trigger the macOS system prompt
    ipcMain.handle("prompt-accessibility-permission", async () => {
      if (process.platform !== "darwin") return true;
      return systemPreferences.isTrustedAccessibilityClient(true);
    });

    ipcMain.handle("read-clipboard", async (event) => {
      return this.clipboardManager.readClipboard();
    });

    ipcMain.handle("write-clipboard", async (event, text) => {
      return this.clipboardManager.writeClipboard(text, event.sender);
    });

    ipcMain.handle("check-paste-tools", async () => {
      return this.clipboardManager.checkPasteTools();
    });

    // Voice drafts (chat input): persist a recorded buffer so the file-based
    // transcription pipeline (all providers) can consume it, then delete it.
    ipcMain.handle("save-temp-audio", async (_event, buffer) => {
      const tempPath = path.join(
        os.tmpdir(),
        `ow-voice-draft-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.webm`
      );
      fs.writeFileSync(tempPath, Buffer.from(buffer));
      voiceDraftAudioPaths.add(tempPath);
      return { success: true, path: tempPath };
    });

    ipcMain.handle("delete-temp-audio", async (_event, tempPath) => {
      // Only files this handler family created are deletable.
      const resolved = path.resolve(tempPath);
      const validPrefix = path.join(os.tmpdir(), "ow-voice-draft-");
      if (!resolved.startsWith(validPrefix)) {
        return { success: false, error: "Invalid temp path" };
      }
      voiceDraftAudioPaths.delete(resolved);
      try {
        fs.unlinkSync(resolved);
      } catch {
        // Already gone — fine.
      }
      return { success: true };
    });

    // Under `npm run dev` the Vite server dies with Electron, so a relaunched dev
    // instance would have no renderer: just quit there.
    ipcMain.handle("relaunch-app", async () => {
      if (process.env.NODE_ENV === "development") return app.quit();
      const { launcherPath, args } = getRelaunchOptions({
        argv: process.argv,
        protocol: this.oauthProtocol,
        appImagePath: process.env.APPIMAGE,
      });
      if (launcherPath) {
        const waiter = getRelaunchWaiter({ launcherPath, args, pid: process.pid });
        require("child_process")
          .spawn(waiter.file, waiter.args, {
            detached: true,
            stdio: "ignore",
            cwd: path.dirname(launcherPath), // never inside the directory being removed
          })
          .unref();
      } else {
        app.relaunch({ args });
      }
      app.quit();
    });

    ipcMain.handle("cleanup-app", async (event) => {
      const fs = require("fs");
      const os = require("os");
      const errors = [];
      const mainWindow = this.windowManager.mainWindow;

      // Stop services before deleting files they hold open
      try {
        await this.parakeetManager?.stopServer();
      } catch (e) {
        errors.push(`Parakeet stop: ${e.message}`);
      }
      try {
        this.whisperManager?.stopServer();
      } catch (e) {
        errors.push(`Whisper stop: ${e.message}`);
      }
      try {
        await this.diarizationManager?.shutdown();
      } catch (e) {
        errors.push(`Diarization stop: ${e.message}`);
      }
      try {
        await this.getSemanticSearch?.()?.stop();
      } catch (e) {
        errors.push(`Vector index stop: ${e.message}`);
      }
      try {
        const onnxWorkerClient = require("./onnxWorkerClient");
        await onnxWorkerClient.stop();
      } catch (e) {
        errors.push(`Embedding worker stop: ${e.message}`);
      }

      try {
        this.metaActivation?.dispose();
        this.metaActivation = null;
        const activationPath = path.join(app.getPath("userData"), "meta-activation.db");
        for (const suffix of ["", "-wal", "-shm"])
          fs.rmSync(activationPath + suffix, { force: true });
      } catch (e) {
        errors.push(`Activation data cleanup: ${e.message}`);
      }
      try {
        this.productEvents?.dispose();
        this.productEvents = null;
        require("./productEvents").createFileStore(productEventsFile()).erase();
      } catch (e) {
        errors.push(`Product events cleanup: ${e.message}`);
      }

      // Close DB connection before deleting the file
      try {
        this.databaseManager?.db?.close();
      } catch (e) {
        errors.push(`DB close: ${e.message}`);
      }

      // Delete audio files
      try {
        this.audioStorageManager.deleteAllAudio();
      } catch (e) {
        errors.push(`Audio delete: ${e.message}`);
      }

      // Delete downloaded models
      try {
        const { getModelsDirForService } = require("./modelDirUtils");
        const whisperDir = getModelsDirForService("whisper");
        if (fs.existsSync(whisperDir)) fs.rmSync(whisperDir, { recursive: true, force: true });
      } catch (e) {
        errors.push(`Whisper models: ${e.message}`);
      }
      try {
        await this.parakeetManager?.deleteAllParakeetModels();
      } catch (e) {
        errors.push(`Parakeet models: ${e.message}`);
      }
      // These caches are not owned by one account. Remove them only through
      // the explicit device-erasure path, never during normal account deletion.
      const homeCacheRoot = path.join(os.homedir(), ".cache", "openwhispr");
      for (const cacheName of ["embedding-models", "qdrant-data", "qdrant-data-dev", "yt-dlp"]) {
        try {
          fs.rmSync(path.join(homeCacheRoot, cacheName), { recursive: true, force: true });
        } catch (e) {
          errors.push(`${cacheName} cache: ${e.message}`);
        }
      }

      // Delete database file + WAL/SHM
      try {
        const dbPath = path.join(
          app.getPath("userData"),
          process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
        );
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
        if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
      } catch (e) {
        errors.push(`DB file: ${e.message}`);
      }

      // Delete device-wide settings and encrypted credentials.
      try {
        await this.environmentManager?.clearAllPersistedData();
      } catch (e) {
        errors.push(`Environment settings: ${e.message}`);
      }
      try {
        const tokenCleanup = tokenStore.clear();
        if (!tokenCleanup.success) throw new Error("Could not clear the stored bearer token");
      } catch (e) {
        errors.push(`Authentication token: ${e.message}`);
      }
      try {
        this.enterpriseIdentityManager?.clear();
      } catch (e) {
        errors.push(`Enterprise settings: ${e.message}`);
      }
      try {
        for (const fileName of [
          "workspace-policy.json",
          "managed-enterprise-config.json",
          "globe-preference-state.json",
          ".system-audio-permission",
          "account-scope-binding.json",
          "affiliate-candidate.json",
          "affiliate-candidate.json.tmp",
          "installed-models.json",
          "model-registry.json",
          "model-registry.json.backup",
          PAID_KEY_CHECKS_FILE,
        ]) {
          fs.rmSync(path.join(app.getPath("userData"), fileName), { force: true });
        }
      } catch (e) {
        errors.push(`Device setting files: ${e.message}`);
      }
      try {
        fs.rmSync(path.join(app.getPath("userData"), "enterprise-audio-keys"), {
          recursive: true,
          force: true,
        });
        for (const fileName of ["enterprise-audio-bootstrap.json", ENTERPRISE_AUDIO_DEVICE_ID_FILE])
          fs.rmSync(path.join(app.getPath("userData"), fileName), { force: true });
        await require("./enterpriseAudioBootstrap").removeClaimedBootstraps(
          app.getPath("userData")
        );
      } catch (error) {
        errors.push(`Enterprise audio credentials: ${error.message}`);
      }
      // "connectors" holds encrypted connector logins (Slack, Gmail), all
      // revoked above. "skills" holds the user's assistant skills, and
      // "skill-versions" the copies Undo restores.
      for (const directoryName of ["bin", "llama-cpp", "connectors", "skills", "skill-versions"]) {
        try {
          fs.rmSync(path.join(app.getPath("userData"), directoryName), {
            recursive: true,
            force: true,
          });
        } catch (e) {
          errors.push(`${directoryName} runtime: ${e.message}`);
        }
      }
      try {
        autoStart.setAutoStartEnabled(false);
      } catch (e) {
        errors.push(`Launch at login: ${e.message}`);
      }

      // Clear browser-held account/session state, including cookies, IndexedDB,
      // Cache Storage and localStorage persisted by any app window.
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          await win.webContents.session.clearStorageData();
          await win.webContents.session.clearCache();
        }
      } catch (e) {
        errors.push(`Browser data: ${e.message}`);
      }

      // Clear localStorage
      if (mainWindow?.webContents) {
        try {
          await mainWindow.webContents.executeJavaScript("localStorage.clear()");
        } catch (e) {
          errors.push(`localStorage: ${e.message}`);
        }
      }

      if (errors.length > 0) {
        debugLogger.warn("Cleanup completed with errors", { errors }, "cleanup");
      }

      return { success: errors.length === 0, message: "Cleanup completed", errors };
    });

    ipcMain.handle("update-hotkey", async (event, hotkey) => {
      return await this.windowManager.updateHotkey(hotkey);
    });

    ipcMain.handle("set-hotkey-listening-mode", async (event, enabled) => {
      if (enabled) {
        const captureWindow = BrowserWindow.fromWebContents(event.sender);
        // Only the control panel owns editable hotkey fields. Refocusing the
        // sender before the idempotence check also repairs a stale capture-mode
        // flag after Windows has moved foreground focus to another window.
        if (captureWindow === this.windowManager.controlPanelWindow) {
          focusWindowsHotkeyCaptureWindow(captureWindow);
        }
      }
      if (this._hotkeyCaptureMode === enabled) return { success: true, skipped: true };
      this._hotkeyCaptureMode = enabled;
      if (enabled && (process.platform === "win32" || process.platform === "linux")) {
        // Retired listeners cannot release an active Hold. End it before capture
        // mode blocks the stop event sent to the recording renderer.
        this.windowManager.resetWindowsPushState();
      }
      this.windowManager.setHotkeyListeningMode(enabled);
      ipcMain.emit("hotkey-listening-mode-changed", null, enabled);
      const hotkeyManager = this.windowManager.hotkeyManager;

      // Restore from slot state only. A freshly captured hotkey is registered by
      // its own update IPC (invoked before this one); re-binding it here would
      // overwrite the primary on DE backends or leak untracked registrations.
      const effectiveHotkey = hotkeyManager.getCurrentHotkey();

      const {
        isGlobeLikeHotkey,
        isModifierOnlyHotkey,
        isRightSideModifier,
        isMouseButtonHotkey,
      } = require("./hotkeyManager");
      const usesNativeListener = (hotkey) =>
        !hotkey ||
        isGlobeLikeHotkey(hotkey) ||
        isMouseButtonHotkey(hotkey) ||
        isModifierOnlyHotkey(hotkey) ||
        isRightSideModifier(hotkey);

      if (enabled) {
        // Entering capture mode — unregister ALL slots so none intercept keypresses.
        // Dictation is always active; meeting and agent may or may not be set.
        const allSlots = hotkeyManager.slots;
        for (const [slot, info] of allSlots) {
          // Native-listener entries (null accelerator) are handled by stopping
          // the key listeners below.
          for (const accel of info?.accelerators || []) {
            if (!accel) continue;
            debugLogger.log(
              `[IPC] Unregistering globalShortcut "${accel}" (slot "${slot}") for capture mode`
            );
            const { globalShortcut } = require("electron");
            try {
              globalShortcut.unregister(accel);
            } catch {}
          }
        }

        // On Windows, stop the Windows key listener
        if (process.platform === "win32" && this.windowsKeyManager) {
          debugLogger.log("[IPC] Stopping Windows key listener for hotkey capture mode");
          this.windowsKeyManager.stop();
        }

        // On Linux, stop the Linux key listener
        if (process.platform === "linux" && this.linuxKeyManager) {
          debugLogger.log("[IPC] Stopping Linux key listener for hotkey capture mode");
          this.linuxKeyManager.stop();
        }

        // On GNOME, unregister all native keybindings during capture
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager) {
          await hotkeyManager.gnomeManager.unregisterPushToTalk();
          for (const slot of [...hotkeyManager.gnomeManager.registeredSlots]) {
            debugLogger.log(
              `[IPC] Unregistering GNOME keybinding (slot "${slot}") for capture mode`
            );
            await hotkeyManager.gnomeManager.unregisterKeybinding(slot).catch((err) => {
              debugLogger.warn(`[IPC] Failed to unregister GNOME slot "${slot}":`, err.message);
            });
          }
        }

        // On Hyprland Wayland, unregister the keybinding during capture
        if (hotkeyManager.isUsingHyprland() && hotkeyManager.hyprlandManager) {
          debugLogger.log("[IPC] Unregistering Hyprland keybinding for hotkey capture mode");
          const unregistered = await hotkeyManager.hyprlandManager
            .unregisterKeybinding()
            .catch((err) => {
              debugLogger.warn("[IPC] Failed to unregister Hyprland keybinding:", err.message);
              return false;
            });
          if (!unregistered) {
            debugLogger.warn("[IPC] Hyprland keybinding remained active during capture");
          }
        }
      } else {
        // Exiting capture mode - re-register globalShortcut if not already registered
        // Skip for KDE/GNOME/Hyprland — updateHotkey handles re-registration via native path
        const usesNativePath =
          hotkeyManager.isUsingKDE() ||
          hotkeyManager.isUsingGnome() ||
          hotkeyManager.isUsingHyprland();
        if (!usesNativePath) {
          // Re-register every globalShortcut-backed dictation hotkey (the slot
          // may hold several).
          for (const hk of hotkeyManager.getSlotHotkeys("dictation")) {
            if (!hk || usesNativeListener(hk)) continue;
            const accelerator = hk;
            if (!globalShortcut.isRegistered(accelerator)) {
              debugLogger.log(
                `[IPC] Re-registering globalShortcut "${accelerator}" after capture mode`
              );
              const callback = this.windowManager.createHotkeyCallback();
              const registered = hotkeyManager.registerGlobalShortcut(accelerator, hk, callback);
              if (!registered) {
                debugLogger.warn(
                  `[IPC] Failed to re-register globalShortcut "${accelerator}" after capture mode`
                );
              }
            }
          }
        }

        // Re-sync native key listeners (Windows/Linux) across all hotkey slots now
        // that capture is done. Idempotent — reads the current slot hotkeys.
        this.windowManager.reconcileNativeKeyListeners();

        // On GNOME, re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering GNOME keybinding "${effectiveHotkey}" after capture mode`
          );
          await hotkeyManager.registerGnomeDictationHotkey(
            effectiveHotkey,
            this.windowManager.createHotkeyCallback()
          );
        }

        // On Hyprland Wayland, re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingHyprland() && hotkeyManager.hyprlandManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering Hyprland keybinding "${effectiveHotkey}" after capture mode`
          );
          await hotkeyManager.hyprlandManager.registerKeybinding(
            effectiveHotkey,
            this.windowManager.getActivationMode() === "push"
          );
        }

        // On KDE (X11 or Wayland), re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingKDE() && hotkeyManager.kdeManager && effectiveHotkey) {
          debugLogger.log(
            `[IPC] Re-registering KDE keybinding "${effectiveHotkey}" after capture mode`
          );
          const callback = this.windowManager.createHotkeyCallback();
          const result = await hotkeyManager.kdeManager.registerKeybinding(
            effectiveHotkey,
            "dictation",
            callback,
            this.windowManager.getActivationMode() === "push"
          );
          if (result !== true) {
            debugLogger.warn(
              `[IPC] Failed to re-register KDE keybinding "${effectiveHotkey}" after capture mode`,
              { result }
            );
          }
        }

        // Re-register non-dictation slots (meeting, agent) that were unregistered on capture enter
        for (const [slot, info] of hotkeyManager.slots) {
          const hotkeys = info?.hotkeys || [];
          if (slot === "dictation" || slot === "cancel" || hotkeys.length === 0 || !info?.callback)
            continue;
          debugLogger.log(
            `[IPC] Re-registering slot "${slot}" ("${hotkeys.join(", ")}") after capture mode`
          );
          const result = await hotkeyManager
            .registerSlot(slot, hotkeys, info.callback)
            .catch((err) => {
              debugLogger.warn(`[IPC] Failed to re-register slot "${slot}":`, err.message);
              return { success: false };
            });
          if (!result.success) {
            debugLogger.warn(`[IPC] Slot "${slot}" was not restored after capture`);
          }
        }
      }

      return { success: true };
    });

    ipcMain.handle("get-hotkey-mode-info", async (_event, requestedHotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const hotkey =
        typeof requestedHotkey === "string" && requestedHotkey.trim()
          ? requestedHotkey.split(",")[0].trim()
          : hotkeyManager.getCurrentHotkey();
      const isUsingNativeShortcut = this.windowManager.isUsingNativeShortcutHotkeys();
      const supportsPushToTalk = hotkeyManager.supportsPushToTalk(hotkey);

      return {
        isUsingGnome: this.windowManager.isUsingGnomeHotkeys(),
        isUsingHyprland: this.windowManager.isUsingHyprlandHotkeys(),
        isUsingKDE: this.windowManager.isUsingKDEHotkeys(),
        isUsingNativeShortcut,
        supportsPushToTalk,
        pushToTalkUnavailableReason: supportsPushToTalk
          ? null
          : hotkeyManager.getPushToTalkUnavailableReason(hotkey),
        // Lets the renderer show the setup box outside push mode, where the
        // disabled-Hold tooltip is the only other place this surfaces. Desktop
        // backends see their own hotkeys, so access matters only without one.
        linuxInputAccessDenied:
          hotkeyManager.reliesOnLinuxKeyListener() &&
          hotkeyManager.nativeListenerProbe().reason === "input_access_denied",
      };
    });

    ipcMain.handle("get-hyprland-config-status", async () => {
      if (!this.windowManager.isUsingHyprlandHotkeys()) return null;
      return this.windowManager.getHyprlandConfigStatus();
    });

    // Esc goes to the window that is recording (dictation or the agent
    // window), and only that window may take it back. A renderer that
    // reloads, crashes or closes can't, so it gives Esc back by going.
    const releaseCancelHotkey = () => {
      this._cancelHotkeyOwner = null;
      this.windowManager.hotkeyManager.unregisterSlot("cancel");
    };
    const watchedCancelOwners = new WeakSet();
    const watchCancelOwner = (owner) => {
      if (watchedCancelOwners.has(owner)) return;
      watchedCancelOwners.add(owner);
      const releaseIfOwner = () => {
        if (this._cancelHotkeyOwner === owner) releaseCancelHotkey();
      };
      // A committed main-frame navigation only: one will-navigate blocks keeps the renderer.
      owner.on("did-navigate", releaseIfOwner);
      owner.on("render-process-gone", releaseIfOwner);
      owner.once("destroyed", releaseIfOwner);
    };

    ipcMain.handle("register-cancel-hotkey", async (event, key) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const owner = event.sender;
      this._cancelHotkeyOwner = owner;
      watchCancelOwner(owner);
      return hotkeyManager.registerSlot("cancel", key, () => {
        if (!owner.isDestroyed()) owner.send("cancel-hotkey-pressed");
      });
    });

    ipcMain.handle("unregister-cancel-hotkey", async (event) => {
      const owner = this._cancelHotkeyOwner;
      if (owner && !owner.isDestroyed() && owner !== event.sender) return { success: false };
      releaseCancelHotkey();
      return { success: true };
    });

    ipcMain.handle("start-window-drag", async (event) => {
      return await this.windowManager.startWindowDrag();
    });

    ipcMain.handle("stop-window-drag", async (event) => {
      return await this.windowManager.stopWindowDrag();
    });

    ipcMain.handle("start-control-panel-drag", async () => {
      return await this.windowManager.startControlPanelDrag();
    });

    ipcMain.on("control-panel-release-ready", (event, requestId, ready) =>
      this.windowManager.completeControlPanelRelease(event.sender, requestId, ready)
    );

    ipcMain.handle("stop-control-panel-drag", async () => {
      return await this.windowManager.stopControlPanelDrag();
    });

    ipcMain.handle("open-external", async (event, url) => {
      try {
        const { protocol } = new URL(url);
        if (!["http:", "https:", "mailto:"].includes(protocol)) {
          return { success: false, error: `Blocked URL scheme: ${protocol}` };
        }
        await openExternalUrl(url);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-auto-start-enabled", async () => {
      try {
        return autoStart.getAutoStartState();
      } catch (error) {
        debugLogger.error("Error getting auto-start status:", error);
        return { enabled: false, requiresApproval: false };
      }
    });

    ipcMain.handle("set-auto-start-enabled", async (event, enabled) => {
      try {
        autoStart.setAutoStartEnabled(enabled);
        debugLogger.debug("Auto-start setting updated", { enabled });
        return { success: true };
      } catch (error) {
        debugLogger.error("Error setting auto-start:", error);
        return { success: false, error: error.message };
      }
    });

    handleProviderTranscription(
      "proxy-xai-transcription",
      serializeIpcError(async (event, { audioBuffer, language, keyterms }, signal) => {
        const apiKey = this.environmentManager.getXaiKey();
        if (!apiKey) {
          throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
            provider: "xAI",
            surface: "transcription",
          });
        }

        const formData = new FormData();
        const audioBlob = new Blob([Buffer.from(audioBuffer)], { type: "audio/webm" });
        formData.append("file", audioBlob, "audio.webm");
        const { XAI_STT_LANGUAGES } = await import("./transcriptionRoute.ts");
        if (language && language !== "auto" && XAI_STT_LANGUAGES.has(language)) {
          formData.append("language", language);
          formData.append("format", "true");
        }
        if (keyterms && keyterms.length > 0) {
          for (const term of keyterms) {
            formData.append("keyterm", term);
          }
        }

        const response = await proxyFetch(XAI_STT_URL, {
          signal,
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          debugLogger.warn("xAI transcription failed", {
            status: response.status,
            body: redactProviderBody(errorText),
          });
          throw providerHttpError({
            provider: "xAI",
            status: response.status,
            body: errorText,
            headers: response.headers,
            surface: "transcription",
          });
        }

        return await response.json();
      })
    );

    handleProviderTranscription(
      "proxy-assemblyai-transcription",
      serializeIpcError(
        async (event, { audioBuffer, mimeType, durationSeconds, language, keyterms }, signal) => {
          return await transcribeAssemblyAiDictation(event, {
            signal,
            audioBuffer,
            durationSeconds,
            contentType: mimeType,
            language,
            keyterms,
            apiKey: this.environmentManager.getAssemblyAIKey(),
          });
        }
      )
    );

    handleProviderTranscription(
      "proxy-mistral-transcription",
      serializeIpcError(async (event, { audioBuffer, model, language, contextBias }, signal) => {
        const apiKey = this.environmentManager.getMistralKey();
        if (!apiKey) {
          throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
            provider: "Mistral",
            surface: "transcription",
          });
        }

        const transcriptionModel = model || "voxtral-mini-latest";
        const formData = new FormData();
        const audioBlob = new Blob([Buffer.from(audioBuffer)], { type: "audio/webm" });
        formData.append("file", audioBlob, "audio.webm");
        formData.append("model", transcriptionModel);
        if (language && language !== "auto") {
          formData.append("language", language);
        }
        if (contextBias && contextBias.length > 0) {
          for (const token of contextBias) {
            formData.append("context_bias", token);
          }
        }

        const response = await proxyFetch(MISTRAL_TRANSCRIPTION_URL, {
          signal,
          method: "POST",
          headers: {
            "x-api-key": apiKey,
          },
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          debugLogger.warn("Mistral transcription failed", {
            status: response.status,
            body: redactProviderBody(errorText),
          });
          throw providerHttpError({
            provider: "Mistral",
            model: transcriptionModel,
            status: response.status,
            body: errorText,
            headers: response.headers,
            surface: "transcription",
          });
        }

        return await response.json();
      })
    );

    ipcMain.handle("get-corti-client-id", async () => {
      return this.environmentManager.getCortiClientId();
    });

    ipcMain.handle(
      "save-corti-client-id",
      saveSecretKey("getCortiClientId", "saveCortiClientId", "cortiClientId")
    );

    ipcMain.handle("get-corti-client-secret", async () => {
      return this.environmentManager.getCortiClientSecret();
    });

    ipcMain.handle(
      "save-corti-client-secret",
      saveSecretKey("getCortiClientSecret", "saveCortiClientSecret", "cortiClientSecret")
    );

    handleProviderTranscription(
      "proxy-corti-transcription",
      serializeIpcError(async (event, { audioBuffer, language, environment, tenant }, signal) => {
        const clientId = this.environmentManager.getCortiClientId();
        const clientSecret = this.environmentManager.getCortiClientSecret();
        if (!clientId || !clientSecret) {
          throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
            provider: "Corti",
            surface: "transcription",
          });
        }

        const { transcribeAudio } = require("./cortiTranscription");
        return await transcribeAudio({
          signal,
          environment,
          tenant,
          clientId,
          clientSecret,
          audioBuffer,
          language,
        });
      })
    );

    // Enclave attestation is Node-only, so batch transcription is proxied through main.
    handleProviderTranscription(
      "proxy-tinfoil-transcription",
      serializeIpcError(async (event, { audioBuffer, language, prompt }, signal) => {
        return await transcribeWithTinfoil({
          signal,
          audioBuffer: Buffer.from(audioBuffer),
          fileName: "audio.webm",
          contentType: "audio/webm",
          language,
          prompt,
          apiKey: this.environmentManager.getTinfoilKey(),
        });
      })
    );

    require("./selfHostedTranscriptionProxy").registerSelfHostedTranscriptionProxy(ipcMain);

    // Gemini's Interactions API takes JSON with inline base64 audio, not
    // OpenAI-compatible multipart, so batch transcription is proxied through main.
    handleProviderTranscription(
      "proxy-gemini-transcription",
      serializeIpcError(async (event, { audioBuffer, model, language, keyterms }, signal) => {
        return await transcribeWithGemini({
          signal,
          audioBuffer: Buffer.from(audioBuffer),
          model,
          contentType: "audio/webm",
          language,
          keyterms,
          apiKey: this.environmentManager.getGeminiKey(),
        });
      })
    );

    // ElevenLabs Scribe authenticates with xi-api-key and takes model_id /
    // language_code, so it has no OpenAI-compatible path either.
    handleProviderTranscription(
      "proxy-elevenlabs-transcription",
      serializeIpcError(async (event, { audioBuffer, model, language, keyterms }, signal) => {
        return await transcribeElevenLabsSpeech({
          signal,
          audioBuffer: Buffer.from(audioBuffer),
          model,
          fileName: "audio.webm",
          contentType: "audio/webm",
          language,
          keyterms,
          apiKey: this.environmentManager.getElevenlabsKey(),
        });
      })
    );

    // Headers and redirect mode for a request to the self-hosted speech server of `surface`
    // ("dictation" or "upload"), with the custom key for a route that takes one (Orukeet's).
    const selfHostedRequest = (surface, route) => {
      const key =
        route?.auth.keyRef === "custom" ? this.environmentManager.getCustomTranscriptionKey() : "";
      return selfHostedSttRequest(
        parseSelfHostedSttHeaders(this.environmentManager.getSelfHostedSttHeaders())[surface],
        key ? { Authorization: `Bearer ${key}` } : {}
      );
    };
    ipcMain.handle("get-self-hosted-stt-headers", () =>
      this.environmentManager.getSelfHostedSttHeaders()
    );
    ipcMain.handle(
      "save-self-hosted-stt-headers",
      saveSecretKey("getSelfHostedSttHeaders", "saveSelfHostedSttHeaders", "selfHostedSttHeaders")
    );
    ipcMain.handle("get-custom-transcription-key", async () => {
      return this.environmentManager.getCustomTranscriptionKey();
    });

    ipcMain.handle(
      "save-custom-transcription-key",
      saveSecretKey(
        "getCustomTranscriptionKey",
        "saveCustomTranscriptionKey",
        "customTranscriptionApiKey"
      )
    );

    ipcMain.handle("get-dictation-key", async () => {
      return this.environmentManager.getDictationKey();
    });

    ipcMain.handle("save-dictation-key", async (event, key) => {
      return this.environmentManager.saveDictationKey(key);
    });

    ipcMain.handle("get-active-dictation-key", async () => {
      const hotkeys = this.windowManager?.hotkeyManager?.getSlotHotkeys?.("dictation") ?? [];
      return hotkeys.length > 0 ? hotkeys.join(",") : null;
    });

    ipcMain.handle("get-effective-default-hotkey", async () => {
      return this.windowManager?.hotkeyManager?.getEffectiveDefaultHotkey() ?? null;
    });

    // The mode in effect: startup can fall back to Tap for this session while
    // the saved preference stays Hold for the next launch.
    ipcMain.handle("get-activation-mode", async () => {
      return this.windowManager.getActivationMode();
    });

    ipcMain.handle("save-activation-mode", async (event, mode) => {
      return this.environmentManager.saveActivationMode(mode);
    });

    ipcMain.handle("get-ui-language", async () => {
      return this.environmentManager.getUiLanguage();
    });

    ipcMain.handle("save-ui-language", async (event, language) => {
      return this.environmentManager.saveUiLanguage(language);
    });

    ipcMain.handle("set-ui-language", async (event, language) => {
      const result = this.environmentManager.saveUiLanguage(language);
      process.env.UI_LANGUAGE = result.language;
      changeLanguage(result.language);
      this.windowManager?.refreshLocalizedUi?.();
      this.getTrayManager?.()?.updateTrayMenu?.();
      return { success: true, language: result.language };
    });

    ipcMain.handle("save-all-keys-to-env", async () => {
      return this.environmentManager.saveAllKeysToEnvFile();
    });

    ipcMain.handle("sync-startup-preferences", async (event, prefs) => {
      const setVars = {};
      const clearVars = [];

      if (prefs.useLocalWhisper && prefs.model) {
        setVars.LOCAL_TRANSCRIPTION_PROVIDER = prefs.localTranscriptionProvider;
        if (prefs.language) setVars.DICTATION_LANGUAGE = prefs.language;
        if (isSherpaLocalProvider(prefs.localTranscriptionProvider)) {
          setVars.PARAKEET_MODEL = prefs.model;
          clearVars.push("LOCAL_WHISPER_MODEL");
        } else {
          setVars.LOCAL_WHISPER_MODEL = prefs.model;
          clearVars.push("PARAKEET_MODEL");
        }
      } else {
        clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
      }

      // TODO: drop legacy REASONING_PROVIDER / LOCAL_REASONING_MODEL clears once
      // the read fallback is removed (~2 releases after this lands).
      clearVars.push("REASONING_PROVIDER", "LOCAL_REASONING_MODEL");

      // A signed-in window whose workspace policy is still loading reports
      // unclamped modes, so it neither pre-warms nor stops the shared
      // llama-server; signed out, the policy never loads.
      if (prefs.policySettled || !this._hasActiveAccountScope()) {
        clearVars.push("CLEANUP_PROVIDER", "LOCAL_CLEANUP_MODEL");
        clearVars.push("DICTATION_AGENT_PROVIDER", "LOCAL_DICTATION_AGENT_MODEL");
      }

      this._syncStartupEnv(setVars, clearVars);
    });

    ipcMain.handle("get-log-level", async () => {
      return debugLogger.getLevel();
    });

    ipcMain.handle("app-log", async (event, entry) => {
      debugLogger.logEntry(entry);
      return { success: true };
    });

    const SYSTEM_SETTINGS_URLS = {
      darwin: {
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        sound: "x-apple.systempreferences:com.apple.preference.sound?input",
        accessibility:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        systemAudio:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        screenRecording:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
        loginItems: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
      },
      win32: {
        microphone: "ms-settings:privacy-microphone",
        sound: "ms-settings:sound",
        loginItems: "ms-settings:startupapps",
      },
    };

    const openSystemSettings = async (settingType) => {
      const platform = process.platform;
      const urls = SYSTEM_SETTINGS_URLS[platform];
      const useAppPicker =
        platform === "darwin" && settingType === "accessibility" && usesAppControlPicker();
      const url = useAppPicker ? PRIVACY_SETTINGS_URL : urls?.[settingType];

      if (!url) {
        // Platform doesn't support this settings URL
        const messages = {
          microphone: i18nMain.t("systemSettings.microphone"),
          sound: i18nMain.t("systemSettings.sound"),
          accessibility: i18nMain.t("systemSettings.accessibility"),
          systemAudio: i18nMain.t("systemSettings.systemAudio"),
          screenRecording: i18nMain.t("systemSettings.screenRecording"),
          loginItems: i18nMain.t("systemSettings.loginItems"),
        };
        return {
          success: false,
          error:
            messages[settingType] || `${settingType} settings are not available on this platform.`,
        };
      }

      try {
        await shell.openExternal(url);
        if (useAppPicker) void this.clipboardManager.requestPostEventAccess();
        return { success: true };
      } catch (error) {
        debugLogger.error(`Failed to open ${settingType} settings:`, error);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("open-microphone-settings", () => openSystemSettings("microphone"));
    ipcMain.handle("open-sound-input-settings", () => openSystemSettings("sound"));
    ipcMain.handle("get-system-default-microphone", (_event, options = {}) =>
      resolveSystemDefaultMicrophone({
        refresh: options?.refresh === true,
        wait: options?.wait !== false,
      })
    );
    ipcMain.handle("open-accessibility-settings", () => openSystemSettings("accessibility"));
    ipcMain.handle("open-system-audio-settings", () => openSystemSettings("systemAudio"));
    ipcMain.handle("open-screen-recording-settings", () => openSystemSettings("screenRecording"));
    ipcMain.handle("open-login-items-settings", () => openSystemSettings("loginItems"));

    // Snapshot the launch-time TCC status so a mid-session grant (which macOS
    // only honors after a relaunch) is detectable even if the renderer never
    // checked before the user granted.
    screenContextCapture.getAccessStatus();

    ipcMain.handle("check-screen-recording-access", () => screenContextCapture.getAccessResult());

    ipcMain.handle("request-screen-recording-access", async () => {
      const status = await screenContextCapture.requestAccess();
      if (process.platform === "darwin" && status !== "granted") {
        await openSystemSettings("screenRecording");
      }
      return screenContextCapture.getAccessResult();
    });

    ipcMain.handle("toggle-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.toggleMedia();
    });

    ipcMain.handle("pause-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.pauseMedia();
    });

    ipcMain.handle("resume-media-playback", () => {
      const mediaPlayer = require("./mediaPlayer");
      return mediaPlayer.resumeMedia();
    });

    ipcMain.handle("request-microphone-access", async () => {
      if (process.platform !== "darwin") {
        return { granted: true, status: "granted" };
      }
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return { granted };
    });

    ipcMain.handle("check-microphone-access", () => {
      if (process.platform !== "darwin") {
        return { granted: true, status: "granted" };
      }
      const status = systemPreferences.getMediaAccessStatus("microphone");
      return { granted: status === "granted", status };
    });

    const buildSystemAudioAccess = (partial = {}) => ({
      granted: false,
      status: "unsupported",
      mode: "unsupported",
      supportsPersistentGrant: false,
      supportsPersistentPortalGrant: false,
      supportsNativeCapture: false,
      supportsOnboardingGrant: false,
      requiresRuntimeSharePrompt: false,
      strategy: "unsupported",
      restoreTokenAvailable: false,
      portalVersion: null,
      ...partial,
    });

    const getLinuxSystemAudioAccess = async () => {
      const capability = await this.linuxPortalAudioManager?.getCapability().catch((error) => ({
        available: false,
        supportsPersistentGrant: false,
        supportsPersistentPortalGrant: false,
        supportsSystemAudio: false,
        supportsNativeCapture: false,
        portalVersion: null,
        error: error.message,
      }));
      const available = !!capability?.available;
      const supportsSystemAudio = !!capability?.supportsSystemAudio;
      const supportsNativeCapture = !!capability?.supportsNativeCapture;
      const granted = available && supportsSystemAudio && supportsNativeCapture;
      const helperError =
        typeof capability?.error === "string" &&
        !capability.error.includes("helper binary not found")
          ? capability.error
          : undefined;

      return buildSystemAudioAccess({
        granted,
        status: granted ? "granted" : "unknown",
        mode: granted ? "loopback" : "unsupported",
        supportsNativeCapture,
        strategy: granted ? "pipewire-loopback" : "unsupported",
        portalVersion: capability?.portalVersion ?? null,
        error: helperError,
      });
    };

    // System audio is always capturable on Windows: via the native WASAPI
    // process-loopback helper when available (hears every output device),
    // otherwise via Chromium's default-device loopback in the renderer.
    const getWindowsSystemAudioAccess = async ({ refreshCapability = false } = {}) => {
      const capability = await this.windowsLoopbackAudioManager
        ?.getCapability({ force: refreshCapability })
        .catch(() => ({
          available: false,
        }));
      const helperAvailable = !!capability?.available;

      return buildSystemAudioAccess({
        granted: true,
        status: "granted",
        mode: "loopback",
        supportsNativeCapture: helperAvailable,
        strategy: helperAvailable ? "wasapi-loopback" : "loopback",
      });
    };

    const getSystemAudioAccess = async () => {
      if (process.platform === "win32") {
        return getWindowsSystemAudioAccess();
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      const result = this.audioTapManager.checkAccess();
      return buildSystemAudioAccess({
        granted: result.granted,
        status: result.status,
        mode: "native",
        strategy: "native",
      });
    };

    ipcMain.handle("check-system-audio-access", () => getSystemAudioAccess());

    ipcMain.handle("permission-guide-verify-system-audio", async () => {
      if (!this.audioTapManager?.isSupported()) return buildSystemAudioAccess();
      const result = await this.audioTapManager.requestAccess();
      return buildSystemAudioAccess({ ...result, mode: "native", strategy: "native" });
    });

    ipcMain.handle("request-system-audio-access", async () => {
      if (process.platform === "win32") {
        return getWindowsSystemAudioAccess();
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      try {
        const result = await this.audioTapManager.requestAccess();
        if (result.granted) {
          return buildSystemAudioAccess({
            granted: true,
            status: "granted",
            mode: "native",
            strategy: "native",
          });
        }
      } catch {
        // Falls through to opening System Settings
      }

      await openSystemSettings("systemAudio");
      const status = this.audioTapManager.getPermissionStatus();
      return buildSystemAudioAccess({
        granted: false,
        status,
        mode: "native",
        strategy: "native",
      });
    });

    // In production, VITE_* env vars aren't available in the main process because
    // Vite only inlines them into the renderer bundle at build time. Load the
    // runtime-env.json that the Vite build writes to src/dist/ as a fallback.
    const runtimeEnv = (() => {
      const fs = require("fs");
      const envPath = path.join(__dirname, "..", "dist", "runtime-env.json");
      try {
        if (fs.existsSync(envPath)) return JSON.parse(fs.readFileSync(envPath, "utf8"));
      } catch {}
      return {};
    })();

    const getApiUrl = () =>
      process.env.OPENWHISPR_API_URL ||
      process.env.VITE_OPENWHISPR_API_URL ||
      runtimeEnv.VITE_OPENWHISPR_API_URL ||
      "";

    const getAuthUrl = () =>
      process.env.AUTH_URL ||
      process.env.VITE_AUTH_URL ||
      runtimeEnv.VITE_AUTH_URL ||
      "https://auth.openwhispr.com";

    const getSessionCookiesFromWindow = async (win) => {
      const scopedUrls = [getAuthUrl(), getApiUrl()].filter(Boolean);
      const cookiesByName = new Map();

      for (const url of scopedUrls) {
        try {
          const scopedCookies = await win.webContents.session.cookies.get({ url });
          for (const cookie of scopedCookies) {
            if (!cookiesByName.has(cookie.name)) {
              cookiesByName.set(cookie.name, cookie.value);
            }
          }
        } catch (error) {
          debugLogger.warn("Failed to read scoped auth cookies", {
            url,
            error: error.message,
          });
        }
      }

      // Fallback for older sessions where cookies are not URL-scoped as expected.
      if (cookiesByName.size === 0) {
        const allCookies = await win.webContents.session.cookies.get({});
        for (const cookie of allCookies) {
          if (!cookiesByName.has(cookie.name)) {
            cookiesByName.set(cookie.name, cookie.value);
          }
        }
      }

      const cookieHeader = [...cookiesByName.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");

      debugLogger.debug(
        "Resolved auth cookies for cloud request",
        {
          cookieCount: cookiesByName.size,
          scopedUrls,
        },
        "auth"
      );

      return cookieHeader;
    };

    // Bearer auth is preferred. Cookie fallback covers the brief window before
    // main.js's startup migration bridge runs (or if it failed for this user).
    const getAuthHeaderFromWindow = async (win) => {
      const token = tokenStore.get();
      if (token) return { Authorization: `Bearer ${token}` };
      const cookieHeader = win ? await getSessionCookiesFromWindow(win) : "";
      return cookieHeader ? { Cookie: cookieHeader } : {};
    };

    const getAuthHeader = async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return getAuthHeaderFromWindow(win);
    };

    // Honors system proxy via Electron's net stack. useSessionCookies:false so
    // Electron doesn't auto-attach jar cookies on top of our explicit headers.
    const controlOrigins = () =>
      [getApiUrl(), getAuthUrl()].filter(Boolean).map((url) => new URL(url).origin);
    const networkAllowed = (url) =>
      devicePolicyNetworkAllowed(this.effectivePolicyManager.getCurrent(), url, controlOrigins());
    this.isProductNetworkAllowed = networkAllowed;
    const proxyFetch = async (url, init = {}) => {
      const operation = this._productRequestContext.getStore();
      const assertAllowed = () => {
        if (
          !networkAllowed(url) ||
          (operation &&
            !runningOperationAllowed(
              this.effectivePolicyManager.getCurrent(),
              operation.accountId,
              app.getVersion(),
              operation.channel,
              operation.args
            ))
        )
          throw Object.assign(new Error("Blocked by device policy"), {
            code: "DEVICE_POLICY_BLOCKED",
          });
      };
      assertAllowed();
      const signals = [
        init.signal,
        operation?.signal,
        this._remoteProductRetirement?.signal,
      ].filter(Boolean);
      const response = await net.fetch(url, {
        ...init,
        useSessionCookies: false,
        signal: signals.length ? AbortSignal.any(signals) : undefined,
      });
      if (!operation?.preserveCreateReceipt || !response.ok) assertAllowed();
      return response;
    };
    const withPolicyHeaders = (headers) => withPolicyRequestHeaders(headers, app.getVersion());
    // Existing account-owned SQLite rows stay visible, but a stored credential
    // no longer starts an account session or a workspace policy lookup.
    const getScope = () => ({
      accountId: this.databaseManager.activeAccountId ?? null,
      authGeneration: tokenStore.getState().generation,
      authenticated: false,
    });
    this.effectivePolicyManager = createEffectivePolicyManager({
      devicePolicy: this.managedDevicePolicy,
      getScope,
      broadcast: (snapshot) => {
        // Known restrictions still apply while the workspace decision is pending.
        if (snapshot.status !== "loading" || !snapshot.deviceReady || snapshot.policy)
          this._audioFeaturePolicy?.update(snapshot);
        if (snapshot.success || snapshot.policy) this._meetingAdmission?.recheck();
        this._localModelPolicy?.update(snapshot);
        if (
          !snapshot.deviceReady ||
          snapshot.localOnly ||
          (snapshot.status === "error" && snapshot.managed)
        )
          this._stopRemoteProductWork();
        else if (snapshot.success || snapshot.policy) {
          this._retireDisallowedProductWork(snapshot);
        }
        broadcastToWindows("effective-policy-changed", snapshot);
      },
    });
    this.refreshEffectivePolicy = async () => this.effectivePolicyManager.getPolicy();
    this.getUpdatePolicy = async (options) => {
      await this.refreshEffectivePolicy(undefined, options);
      return this.effectivePolicyManager.getUpdatePolicy();
    };
    const { createAudioFeaturePolicy } = require("./audioFeaturePolicy");
    // CLI and tray-only sessions also refresh while a native server stays loaded.
    this._localModelPolicyRefreshTimer = this._localModelPolicy?.startPeriodicRefresh(
      5 * 60 * 1000
    );
    this._audioFeaturePolicy = createAudioFeaturePolicy({
      getPolicy: (event, options) => this.refreshEffectivePolicy(event, options),
      onBlocked: (purpose, code) => {
        if (purpose === "meeting") this._stopMeetingForPolicy?.(code);
      },
      onChange: () => this._syncMeetingDetectorPolicy?.(),
      logger: debugLogger,
    });

    // Signed in, load the policy now (from cache when offline): an app started
    // to the tray has no control panel to fetch it, and the tray item, the
    // meeting hotkey, and calendar reminders all read this snapshot.
    this._audioFeaturePolicy.update(this.effectivePolicyManager.getCurrent());

    registerProductHelpIpc({
      ipcMain,
      fetch: proxyFetch,
      canLookup: async () => {
        const snapshot = this.effectivePolicyManager.getCurrent();
        return remoteHelpPolicyState(snapshot, app.getVersion());
      },
      getBasics: async () => ({
        // checkAccess reads the cached permission verdict; it never requests access.
        systemAudioPermission:
          process.platform === "darwin"
            ? this.audioTapManager?.checkAccess()?.status || "unknown"
            : "unknown",
        platform: process.platform,
        version: app.getVersion(),
        microphonePermission:
          process.platform === "linux"
            ? "unknown"
            : systemPreferences.getMediaAccessStatus("microphone"),
        accessibilityPermission:
          process.platform === "darwin"
            ? (await this.clipboardManager.checkAccessibilityPermissions(true))
              ? "granted"
              : "not-granted"
            : "not-applicable",
      }),
    });
    const { createEnterpriseAudioConfigChangedError } = require("./enterpriseAudioRuntime");
    // _enterpriseAudioOwner is the last binding enterprise audio ran under. A
    // token rotation drops the binding (its auth generation is stale) but keeps
    // the owner, so a snapshot for the same account, workspace and config
    // doesn't retire the running work.
    const sameEnterpriseAudioScope = (previous, next) =>
      previous?.accountId === next.accountId && previous?.workspaceId === next.workspaceId;
    // Personal uploads also have a workspace owner, even without an enterprise
    // audio binding. Reconfirming the same personal workspace keeps them alive.
    let dictationWorkspaceBinding;
    const observeDictationWorkspace = (scope) => {
      if (
        !dictationWorkspaceBinding ||
        !sameEnterpriseAudioScope(dictationWorkspaceBinding, scope)
      ) {
        dictationWorkspaceBinding?.controller.abort(createEnterpriseAudioConfigChangedError());
        dictationWorkspaceBinding = { ...scope, controller: new AbortController() };
      }
      return dictationWorkspaceBinding.controller.signal;
    };
    const getEnterpriseAudioRequest = async (_event, context, routing = "bound") => {
      if (!context && (routing === "load" || routing === "personal")) return null;
      throw Object.assign(new Error("Account services were removed from this build"), {
        code: "ACCOUNT_SERVICES_REMOVED",
      });
    };
    // Even callers that only use verbatim text cause this endpoint to run cleanup.
    const dictationWorkspace = () => {
      const databaseWorkspace = this.databaseManager.activeWorkspaceId;
      const enterpriseWorkspace = this._enterpriseAudioScope?.workspaceId;
      if (databaseWorkspace && enterpriseWorkspace && databaseWorkspace !== enterpriseWorkspace)
        throw createEnterpriseAudioConfigChangedError();
      return databaseWorkspace ?? enterpriseWorkspace ?? null;
    };
    const captureDictationWorkspace = () => {
      try {
        return observeDictationWorkspace({
          accountId: getScope().accountId,
          workspaceId: dictationWorkspace(),
        });
      } catch (error) {
        // A disagreement at dispatch stays a refusal even if the scopes later agree.
        return AbortSignal.abort(error);
      }
    };
    const getDictationCleanupSignal = async (_event, workspaceSignal) => {
      workspaceSignal.throwIfAborted();
      return workspaceSignal;
    };
    const transcribeAssemblyAiDictation = async (event, options) => {
      options.signal.throwIfAborted();
      const operation = this._productRequestContext.getStore();
      const cleanupSignal = await getDictationCleanupSignal(
        event,
        operation.dictationWorkspaceAtDispatch
      );
      operation.dictationCleanupSignal = cleanupSignal;
      const signal = AbortSignal.any([options.signal, cleanupSignal]);
      signal.throwIfAborted();
      try {
        return await transcribeAssemblyAiRecording(
          { ...options, signal, split: require("./ffmpegUtils").splitAudioFile },
          proxyFetch
        );
      } finally {
        // A transport can finish reading an already-buffered response after retirement.
        signal.throwIfAborted();
      }
    };
    const resolveEnterpriseRuntime = async (event, provider, model, config = {}) => {
      const manual = {
        provider,
        model,
        apiKey: config.apiKey || "",
        enterprise: require("./enterpriseProviderErrors").pickEnterpriseConfig(config),
      };
      const context = config.managedContext;
      if (!context) return manual;
      const authHeaders = await getAuthHeader(event);
      const resolved = await this.enterpriseIdentityManager.resolveProvider({
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        expectedAuthGeneration: context.authGeneration,
        inferenceScope: context.inferenceScope,
        setupMode: context.setupMode,
        authHeaders,
      });
      if (!resolved.managed) {
        throw Object.assign(
          new Error("Managed enterprise configuration changed. Retry the request."),
          { code: "MANAGED_CONFIG_CHANGED" }
        );
      }
      if (
        resolved.provider !== context.provider ||
        resolved.generation !== context.generation ||
        resolved.version !== context.providerVersion
      ) {
        throw Object.assign(
          new Error("Managed enterprise configuration changed. Retry the request."),
          { code: "MANAGED_CONFIG_CHANGED" }
        );
      }
      if (context.inferenceScope === "transcription") {
        const audio = await this.enterpriseAudioRuntime.resolve(
          await getEnterpriseAudioRequest(event, context),
          "batch"
        );
        if (
          !audio ||
          audio.generation !== context.generation ||
          audio.providerVersion !== context.providerVersion ||
          audio.provider !== context.provider
        )
          throw Object.assign(new Error("Enterprise audio configuration changed"), {
            code: "MANAGED_CONFIG_CHANGED",
          });
        return {
          provider: audio.provider,
          model: audio.model,
          apiKey: "",
          enterprise: { audioProfile: audio },
        };
      }
      if (resolved.provider === "bedrock") {
        return {
          provider: resolved.provider,
          model: resolved.model,
          apiKey: "",
          enterprise: {
            bedrockRegion: resolved.config.region,
            managedCredentialProvider: resolved.credentialProvider,
          },
        };
      }
      return {
        provider: resolved.provider,
        model: resolved.model,
        apiKey: "",
        enterprise: {
          azureEndpoint: resolved.config.endpoint,
          azureApiVersion: resolved.config.apiVersion,
          managedTokenProvider: resolved.tokenProvider,
        },
      };
    };
    const { createManagedTranscriptionExecutor } = require("./managedTranscriptionExecutor");
    const executeManagedTranscription = createManagedTranscriptionExecutor({
      resolveEnterpriseRuntime,
      proxyFetch,
      buildUrl: async (endpoint, deployment, apiVersion) => {
        const { buildManagedAzureTranscriptionUrl } = await import("../utils/urlUtils.ts");
        return buildManagedAzureTranscriptionUrl(endpoint, deployment, apiVersion);
      },
    });
    this.executeManagedTranscription = executeManagedTranscription;
    const transcribeManagedAudio = async (event, route, input) => {
      const { runAbortableOperation } = require("./enterpriseProviderErrors");
      const runtime = await runAbortableOperation(
        () =>
          resolveEnterpriseRuntime(event, route.provider, null, {
            managedContext: route.context,
          }),
        input.signal
      );
      const { transcribeManagedAudioFile } = require("./managedAudioFileTranscription");
      const signal = AbortSignal.any(
        [input.signal, runtime.enterprise.audioProfile.signal].filter(Boolean)
      );
      const result = await transcribeManagedAudioFile({
        ...input,
        signal,
        maxUploadBytes:
          route.provider === "azure"
            ? 25 * 1024 * 1024
            : Math.min(
                runtime.enterprise.audioProfile.section.maxUploadBytes ?? 25 * 1024 * 1024,
                100 * 1024 * 1024
              ),
        transcribe: (audioBuffer, fileName, contentType) =>
          executeManagedTranscription(event, route, {
            audioBuffer,
            fileName,
            contentType,
            prompt: input.prompt,
            signal,
          }),
      });
      return {
        ...result,
        ...(result.failedChunks
          ? {
              warning: i18nMain.t("enterprise.audio.partialUpload", { count: result.failedChunks }),
            }
          : {}),
      };
    };
    // Managed provider discovery is retired. BYOK/self-hosted routes use their
    // own settings, so opening Notes needs no cloud request or failure toast.
    const handleSttConfigRequest = async () => ({ success: true, providers: [] });
    const handleNoteRecordingConfigRequest = async () => ({ success: true, providers: [] });

    handleProduct("retry-transcription", async (event, id, settings) => {
      // The account, not its token: a rotated token is the same owner, and a
      // local retry needs no sign-in at all.
      const accountId = this.databaseManager.activeAccountId;
      const assertRetryCurrent = () => {
        if (this.databaseManager.activeAccountId !== accountId) {
          throw Object.assign(
            new Error("Authentication context changed during transcription retry"),
            {
              code: "AUTH_CONTEXT_CHANGED",
            }
          );
        }
      };
      const recording = this.databaseManager.getTranscriptionById(id);
      if (!recording) {
        return { success: false, error: "Audio file not found" };
      }
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      if (!buffer) return { success: false, error: "Audio file not found" };
      let providerErrorContext = null;
      try {
        let result;
        const preferredLanguage =
          recording.route_kind === "translation"
            ? settings?.translationSourceLanguage
            : settings?.preferredLanguage;
        const language =
          preferredLanguage && preferredLanguage !== "auto"
            ? preferredLanguage.split("-")[0]
            : undefined;
        const { resolveTranscriptionRoute, batchTranscriptionHttpError } =
          await import("./transcriptionRoute.ts");
        assertRetryCurrent();
        const { convertBufferToWav, isWavFormat } = require("./ffmpegUtils");
        // Renderer pre-flight owns policy; retry re-routes stored audio through
        // whatever is selected NOW.
        const route = resolveTranscriptionRoute({
          settings: { ...settings, preferredLanguage },
          policy: productPolicyState(this.effectivePolicyManager.getCurrent(), app.getVersion()),
          providers: transcriptionProviderBaseUrls(),
          managed: settings?.managed,
        });
        const usesCloud =
          route.transport !== "managed" &&
          route.transport !== "local" &&
          route.provider !== "self-hosted" &&
          settings?.cloudTranscriptionMode === "openwhispr";
        const signal = await trackTranscriptionRoute(
          usesCloud ? { transport: "cloud" } : route,
          settings?.transcriptionMode
        );

        // An error route is fatal unless OpenWhispr cloud is selected — a
        // leftover BYOK misconfiguration must not block the cloud pipeline.
        if (
          route.transport === "error" &&
          (settings?.transcriptionMode === "self-hosted" ||
            settings?.cloudTranscriptionMode !== "openwhispr")
        ) {
          const err = new Error(route.message);
          if (route.code) err.code = route.code;
          if (route.messageKey) err.messageKey = route.messageKey;
          throw err;
        }

        // Mirrors the branch order below: self-hosted wins over OpenWhispr
        // cloud, which wins over the BYOK providers. Managed, local and cloud
        // failures keep their own shape.
        if (
          (route.transport === "http-batch" && route.provider === "self-hosted") ||
          ((route.transport === "http-batch" || route.transport === "proxied") &&
            settings?.cloudTranscriptionMode !== "openwhispr")
        ) {
          providerErrorContext = {
            provider: transcriptionProviderName(route.provider),
            selfHosted: route.provider === "self-hosted" || route.provider === "custom",
            model: route.model,
            surface: "transcription",
          };
        }

        if (route.transport === "managed") {
          const transcription = await transcribeManagedAudio(event, route, {
            signal,
            audioBuffer: buffer,
            fileName: "audio.webm",
            contentType: "audio/webm",
          });
          result = {
            ...transcription,
            source: `${route.provider}-managed`,
            model: route.deployment,
          };
        } else if (route.transport === "http-batch" && route.provider === "self-hosted") {
          const formData = new FormData();
          formData.append("file", new Blob([buffer], { type: "audio/webm" }), "audio.webm");
          if (route.model) {
            formData.append("model", route.model);
          }
          if (route.language) {
            formData.append("language", route.language);
          }

          // Retries re-run dictation audio through dictation's server.
          const response = await proxyFetch(route.endpoint, {
            method: "POST",
            ...selfHostedRequest("dictation", route),
            body: formData,
          });
          if (!response.ok) {
            const errorText = await response.text();
            debugLogger.warn("Self-hosted retry failed", {
              status: response.status,
              body: redactProviderBody(errorText),
            });
            throw providerHttpError({
              ...providerErrorContext,
              status: response.status,
              body: errorText,
              headers: response.headers,
            });
          }
          const data = await response.json();
          result = {
            text: data?.text,
            source: "self-hosted",
            model: route.model,
          };
        } else if (route.transport === "local") {
          throw Object.assign(
            new Error("Configure a self-hosted transcription endpoint in Settings."),
            {
              code: "LOCAL_TRANSCRIPTION_RETIRED",
            }
          );
        } else if (usesCloud) {
          const win = BrowserWindow.fromWebContents(event.sender);
          if (win) {
            const authHeader = await getAuthHeaderFromWindow(win);
            assertRetryCurrent();
            if (Object.keys(authHeader).length) {
              const apiUrl = getApiUrl();
              if (apiUrl) {
                const multipartFields = {
                  language,
                  clientType: "desktop",
                  source: "dictation",
                  appVersion: app.getVersion(),
                  sessionId: this.sessionId,
                };
                if (buffer.length > CLOUD_INLINE_LIMIT) {
                  const { text, warning } = await chunkedCloudTranscribe({
                    signal,
                    buffer,
                    apiUrl,
                    policyHeaders: withPolicyHeaders(authHeader),
                    multipartFields,
                  });
                  result = { text, source: "openwhispr", model: "cloud", warning };
                } else {
                  const { body, boundary } = buildMultipartBody(
                    buffer,
                    "audio.webm",
                    "audio/webm",
                    multipartFields
                  );
                  const url = new URL(`${apiUrl}/api/transcribe`);
                  const data = await postMultipart(
                    url,
                    body,
                    boundary,
                    withPolicyHeaders(authHeader),
                    {
                      signal: AbortSignal.any(
                        [signal, AbortSignal.timeout(CLOUD_UPLOAD_TIMEOUT_MS)].filter(Boolean)
                      ),
                      session: getInlineCloudUploadSession(),
                    }
                  );
                  const responseData = interpretTranscribeResponse(data);
                  result = {
                    text: responseData.text,
                    source: "openwhispr",
                    model: "cloud",
                  };
                }
              }
            }
          }
        } else if (route.transport === "proxied" && route.provider === "tinfoil") {
          // Attested transport, so this can't reuse the generic fetch below.
          const { text, model } = await transcribeWithTinfoil({
            signal,
            audioBuffer: buffer,
            fileName: "audio.webm",
            contentType: "audio/webm",
            language: route.language,
            apiKey: this.environmentManager.getTinfoilKey(),
          });
          result = { text, source: "tinfoil", model };
        } else if (route.transport === "proxied" && route.provider === "corti") {
          // Corti uses OAuth + an interaction-based REST flow, so it can't use
          // the generic fetch below.
          const clientId = this.environmentManager.getCortiClientId();
          const clientSecret = this.environmentManager.getCortiClientSecret();
          if (!clientId || !clientSecret) {
            throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
              provider: "Corti",
              surface: "transcription",
            });
          }
          const { transcribeAudio } = require("./cortiTranscription");
          const { text } = await transcribeAudio({
            signal,
            environment: route.cortiEnvironment,
            tenant: route.cortiTenant,
            clientId,
            clientSecret,
            audioBuffer: buffer,
            language: route.language,
          });
          result = { text, source: "corti", model: route.model };
        } else if (route.transport === "proxied" && route.provider === "gemini") {
          if (route.sizeCapBytes && buffer.byteLength > route.sizeCapBytes) {
            throw new Error(byokSizeCapError(route.sizeCapBytes));
          }
          const { text } = await transcribeWithGemini({
            signal,
            audioBuffer: buffer,
            model: route.model,
            contentType: "audio/webm",
            language: route.language,
            apiKey: this.environmentManager.getGeminiKey(),
          });
          result = { text, source: "gemini", model: route.model };
        } else if (route.transport === "proxied" && route.provider === "assemblyai") {
          const { text, cleanedText } = await transcribeAssemblyAiDictation(event, {
            signal,
            audioBuffer: buffer,
            durationSeconds: recording.audio_duration_ms / 1000,
            contentType: isWavFormat(buffer) ? "audio/wav" : "audio/webm",
            language: route.language,
            keyterms: settings?.keyterms,
            apiKey: this.environmentManager.getAssemblyAIKey(),
          });
          result = { text, cleanedText, source: "assemblyai", model: route.model };
        } else if (route.transport === "proxied" && route.provider === "elevenlabs") {
          // No size check: the cap is the upload screen's, not ElevenLabs', and dictation
          // already sent this recording once at this size.
          const { text } = await transcribeElevenLabsSpeech({
            signal,
            audioBuffer: buffer,
            model: route.model,
            fileName: "audio.webm",
            contentType: "audio/webm",
            language: route.language,
            apiKey: this.environmentManager.getElevenlabsKey(),
          });
          result = { text, source: "elevenlabs", model: route.model };
        } else {
          // mistral/xai have no OpenAI-compatible endpoint — main talks to them
          // directly; everything else consumes the route endpoint as-is.
          const provider = route.provider;
          const endpoint =
            provider === "mistral"
              ? MISTRAL_TRANSCRIPTION_URL
              : provider === "xai"
                ? XAI_STT_URL
                : route.endpoint;
          const apiKey =
            provider === "mistral"
              ? this.environmentManager.getMistralKey()
              : provider === "xai"
                ? this.environmentManager.getXaiKey()
                : route.auth.keyRef === "custom"
                  ? this.environmentManager.getCustomTranscriptionKey()
                  : route.auth.keyRef === "groq"
                    ? this.environmentManager.getGroqKey()
                    : route.auth.keyRef === "openrouter"
                      ? this.environmentManager.getOpenrouterKey()
                      : this.environmentManager.getOpenAIKey();
          if (!apiKey && provider !== "custom") {
            throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
              provider: transcriptionProviderName(provider),
              surface: "transcription",
            });
          }

          // The renderer re-encodes WebM before uploading to a Custom endpoint
          // (src/utils/audioContainer.ts); retries re-upload stored audio from
          // the main process, so without the same step here every retry of a
          // dictation that failed for that reason fails again -- which is the
          // exact recovery a user reaches for after hitting it.
          let uploadBuffer = buffer;
          let uploadType = "audio/webm";
          let uploadName = "audio.webm";
          if (provider === "custom" && buffer.length && !isWavFormat(buffer)) {
            try {
              const wavBuffer = await convertBufferToWav(buffer, { signal });
              // Match fresh dictation: PCM expansion must not break an upload
              // that the endpoint could accept in its original container.
              if (wavBuffer.length <= route.sizeCapBytes) {
                uploadBuffer = wavBuffer;
                uploadType = "audio/wav";
                uploadName = "audio.wav";
              }
            } catch (conversionError) {
              // Fail open, matching the renderer: an unconverted retry is no
              // worse than today's behaviour.
              debugLogger.warn("WAV re-encode failed on retry; uploading stored container", {
                error: conversionError?.message,
              });
            }
          }

          assertRetryCurrent();
          const formData = new FormData();
          formData.append("file", new Blob([uploadBuffer], { type: uploadType }), uploadName);
          if (provider === "xai") {
            // xAI STT does not accept a model field; the route pre-filters language
            if (route.language) {
              formData.append("language", route.language);
              formData.append("format", "true");
            }
          } else {
            formData.append("model", route.model);
            if (route.language) formData.append("language", route.language);
          }
          const requestsSegments = supportsWhisperSegments(provider, route.model);
          if (requestsSegments) formData.append("response_format", "verbose_json");
          const headers = {};
          if (provider === "mistral") {
            headers["x-api-key"] = apiKey;
          } else if (apiKey) {
            if (route.transport === "http-batch" && route.auth.scheme === "azure-api-key") {
              headers["api-key"] = apiKey;
            } else {
              headers.Authorization = `Bearer ${apiKey}`;
            }
          }

          const response = await proxyFetch(endpoint, { method: "POST", headers, body: formData });
          if (!response.ok) {
            const errorText = await response.text();
            debugLogger.warn("Retry transcription provider failed", {
              provider,
              status: response.status,
              body: redactProviderBody(errorText),
            });
            throw Object.assign(
              providerHttpError({
                ...providerErrorContext,
                status: response.status,
                body: errorText,
                headers: response.headers,
              }),
              batchTranscriptionHttpError(response.status, endpoint)
            );
          }
          const data = await response.json();
          result = {
            text: requestsSegments ? dropNoSpeechSegments(data) : data?.text,
            source: provider,
            model: route.model,
          };
        }

        assertRetryCurrent();
        if (result?.success === false) {
          throw localTranscriptionFailure(result);
        }
        if (!result) {
          return { success: false, error: "No transcription engine available" };
        }
        // ElevenLabs Scribe answers silence with "[pause]" instead of nothing.
        if (!result.text || result.text.trim() === SCRIBE_SILENCE_MARKER) {
          throw Object.assign(new Error("No speech detected in audio"), {
            code: "NO_SPEECH_DETECTED",
          });
        }

        const operation = this._productRequestContext.getStore();
        operation.signal.throwIfAborted();
        // A token rotated mid-decode leaves the verdict loading until its own lands.
        let snapshot = this.effectivePolicyManager.getCurrent();
        if (snapshot.status === "loading") {
          snapshot = await this.refreshEffectivePolicy(event);
          operation.signal.throwIfAborted();
          assertRetryCurrent();
        }
        if (!productOperationAllowed(snapshot, app.getVersion(), operation.channel, operation.args))
          throw Object.assign(new Error("Blocked by device policy"), {
            code: "DEVICE_POLICY_BLOCKED",
          });
        operation.dictationCleanupSignal?.throwIfAborted();
        this.databaseManager.updateTranscriptionText(id, result.text, result.text);
        this.databaseManager.updateTranscriptionStatus(id, "completed");
        const providerName = result.source || "local";
        const modelName = result.model || null;
        const existingRow = this.databaseManager.getTranscriptionById(id);
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: existingRow?.audio_duration_ms ?? null,
          provider: providerName,
          model: modelName,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) {
          setImmediate(() => {
            if (
              this.databaseManager.activeAccountId !== accountId ||
              operation.dictationCleanupSignal?.aborted
            )
              return;
            const transcription = this.databaseManager.getTranscriptionById(id);
            if (!transcription) return;
            broadcastToWindows("transcription-updated", transcription);
            // A row that just reached "completed" is newly eligible.
            void this._ensureAnalyticsHistoryBackfilled();
          });
        }
        // A partial result (local truncation, lost cloud chunks) still replaces the
        // row, as dictation keeps it, but the renderer must say so.
        return {
          success: true,
          transcription: updated,
          ...(result.warning ? { warning: result.warning } : {}),
          ...(result.cleanedText ? { cleanedText: result.cleanedText } : {}),
        };
      } catch (rawError) {
        const error = providerErrorContext
          ? asProviderError(rawError, providerErrorContext)
          : rawError;
        debugLogger.error(
          "Retry transcription failed",
          { id, error: error.message, code: error.code },
          "audio-storage"
        );
        if (error.code === "NO_SPEECH_DETECTED" && !error.messageKey) {
          // Every engine reports silence with this code, so it is translated
          // here once rather than per route.
          error.messageKey = "notes.upload.noSpeechDetected";
        }
        if (error.code) {
          return { success: false, ...ipcErrorFields(error) };
        }
        return { success: false, error: error.message };
      }
    });

    // Runs inside a start the policy already allowed, or a live meeting.
    const assertMeetingAllowed = () => {
      const denied = this._audioFeaturePolicy.activeFailure("meeting");
      if (denied) throw Object.assign(new Error(denied.error), { code: denied.code });
      const attendeeRefusal = this._meetingAdmission?.activeRefusal();
      if (attendeeRefusal)
        throw Object.assign(new Error(attendeeRefusal), { code: attendeeRefusal });
      if (this._activeLocalMeetingLease)
        this._localModelPolicy.assertCurrent(this._activeLocalMeetingLease);
    };
    const enterpriseMeetingConnectOptions = async (event, options) => {
      if (options.provider !== "enterprise-realtime") return {};
      const runtime = await this.enterpriseAudioRuntime.resolve(
        await getEnterpriseAudioRequest(event, options.managedContext),
        "realtime"
      );
      const context = options.managedContext;
      if (
        !runtime ||
        runtime.generation !== context?.generation ||
        runtime.providerVersion !== context?.providerVersion ||
        runtime.provider !== context?.provider
      )
        throw Object.assign(new Error("Enterprise audio configuration changed"), {
          code: "MANAGED_CONFIG_CHANGED",
        });
      return {
        preconfigured: false,
        protocol: runtime.protocol,
        inputRate: runtime.section.sampleRate,
        connectTimeoutMs: runtime.network.connectTimeoutMs,
        sessionMaxMs: runtime.network.sessionMaxMs,
        idleTimeoutMs: runtime.network.idleTimeoutMs,
        createSocket: () => runtime.createSocket(),
      };
    };
    const fetchRealtimeToken = async (event, options, { streams } = {}) => {
      if (options.purpose === "meeting") assertMeetingAllowed();
      if (options.provider === "enterprise-realtime") {
        await enterpriseMeetingConnectOptions(event, options);
        assertMeetingAllowed();
        return streams
          ? Array.from({ length: streams }, () => "enterprise-device-credential")
          : "enterprise-device-credential";
      }

      const token = await fetchRealtimeTokenForProvider(
        options.provider,
        {
          environmentManager: this.environmentManager,
          proxyFetch,
          postServerToken: async () => {
            throw Object.assign(new Error("OpenWhispr Cloud is no longer available"), {
              code: "NO_API",
            });
          },
          mintCortiToken: (tokenOptions) => this._mintStoredCortiToken(tokenOptions),
        },
        options,
        { streams }
      ).catch((error) => {
        this._audioFeaturePolicy.refreshOnRefusal(event, error);
        throw error;
      });
      const effective = this.effectivePolicyManager.getCurrent();
      if (
        effective.localOnly ||
        !productOperationAllowed(effective, app.getVersion(), "meeting-transcription", [options])
      )
        throw Object.assign(new Error(policyBlockedMessage(effective)), {
          code: "DEVICE_POLICY_BLOCKED",
        });
      if (options.purpose === "meeting") assertMeetingAllowed();
      return token;
    };

    const fs = require("fs");

    let dictationPreviewMode = false;
    let dictationPreviewTimer = null;
    let dictationPreviewSessionActive = false;
    // Online-runtime models stream here instead of the 1.5s chunked path.
    let dictationPreviewStream = null;
    // Cloud partials can arrive faster than the preview window is created. Keep
    // preview updates, completion, and dismissal ordered so a late partial can
    // never overwrite the final result or reopen a dismissed window.
    let dictationPreviewOperation = Promise.resolve();

    const queueDictationPreviewOperation = (operation) => {
      const result = dictationPreviewOperation.catch(() => {}).then(operation);
      dictationPreviewOperation = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    };

    const resetDictationPreviewState = ({ preserveSession = false } = {}) => {
      if (dictationPreviewTimer) {
        clearInterval(dictationPreviewTimer);
        dictationPreviewTimer = null;
      }
      if (dictationPreviewStream) {
        dictationPreviewStream.abort();
        dictationPreviewStream = null;
      }
      dictationPreviewMode = false;
      if (!preserveSession) {
        dictationPreviewSessionActive = false;
      }
    };

    this._stopLocalDictationPreview = () => {
      if (!dictationPreviewMode) return;
      resetDictationPreviewState();
      this.windowManager.hideTranscriptionPreview();
    };

    const setupDictationCallbacks = (streaming, event) => {
      const sessionScoped =
        streaming instanceof OrukeetStreaming || streaming instanceof VietAsrStreaming;
      const canNotify = () =>
        !event.sender.isDestroyed?.() && (!sessionScoped || this._dictationStreaming === streaming);
      if (sessionScoped) {
        const ownerGone = () => {
          streaming.disconnect().catch(() => {});
          if (this._dictationStreaming === streaming) this._dictationStreaming = null;
        };
        event.sender.once?.("destroyed", ownerGone);
        streaming.onClose = () => event.sender.removeListener?.("destroyed", ownerGone);
      }
      streaming.onPartialTranscript = (text) => {
        if (!canNotify()) return;
        event.sender.send("dictation-realtime-partial", text);
        if (this._dictationPreviewEnabled && (text || streaming instanceof VietAsrStreaming)) {
          this.windowManager.showTranscriptionPreview(text);
        }
      };
      streaming.onFinalTranscript = (text) => {
        if (canNotify()) event.sender.send("dictation-realtime-final", text);
      };
      streaming.onLanguage = (metadata) => {
        if (canNotify()) event.sender.send("dictation-realtime-language", metadata);
      };
      streaming.onError = (err) => {
        if (!canNotify()) return;
        event.sender.send("dictation-realtime-error", err.message);
        if (this._dictationPreviewEnabled) this.windowManager.hideTranscriptionPreview();
      };
      streaming.onSessionEnd = (data) => {
        if (!canNotify()) return;
        event.sender.send("dictation-realtime-session-end", data || {});
        if (this._dictationPreviewEnabled) this.windowManager.hideTranscriptionPreview();
      };
    };

    const DICTATION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
    const ORUKEET_IDLE_TIMEOUT_MS = 60 * 1000;

    // A managed Orukeet start owns the connection until its stop. Warmups are for
    // the next recording, so they neither replace this one's connection nor expire
    // it as idle. Other routes cue the user only once connected, so they keep
    // redialling over a warmup.
    let dictationRecordingActive = false;
    // Only a cancel stops a start in progress: a tap to stop waits for it to settle.
    let dictationStopGeneration = 0;
    const watchedDictationRenderers = new WeakSet();
    // A renderer that reloads or closes mid-recording never sends its stop.
    const releaseRecordingWithRenderer = (sender) => {
      if (watchedDictationRenderers.has(sender)) return;
      watchedDictationRenderers.add(sender);
      const release = () => {
        dictationRecordingActive = false;
      };
      sender.on("did-start-loading", release);
      sender.once("destroyed", release);
    };

    const clearDictationIdleTimer = () => {
      if (this._dictationIdleTimer) {
        clearTimeout(this._dictationIdleTimer);
        this._dictationIdleTimer = null;
      }
    };

    const startDictationIdleTimer = () => {
      clearDictationIdleTimer();
      if (dictationRecordingActive) return;
      const idleTimeoutMs =
        this._dictationStreaming instanceof OrukeetStreaming
          ? ORUKEET_IDLE_TIMEOUT_MS
          : DICTATION_IDLE_TIMEOUT_MS;
      this._dictationIdleTimer = setTimeout(() => {
        if (this._dictationStreaming) {
          debugLogger.debug("Closing idle dictation warmup connection");
          this._dictationStreaming.disconnect().catch(() => {});
          this._dictationStreaming = null;
        }
      }, idleTimeoutMs);
    };

    // What a dictation connection was opened for; a start or warmup reuses one
    // only when nothing about the route changed and, for a connection that reads
    // a saved key, no key was saved since. OpenAI pins the language when the
    // session is configured (BYOK session.update, or the cloud token request), so
    // it is part of that route; the other providers never send it at connect.
    const dictationConnectionKey = (options) => {
      const provider = options.provider || "openai-realtime";
      const readsSavedKey = options.mode === "byok" || provider === "tinfoil-realtime";
      return JSON.stringify([
        provider,
        options.mode,
        options.model,
        options.baseUrl,
        provider === "orukeet" ? options.transcriptionMode : null,
        options.pipelineOptions,
        readsSavedKey ? credentialGeneration : null,
        provider === "openai-realtime"
          ? OpenAIRealtimeStreaming.normalizeLanguage(options.language)
          : null,
      ]);
    };

    const connectDictationStreaming = async (event, options) => {
      // Older renderers did not label the OpenAI dictation adapter. Dictation
      // realtime was OpenAI-only before Tinfoil support, so preserve that
      // established default while requiring new adapters to be explicit.
      options = {
        ...options,
        provider: options?.provider || "openai-realtime",
      };

      if (this._dictationConnectPromise) {
        await this._dictationConnectPromise.catch(() => {});
      }
      ownProductStream(this._dictationStreaming);

      clearDictationIdleTimer();
      this._dictationPreviewEnabled = !!options.preview;

      // The renderer is already streaming frames when a start redials (it wires
      // the worklet before calling start), so the old session is retired without
      // a wait, and without a commit where the client supports skipping it: a
      // commit would only surface its head as a final from the wrong session.
      // Frames that reached the old session before the start are dropped with it.
      if (this._dictationStreaming) {
        retireStreaming(this._dictationStreaming);
        this._dictationStreaming = null;
      }

      const connectInner = async () => {
        const isCloud = options.mode !== "byok";
        // Dictation renderers before 1.8.4 omit `provider` and mean OpenAI; the
        // default lives here, at the boundary, so the token allowlist stays
        // fail-closed for genuinely unknown providers (#1624).
        const provider = options.provider ?? "openai-realtime";
        const streaming =
          provider === "orukeet"
            ? new OrukeetStreaming(isCloud ? MANAGED_STREAM_OPTIONS : {})
            : provider === "vietasr"
              ? new VietAsrStreaming()
              : new OpenAIRealtimeStreaming();
        if (provider === "orukeet")
          streaming.onUsageError = (metadata) =>
            debugLogger.error("Combined cleanup usage could not be recorded", metadata);
        if (provider === "vietasr") streaming.owner = event.sender;
        setupDictationCallbacks(streaming, event);
        // Assign before the token fetch (a real network round trip) so
        // dictation-realtime-send has a live instance to buffer into instead
        // of silently dropping the start of the recording.
        streaming.beginConnecting();
        streaming.connectionKey = dictationConnectionKey(options);
        this._dictationStreaming = streaming;
        ownProductStream(streaming);
        try {
          if (provider === "vietasr") {
            if (isCloud || options.transcriptionMode !== "self-hosted")
              throw new Error("VietASR requires self-hosted dictation");
            await streaming.connect({
              baseUrl: options.baseUrl,
              headers: selfHostedRequest("dictation").headers,
            });
            return;
          }
          if (provider === "orukeet") {
            if (isCloud) {
              await connectManagedOrukeet({
                streaming,
                getApiUrl,
                proxyFetch,
                tokenStore,
                withPolicyHeaders,
                pipelineOptions: options.pipelineOptions,
              });
            } else {
              await streaming.connect({
                apiKey: this.environmentManager.getCustomTranscriptionKey(),
                headers:
                  options.transcriptionMode === "self-hosted"
                    ? selfHostedRequest("dictation").headers
                    : {},
                baseUrl: options.baseUrl,
              });
            }
            return;
          }
          const apiKey = await fetchRealtimeToken(event, {
            mode: options.mode,
            provider,
            purpose: "dictation",
            // Cloud sessions are configured server-side when the secret is minted;
            // the server also owns the managed model, so only the language is sent.
            language: OpenAIRealtimeStreaming.normalizeLanguage(options.language) ?? undefined,
          });
          ownProductStream(streaming);
          if (provider === "tinfoil-realtime") {
            const model = options.model || TINFOIL_REALTIME_MODEL;
            await streaming.connect({
              apiKey,
              model,
              // The capture worklet emits 16kHz PCM; declare the true rate.
              inputRate: 16000,
              createSocket: (signal) => createTinfoilRealtimeSocket({ model, apiKey, signal }),
            });
          } else {
            await streaming.connect({
              apiKey,
              model: options.model || "gpt-4o-mini-transcribe",
              language: options.language,
              // OpenAI rejects rates below 24kHz; the 16kHz capture is upsampled instead.
              captureRate: 16000,
              preconfigured: isCloud,
            });
          }
        } catch (err) {
          if (provider === "orukeet" || provider === "vietasr")
            await streaming.disconnect().catch(() => {});
          if (this._dictationStreaming === streaming) this._dictationStreaming = null;
          throw err;
        }
      };

      this._dictationConnectPromise = connectInner();
      try {
        await this._dictationConnectPromise;
      } finally {
        this._dictationConnectPromise = null;
      }
    };

    const streamingStartFailure = (err) => {
      const result = toPolicyFailure(err);
      if (err.messageKey) result.messageKey = err.messageKey;
      if (err.networkCode) result.networkCode = err.networkCode;
      return result;
    };

    // Every managed Orukeet connection spends a single-use GPU token, and both
    // post-dictation re-warm paths fire together. Warmups run one at a time so
    // the second finds the first's fresh socket and reuses it rather than
    // discarding it and minting another.
    const isUnusedOrukeetConnection = (streaming, options) =>
      streaming instanceof OrukeetStreaming &&
      streaming.isConnected &&
      !streaming.failure &&
      !streaming.finalPromise &&
      streaming.audioBytesSent === 0 &&
      streaming.connectionKey === dictationConnectionKey(options);

    const warmupDictationStreaming = async (event, options) => {
      await this._dictationConnectPromise?.catch(() => {});
      if (dictationRecordingActive) {
        ownProductStream(this._dictationStreaming);
        return { success: true, alreadyWarm: true };
      }
      if (!isUnusedOrukeetConnection(this._dictationStreaming, options)) {
        await connectDictationStreaming(event, options);
        startDictationIdleTimer();
        return { success: true };
      }
      ownProductStream(this._dictationStreaming);
      startDictationIdleTimer();
      return { success: true, alreadyWarm: true };
    };

    let dictationWarmupQueue = Promise.resolve();
    handleRemoteProduct("dictation-realtime-warmup", (event, options = {}) => {
      if (options.provider === "vietasr") return { success: true };
      const warmup = dictationWarmupQueue
        .then(() => warmupDictationStreaming(event, options))
        .catch(streamingStartFailure);
      dictationWarmupQueue = warmup;
      return warmup;
    });

    handleRemoteProduct("dictation-realtime-start", async (event, options = {}) => {
      const managedOrukeet = options.provider === "orukeet" && options.mode !== "byok";
      const stopGeneration = dictationStopGeneration;
      if (managedOrukeet || options.provider === "vietasr") {
        dictationRecordingActive = true;
        releaseRecordingWithRenderer(event.sender);
      }
      try {
        clearDictationIdleTimer();
        this._dictationPreviewEnabled = !!options.preview;
        // A warmup still connecting may be the connection this start wants. Managed audio
        // waits in the renderer; other routes need the connection before this tick ends.
        if (managedOrukeet && this._dictationConnectPromise) {
          await this._dictationConnectPromise.catch(() => {});
          if (stopGeneration !== dictationStopGeneration) {
            throw new Error("Dictation start was cancelled");
          }
        }
        if (
          !this._dictationStreaming?.isConnected ||
          this._dictationStreaming.connectionKey !== dictationConnectionKey(options)
        ) {
          await connectDictationStreaming(event, options);
        }
        if (stopGeneration !== dictationStopGeneration)
          throw new Error("Dictation start was cancelled");
        ownProductStream(this._dictationStreaming);
        return { success: true };
      } catch (err) {
        dictationRecordingActive = false;
        return streamingStartFailure(err);
      }
    });

    ipcMain.on("dictation-realtime-send", (event, buffer) => {
      if (
        this._dictationStreaming instanceof VietAsrStreaming &&
        this._dictationStreaming.owner !== event.sender
      )
        return;
      this._dictationStreaming?.sendAudio(Buffer.from(buffer));
    });

    ipcMain.handle("dictation-realtime-finalize", async (event) => {
      if (
        !(this._dictationStreaming instanceof OrukeetStreaming) &&
        !(this._dictationStreaming instanceof VietAsrStreaming)
      ) {
        return { success: false, error: "No acknowledged streaming recording is active" };
      }
      if (
        this._dictationStreaming instanceof VietAsrStreaming &&
        this._dictationStreaming.owner !== event.sender
      )
        return { success: false, error: "Recording belongs to another window" };
      try {
        return { success: true, ...(await this._dictationStreaming.finalize()) };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("dictation-realtime-stop", async (event) => {
      if (
        this._dictationStreaming instanceof VietAsrStreaming &&
        this._dictationStreaming.owner !== event.sender
      )
        return { success: false, error: "Recording belongs to another window" };
      dictationStopGeneration += 1;
      dictationRecordingActive = false;
      clearDictationIdleTimer();
      // A policy retirement may already have taken the stream; its preview is still up.
      const result = this._dictationStreaming
        ? await this._dictationStreaming.disconnect().catch(() => ({ text: "" }))
        : { text: "" };
      this._dictationStreaming = null;
      if (this._dictationPreviewEnabled) {
        this.windowManager.hideTranscriptionPreview();
        this._dictationPreviewEnabled = false;
      }
      return { success: true, ...result, text: result.text || "" };
    });

    ipcMain.handle("dismiss-dictation-preview", () =>
      queueDictationPreviewOperation(async () => {
        resetDictationPreviewState();
        this.windowManager.hideTranscriptionPreview();
        return { success: true };
      })
    );

    ipcMain.handle("update-dictation-preview", (_event, text) =>
      queueDictationPreviewOperation(async () => {
        if (typeof text !== "string" || !text.trim()) {
          return { success: true };
        }
        if (!dictationPreviewSessionActive) {
          resetDictationPreviewState();
          dictationPreviewSessionActive = true;
        }
        await this.windowManager.showTranscriptionPreview(text);
        return { success: true };
      })
    );

    ipcMain.handle("complete-dictation-preview", (_event, { text } = {}) =>
      queueDictationPreviewOperation(async () => {
        if (!dictationPreviewSessionActive) {
          return { success: true };
        }
        if (typeof text === "string" && text.trim()) {
          this.windowManager.completeTranscriptionPreview(text);
        } else {
          resetDictationPreviewState();
          this.windowManager.hideTranscriptionPreview();
        }
        return { success: true };
      })
    );

    ipcMain.handle("hide-dictation-preview", () =>
      queueDictationPreviewOperation(async () => {
        resetDictationPreviewState();
        this.windowManager.hideTranscriptionPreview();
        return { success: true };
      })
    );

    ipcMain.handle("update-transcription-text", async (_event, id, text, rawText) => {
      try {
        if (!this.databaseManager.getTranscriptionById(id)) {
          return { success: false, error: "Transcription not found" };
        }
        this.databaseManager.updateTranscriptionText(id, text, rawText);
        const updated = this.databaseManager.getTranscriptionById(id);
        return { success: true, transcription: updated };
      } catch (error) {
        debugLogger.error(
          "Failed to update transcription text",
          { id, error: error.message },
          "audio-storage"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-stt-config", handleSttConfigRequest);

    // Answers at once: only the device read gates a window, and the
    // workspace verdict arrives by broadcast.
    ipcMain.handle("get-effective-policy", (event, options) => {
      void this.refreshEffectivePolicy(event, { refresh: options?.refresh === true });
      return this.effectivePolicyManager.getCurrent();
    });

    ipcMain.handle("get-note-recording-config", handleNoteRecordingConfigRequest);

    // Unknown or already-finished request ids are a no-op.
    ipcMain.handle("cancel-upload-transcription", async (_event, requestId) => {
      return { success: this._uploadCancelRegistry.cancel(requestId) > 0 };
    });

    handleRemoteFile(
      "transcribe-audio-file-byok",
      async (
        cancel,
        event,
        {
          filePath,
          durationSeconds,
          purpose,
          apiKey,
          baseUrl,
          model,
          diarize,
          timestamps,
          provider,
          language,
          environment,
          tenant,
          transcriptionMode,
          remoteTranscriptionUrl,
          remoteTranscriptionModel,
          managed,
        } = {}
      ) => {
        const fs = require("fs");
        const resolvedPurpose = audioFilePurpose(filePath, purpose);
        return runAudioJob(event, resolvedPurpose, cancel, async (signal) => {
          let cleanupUpload = null;
          let providerErrorContext = null;
          try {
            signal.throwIfAborted();
            if (typeof filePath !== "string") {
              return { success: false, error: "Invalid file path" };
            }
            const sourcePath = resolveAllowedAudioPath(filePath);
            if (!sourcePath) return { success: false, error: "File path not allowed" };

            const { resolveTranscriptionRoute, batchTranscriptionHttpError, uploadsInChunks } =
              await import("./transcriptionRoute.ts");
            const route = resolveTranscriptionRoute({
              policy: productPolicyState(
                this.effectivePolicyManager.getCurrent(),
                app.getVersion()
              ),
              settings: {
                transcriptionMode,
                remoteTranscriptionUrl,
                remoteTranscriptionModel,
                cloudTranscriptionProvider: provider,
                cloudTranscriptionModel: model,
                cloudTranscriptionBaseUrl: baseUrl,
                cortiEnvironment: environment,
                cortiTenant: tenant,
              },
              providers: transcriptionProviderBaseUrls(),
              managed,
              request: { effectiveLanguage: language || undefined },
            });

            // Fail closed: a misconfigured route must never fall through to a default.
            if (route.transport === "error") {
              return {
                success: false,
                error: route.message,
                code: route.code,
                messageKey: route.messageKey,
              };
            }

            await trackTranscriptionRoute(route, transcriptionMode);

            if (route.transport === "managed") {
              const result = await transcribeManagedAudio(event, route, {
                filePath: sourcePath,
                signal,
                onProgress: (payload) =>
                  event.sender.send("upload-transcription-progress", payload),
              });
              return { success: true, ...result };
            }

            // Every branch but the managed one calls a BYOK provider or the user's own server.
            const byokErrorContext = {
              provider: transcriptionProviderName(route.provider),
              selfHosted: route.provider === "self-hosted" || route.provider === "custom",
              model: route.model,
              surface: "transcription",
            };

            // OpenRouter's upstream providers stop after ~60 s of work per request,
            // so its uploads go out in 4-minute pieces, cut straight from the source
            // with any video dropped. The whole-file cap below never applies.
            if (uploadsInChunks(route)) {
              providerErrorContext = byokErrorContext;
              if (!apiKey && route.provider !== "custom") {
                throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
                  provider: byokErrorContext.provider,
                  surface: "transcription",
                });
              }
              const url = new URL(route.endpoint);
              const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
              const { text, warning, failedChunks, totalChunks } = await transcribeOpenRouterChunks(
                {
                  inputPath: sourcePath,
                  split: require("./ffmpegUtils").splitAudioFile,
                  transcribeChunk: async (chunkPath, attemptSignal) => {
                    const { body, boundary } = buildMultipartBody(
                      fs.readFileSync(chunkPath),
                      path.basename(chunkPath),
                      "audio/mpeg",
                      { model: route.model }
                    );
                    const data = await postMultipart(url, body, boundary, headers, {
                      signal: attemptSignal,
                    });
                    if (data.statusCode === 200) return { text: data.data?.text ?? "" };
                    debugLogger.warn("OpenRouter upload piece failed", {
                      piece: path.basename(chunkPath),
                      status: data.statusCode,
                      body: redactProviderBody(data.data),
                    });
                    // The handler's catch classifies it (asProviderError) by status and body.
                    throw Object.assign(
                      new Error(
                        data.data?.error?.message ||
                          data.data?.error ||
                          `API error: ${data.statusCode}`
                      ),
                      { statusCode: data.statusCode, responseBody: data.data },
                      batchTranscriptionHttpError(data.statusCode, route.endpoint)
                    );
                  },
                  onProgress: (payload) =>
                    event.sender.send("upload-transcription-progress", payload),
                  signal,
                }
              );
              return {
                success: true,
                text,
                ...(warning ? { warning, failedChunks, totalChunks } : {}),
              };
            }

            const upload = await prepareProviderUpload(sourcePath, { signal });
            cleanupUpload = upload.cleanup;
            signal.throwIfAborted();
            const realByok = upload.path;
            providerErrorContext = byokErrorContext;

            if (route.transport === "http-batch" && route.provider === "self-hosted") {
              // User's own server, so the 25 MB third-party cap does not apply.
              const { body, boundary } = buildMultipartBody(
                fs.readFileSync(realByok),
                path.basename(realByok),
                providerContentType(realByok),
                { model: route.model, language: route.language }
              );
              // A voice draft goes to dictation's server, a file to the Upload tab's.
              const request = selfHostedRequest(audioFilePurpose(filePath, purpose), route);
              const data = await postMultipart(
                new URL(route.endpoint),
                body,
                boundary,
                request.headers,
                { signal, redirect: request.redirect }
              );
              if (data.statusCode !== 200) {
                debugLogger.warn("Self-hosted file transcription failed", {
                  status: data.statusCode,
                  body: redactProviderBody(data.data),
                });
                throw providerHttpError({
                  ...providerErrorContext,
                  status: data.statusCode,
                  body: data.data,
                });
              }
              return { success: true, text: data.data.text };
            }

            if (route.transport === "proxied" && route.provider === "assemblyai") {
              const { text } = await transcribeAssemblyAiDictation(event, {
                filePath: realByok,
                contentType: providerContentType(realByok),
                durationSeconds,
                language: route.language,
                apiKey: apiKey || this.environmentManager.getAssemblyAIKey(),
                signal,
              });
              return { success: true, text };
            }

            const fileSize = fs.statSync(realByok).size;
            if (route.sizeCapBytes && fileSize > route.sizeCapBytes) {
              return { success: false, error: byokSizeCapError(route.sizeCapBytes) };
            }

            if (route.transport === "proxied" && route.provider === "corti") {
              const clientId = this.environmentManager.getCortiClientId();
              const clientSecret = this.environmentManager.getCortiClientSecret();
              if (!clientId || !clientSecret) {
                throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
                  provider: "Corti",
                  surface: "transcription",
                });
              }
              const { transcribeAudio } = require("./cortiTranscription");
              const { text } = await transcribeAudio({
                environment: route.cortiEnvironment,
                tenant: route.cortiTenant,
                clientId,
                clientSecret,
                audioBuffer: fs.readFileSync(realByok),
                signal,
                language: route.language,
              });
              return { success: true, text };
            }

            if (route.transport === "proxied" && route.provider === "tinfoil") {
              const { text } = await transcribeWithTinfoil({
                audioBuffer: fs.readFileSync(realByok),
                signal,
                fileName: path.basename(realByok),
                contentType: providerContentType(realByok),
                language: route.language,
                apiKey: this.environmentManager.getTinfoilKey(),
              });
              return { success: true, text };
            }

            if (route.transport === "proxied" && route.provider === "gemini") {
              // Deliberately no language hint — same rationale as the multipart
              // branch below, and Gemini's language_codes is a hard constraint.
              const { text } = await transcribeWithGemini({
                audioBuffer: fs.readFileSync(realByok),
                signal,
                model: route.model,
                contentType: providerContentType(realByok),
                apiKey: apiKey || this.environmentManager.getGeminiKey(),
              });
              return { success: true, text };
            }

            if (route.transport === "proxied" && route.provider === "elevenlabs") {
              // No language hint, as for the other uploads: a file is often not
              // in the dictation language.
              const { text } = await transcribeElevenLabsSpeech({
                audioBuffer: fs.readFileSync(realByok),
                signal,
                model: route.model,
                fileName: path.basename(realByok),
                contentType: providerContentType(realByok),
                apiKey: apiKey || this.environmentManager.getElevenlabsKey(),
              });
              return { success: true, text };
            }

            if (!apiKey && route.provider !== "custom") {
              throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
                provider: transcriptionProviderName(route.provider),
                surface: "transcription",
              });
            }

            const audioBuffer = fs.readFileSync(realByok);
            const contentType = providerContentType(realByok);
            const fileName = path.basename(realByok);

            // mistral/xai have no OpenAI-compatible endpoint — talk to them
            // directly; everything else consumes the route endpoint as-is.
            let transcriptionUrl;
            const multipartFields = {};
            if (route.provider === "xai") {
              transcriptionUrl = XAI_STT_URL;
              // xAI STT accepts no model field; the route pre-filters language
              if (route.language) {
                multipartFields.language = route.language;
                multipartFields.format = "true";
              }
            } else {
              transcriptionUrl =
                route.provider === "mistral" ? MISTRAL_TRANSCRIPTION_URL : route.endpoint;
              multipartFields.model = route.model;
              // No language field: an uploaded file is often not in the dictation
              // language, and a wrong hint silently mistranscribes it. Providers
              // that require one (Corti) are handled on their own branch above.
            }

            const filterDictation =
              resolvedPurpose === "dictation" &&
              !diarize &&
              !timestamps &&
              supportsWhisperSegments(route.provider, route.model);
            if (diarize) {
              // A Custom endpoint may front OpenAI or Mistral, so fall back to the
              // resolved host before giving up on speaker labels.
              const diarizeTarget =
                route.provider === "custom" ? diarizationHost(route.endpoint) : route.provider;
              if (diarizeTarget === "mistral") {
                multipartFields.diarize = "true";
                multipartFields.timestamp_granularities = "segment";
              } else if (diarizeTarget === "openai") {
                multipartFields.model = "gpt-4o-transcribe-diarize";
                // Speaker annotations require diarized_json; verbose_json is not supported by this model.
                multipartFields.response_format = "diarized_json";
                multipartFields.chunking_strategy = "auto";
              } else {
                // Degrade to a plain transcript, never fail the upload.
                debugLogger.warn(
                  "BYOK diarization requested but provider is not OpenAI/Mistral; transcribing without speakers",
                  { provider: route.provider, endpoint: route.endpoint }
                );
              }
            } else if (timestamps || filterDictation) {
              // Providers/models that don't support the request keep the
              // plain-text request untouched (helper returns null).
              const fields = timestampRequestFields(route.provider, route.model);
              if (fields) Object.assign(multipartFields, fields);
            }

            const { body, boundary } = buildMultipartBody(
              audioBuffer,
              fileName,
              contentType,
              multipartFields
            );

            const url = new URL(transcriptionUrl);
            // Mistral authenticates with x-api-key, not Bearer.
            const headers = apiKey
              ? route.provider === "mistral"
                ? { "x-api-key": apiKey }
                : route.transport === "http-batch" && route.auth.scheme === "azure-api-key"
                  ? { "api-key": apiKey }
                  : { Authorization: `Bearer ${apiKey}` }
              : undefined;
            const data = await postMultipart(url, body, boundary, headers, { signal });

            if (data.statusCode !== 200) {
              debugLogger.warn("BYOK file transcription failed", {
                provider: route.provider,
                status: data.statusCode,
                body: redactProviderBody(data.data),
              });
              throw providerHttpError({
                ...providerErrorContext,
                status: data.statusCode,
                body: data.data,
              });
            }

            if (diarize && data.data?.speakers) {
              const segments = (data.data.speakers || []).map((s) => ({
                speaker: s.id || `Speaker ${s.speaker || "?"}`,
                text: s.text || "",
                start: s.start || 0,
                end: s.end || 0,
              }));
              const formatted = segments
                .map(
                  (s) =>
                    `[${s.speaker}] ${formatDiarTime(s.start)} - ${formatDiarTime(s.end)}\n${s.text}`
                )
                .join("\n\n");
              return { success: true, text: formatted, diarized: true, segments };
            }

            if (diarize && data.data?.segments) {
              const segments = (data.data.segments || []).map((s) => ({
                speaker: s.speaker || "Speaker ?",
                text: s.text || "",
                start: s.start || 0,
                end: s.end || 0,
              }));
              const formatted = segments
                .map(
                  (s) =>
                    `[${s.speaker}] ${formatDiarTime(s.start)} - ${formatDiarTime(s.end)}\n${s.text}`
                )
                .join("\n\n");
              return { success: true, text: formatted, diarized: true, segments };
            }

            if (diarize) {
              debugLogger.warn("BYOK diarization requested but provider returned no speaker data");
            }
            const segments = timestamps ? mapVerboseSegments(data.data) : null;
            if (timestamps && !segments) {
              debugLogger.debug("BYOK transcription returned no usable segment timing", {
                provider: route.provider,
                hasSegments: Array.isArray(data.data?.segments),
              });
            }
            const text = filterDictation ? dropNoSpeechSegments(data.data) : data.data.text;
            return { success: true, text, ...(segments ? { segments } : {}) };
          } catch (rawError) {
            if (signal.aborted) {
              return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
            }
            const error = providerErrorContext
              ? asProviderError(rawError, providerErrorContext)
              : rawError;
            debugLogger.error("BYOK audio file transcription error", { error: error.message });
            return { success: false, ...ipcErrorFields(error) };
          } finally {
            cleanupUpload?.();
          }
        });
      }
    );

    ipcMain.handle("get-model-cache-root", () => {
      const { getCacheRoot } = require("./modelDirUtils");
      return getCacheRoot();
    });

    ipcMain.handle("open-whisper-models-folder", async () => {
      try {
        const { getCacheRoot } = require("./modelDirUtils");
        const cacheRoot = getCacheRoot();
        await fs.promises.mkdir(cacheRoot, { recursive: true });
        const errMsg = await shell.openPath(cacheRoot);
        if (errMsg) return { success: false, error: errMsg };
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open model cache folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-ydotool-status", () => {
      const { getYdotoolStatus } = require("./ensureYdotool");
      return getYdotoolStatus();
    });

    ipcMain.handle("get-debug-state", async () => {
      try {
        return {
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
          logLevel: debugLogger.getLevel(),
        };
      } catch (error) {
        debugLogger.error("Failed to get debug state:", error);
        return { enabled: false, logPath: null, logLevel: "info" };
      }
    });

    ipcMain.handle("set-debug-logging", async (event, enabled) => {
      try {
        await this.environmentManager.saveDebugLogging(enabled);

        debugLogger.refreshLogLevel();
        // Each window caches its level on first log, so tell them all to re-read it.
        broadcastToWindows("log-level-changed");

        return {
          success: true,
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
        };
      } catch (error) {
        debugLogger.error("Failed to set debug logging:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("open-logs-folder", async () => {
      try {
        const logsDir = path.join(app.getPath("userData"), "logs");
        await shell.openPath(logsDir);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open logs folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(
      "get-model-registry-updates",
      () => process.env.OPENWHISPR_MODEL_REGISTRY_MODE !== "bundled"
    );

    ipcMain.handle("set-model-registry-updates", async (event, enabled) => {
      try {
        await this.environmentManager.saveModelRegistryUpdates(enabled === true);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to save model catalog updates setting:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-app-version", async () => {
      return app.getVersion();
    });

    ipcMain.handle("analytics-record-event", async (_event, input) => {
      const result = this.databaseManager.recordAnalyticsEvent(input);
      if (result?.success && !result.ignored)
        setImmediate(() => broadcastToWindows("analytics-changed"));
      return result;
    });
    ipcMain.handle("analytics-get-summary", async () => {
      await this._ensureAnalyticsHistoryBackfilled();
      return this.databaseManager.getAnalyticsSummary();
    });

    ipcMain.handle("get-post-migration-state", () => ({
      justMigrated: postMigrationDetector.isReturningFromOldBundle(),
    }));

    ipcMain.handle("mark-bundle-migrated", () => {
      postMigrationDetector.markBundleMigrated();
    });

    ipcMain.handle("mark-bundle-migration-dismissed", () => {
      postMigrationDetector.markBundleMigrationDismissed();
    });

    ipcMain.handle("search-contacts", async (_event, query) => {
      try {
        const contacts = this.databaseManager.searchContacts(query);
        return { success: true, contacts };
      } catch {
        return { success: false, contacts: [] };
      }
    });

    ipcMain.handle("upsert-contact", async (_event, contact) => {
      try {
        this.databaseManager.addManualContact(contact);
        return { success: true };
      } catch {
        return { success: false };
      }
    });

    const NOTIFICATION_PREF_KEYS = new Set([
      "notificationsEnabled",
      "notifyMeetingDetection",
      "notifyCalendarReminders",
    ]);

    ipcMain.handle("sync-notification-preferences", async (_event, prefs) => {
      try {
        if (!prefs || typeof prefs !== "object") {
          return { success: false, error: "Invalid preferences" };
        }
        for (const [key, value] of Object.entries(prefs)) {
          if (NOTIFICATION_PREF_KEYS.has(key)) {
            this.windowManager.notificationPrefs[key] = !!value;
          }
        }
        if (typeof prefs.meetingProcessDetection === "boolean") {
          this.meetingProcessDetection = prefs.meetingProcessDetection;
        }
        this._syncMeetingDetectorPolicy();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-pending-note-navigation", async () => {
      return this.windowManager?.consumePendingNoteNavigation() ?? null;
    });

    ipcMain.handle("get-pending-settings-section", async () => {
      return this.windowManager?.consumePendingSettingsSection() ?? null;
    });

    // Note files (markdown mirror) handlers
    let awaitingNoteFilesStartup = true;
    let pendingNoteFilesPath;
    const finishNoteFilesSetup = () => {
      this._noteFilesSync?.deleteMergedNotes(this.databaseManager.mergedNotes);
      this._flushAccountRepairMirrors();
    };
    ipcMain.handle("note-files-set-enabled", async (event, enabled, customPath, options) => {
      const startup = options?.startup === true;
      const fromDictation = startup && isFromWindow(event, this.windowManager?.mainWindow);
      if (
        startup &&
        !fromDictation &&
        !isFromWindow(event, this.windowManager?.controlPanelWindow)
      ) {
        return { success: true };
      }
      try {
        if (startup && (!fromDictation || !awaitingNoteFilesStartup)) {
          if (await this._noteFilesSync?.retryInitialization()) finishNoteFilesSetup();
          return { success: true };
        }
        // Later window requests can retry the current destination using main's settings.
        awaitingNoteFilesStartup = false;
        if (!enabled) {
          if (!startup) this.noteFiles.disable();
          return { success: true };
        }
        const requestedPath = startup ? (pendingNoteFilesPath ?? customPath) : customPath;
        const basePath = requestedPath || path.join(app.getPath("userData"), "notes");
        await this.noteFiles.enable(basePath, {
          skipRebuild: startup ? pendingNoteFilesPath === undefined : Boolean(options?.skipRebuild),
        });
        finishNoteFilesSetup();
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to set note-files enabled",
          { error: error.message },
          "note-files"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-set-path", async (_event, newPath) => {
      try {
        // A folder selection can arrive while the dictation renderer is still starting.
        if (awaitingNoteFilesStartup) {
          pendingNoteFilesPath = newPath;
          return { success: true };
        }
        if (!this.noteFiles.enabled) return { success: false, error: "Note files not enabled" };
        await this.noteFiles.setPath(newPath);
        finishNoteFilesSetup();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to set note-files path", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-rebuild", async () => {
      try {
        if (!this.noteFiles.enabled) return { success: false, error: "Note files not enabled" };
        await this.noteFiles.rebuild();
        finishNoteFilesSetup();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to rebuild note files", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    // Workspace names live on the server; the mirror's directories need them offline too.
    ipcMain.handle("note-files-set-workspace-names", async (_event, workspaces) => {
      try {
        const rows = (Array.isArray(workspaces) ? workspaces : []).filter(
          (workspace) =>
            typeof workspace?.id === "string" &&
            workspace.id &&
            typeof workspace.name === "string" &&
            workspace.name.trim()
        );
        if (this.databaseManager.setWorkspaceNames(rows) > 0) this.noteFiles.containersChanged();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to save workspace names", { error: error.message }, "note-files");
        return { success: false };
      }
    });

    ipcMain.handle("note-files-get-default-path", async () => {
      return path.join(app.getPath("userData"), "notes");
    });

    ipcMain.handle("show-note-file", async (_event, noteId) => {
      try {
        const filePath = this.noteFiles.notePath(noteId);
        if (!filePath) return { success: false };
        shell.showItemInFolder(filePath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show note file",
          { noteId, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("show-folder-in-explorer", async (_event, folderId) => {
      try {
        const dirPath = this.noteFiles.folderPath(folderId);
        if (!dirPath) return { success: false };
        await shell.openPath(dirPath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show folder",
          { folderId, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("note-files-pick-folder", async () => {
      try {
        const { dialog } = require("electron");
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        return { canceled: false, path: result.filePaths[0] };
      } catch (error) {
        debugLogger.error("Failed to pick folder", { error: error.message }, "note-files");
        return { canceled: true };
      }
    });
  }

  deleteTranscriptionInternal(id) {
    const result = this.databaseManager.deleteTranscription(id);
    if (result?.success) {
      // After the scoped delete, so another account's recording is never touched.
      this.audioStorageManager.deleteAudio(id);
      setImmediate(() => {
        broadcastToWindows("transcription-deleted", { id });
      });
    }
    return result;
  }

  deleteNoteInternal(id) {
    const snapshots = this._captureMirrorDeletionNotes({ id });
    const result = this.databaseManager.deleteNote(id);
    if (result?.success) {
      setImmediate(() => broadcastToWindows("note-deleted", { id }));
      this.notifyVectorChanges();
      this._asyncMirrorDelete(id, snapshots);
    }
    return result;
  }
}

module.exports = IPCHandlers;
