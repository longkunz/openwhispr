const WebSocket = require("ws");
const { buildApiUrl } = require("../config/constants.ts");
const { isSecureHttpEndpoint } = require("../utils/urlUtils.ts");

function vietAsrStreamingUrl(baseUrl) {
  const url = new URL(buildApiUrl(baseUrl, "/stream"));
  if (!isSecureHttpEndpoint(url.toString()) || url.username || url.password) {
    throw new Error("Use HTTPS or a local network URL for VietASR");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.hash = "";
  url.searchParams.delete("modules");
  url.searchParams.set("pipeline", "stream");
  url.searchParams.set("sample_rate", "16000");
  url.searchParams.set("encoding", "pcm_s16le");
  return url.toString();
}

// One socket per dictation. A partial is a replaceable preview, never a final.
class VietAsrStreaming {
  constructor({ timeoutMs = 30000, maxPendingBytes = 2 * 1024 * 1024 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxPendingBytes = maxPendingBytes;
    this.isConnected = false;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.audioBytesSent = 0;
    this.currentModel = "vietasr";
    this.closed = false;
    this.failure = null;
    this.result = null;
  }

  beginConnecting() {}

  connect({ baseUrl, headers = {} }) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("VietASR session was cancelled"));
    const url = vietAsrStreamingUrl(baseUrl);
    this.ws = new WebSocket(url, { headers, followRedirects: false });
    this.connectPromise = new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.connectTimer = setTimeout(
      () => this.fail(new Error("VietASR ready timed out")),
      this.timeoutMs
    );
    this.ws.on("message", (data, binary) => {
      if (this.closed || this.failure || this.result) return;
      try {
        if (binary) throw new Error("Unexpected binary VietASR response");
        const message = JSON.parse(data.toString());
        if (message.type === "error") throw new Error(message.message || "VietASR error");
        if (message.type === "ready") {
          if (this.isConnected) return;
          if (message.sample_rate !== 16000 || message.encoding !== "pcm_s16le") {
            throw new Error("VietASR requires 16 kHz PCM16 audio");
          }
          clearTimeout(this.connectTimer);
          this.isConnected = true;
          for (const buffer of this.pendingAudio) this.writeAudio(buffer);
          this.pendingAudio = [];
          this.pendingBytes = 0;
          this.resolveConnect?.();
          this.resolveConnect = this.rejectConnect = null;
        } else if (message.type === "partial") {
          if (typeof message.text !== "string") throw new Error("Invalid VietASR partial");
          this.onPartialTranscript?.(message.text);
        } else if (message.type === "final") {
          if (!this.finalPromise || typeof message.text !== "string") {
            throw new Error("Unexpected VietASR final");
          }
          this.result = {
            text: message.text,
            model: this.currentModel,
            audioBytesSent: this.audioBytesSent,
          };
          clearTimeout(this.finalTimer);
          this.resolveFinal(this.result);
          this.onFinalTranscript?.(message.text);
        }
      } catch (error) {
        this.fail(error);
      }
    });
    this.ws.on("error", (error) => this.fail(error));
    this.ws.on("close", () => {
      this.isConnected = false;
      if (!this.closed && !this.result) this.fail(new Error("VietASR closed before final"));
      this.onClose?.();
    });
    return this.connectPromise;
  }

  sendAudio(buffer) {
    if (this.closed || this.failure || this.finalPromise) return;
    if (!this.isConnected) {
      if (this.pendingBytes + buffer.length > this.maxPendingBytes) {
        this.fail(new Error("VietASR audio buffer limit exceeded"));
        return;
      }
      this.pendingAudio.push(Buffer.from(buffer));
      this.pendingBytes += buffer.length;
    } else {
      try {
        this.writeAudio(buffer);
      } catch (error) {
        this.fail(error);
      }
    }
  }

  writeAudio(buffer) {
    if (this.ws.bufferedAmount + buffer.length > this.maxPendingBytes) {
      throw new Error("VietASR server is not consuming audio fast enough");
    }
    this.ws.send(buffer, { binary: true }, (error) => {
      if (error) this.fail(error);
    });
    this.audioBytesSent += buffer.length;
  }

  finalize() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.finalPromise) return this.finalPromise;
    if (!this.isConnected) return Promise.reject(new Error("VietASR is not ready"));
    this.finalPromise = new Promise((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    this.finalTimer = setTimeout(
      () => this.fail(new Error("VietASR final timed out")),
      this.timeoutMs
    );
    this.ws.send(JSON.stringify({ type: "eof" }), (error) => {
      if (error) this.fail(error);
    });
    return this.finalPromise;
  }

  fail(error) {
    if (this.closed || this.failure || this.result) return;
    this.failure = error;
    clearTimeout(this.connectTimer);
    clearTimeout(this.finalTimer);
    this.isConnected = false;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.rejectConnect?.(error);
    this.resolveConnect = this.rejectConnect = null;
    this.rejectFinal?.(error);
    this.ws?.terminate();
    this.onError?.(error);
  }

  async disconnect() {
    this.closed = true;
    this.isConnected = false;
    clearTimeout(this.connectTimer);
    clearTimeout(this.finalTimer);
    const error = new Error("VietASR session cancelled");
    this.rejectConnect?.(error);
    this.resolveConnect = this.rejectConnect = null;
    this.rejectFinal?.(error);
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.ws?.terminate();
    this.onClose?.();
    return (
      this.result || { text: "", model: this.currentModel, audioBytesSent: this.audioBytesSent }
    );
  }
}

module.exports = { VietAsrStreaming, vietAsrStreamingUrl };
