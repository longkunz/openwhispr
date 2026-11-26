const TRANSCRIPTION_TIMEOUT_MS = 5 * 60 * 1000;

function registerSelfHostedTranscriptionProxy(ipcMain) {
  // A renderer can only cancel requests it owns, even if another window reuses an id.
  const requests = new Map();
  ipcMain.on("cancel-self-hosted-transcription", ({ sender }, requestId) => {
    requests.get(sender)?.get(requestId)?.abort();
  });
  ipcMain.handle("proxy-self-hosted-transcription", async ({ sender }, data = {}) => {
    const {
      requestId,
      endpoint,
      headers,
      redirect,
      audioBuffer,
      fileName,
      mimeType,
      model,
      language,
      prompt,
    } = data;
    if (
      typeof endpoint !== "string" ||
      !/^https?:\/\//i.test(endpoint) ||
      typeof requestId !== "string" ||
      !requestId
    ) {
      return {
        fetchError: { message: "Invalid self-hosted transcription request", name: "TypeError" },
      };
    }
    let owned = requests.get(sender);
    if (!owned) requests.set(sender, (owned = new Map()));
    if (owned.has(requestId)) {
      return { fetchError: { message: "Duplicate transcription request", name: "TypeError" } };
    }
    const controller = new AbortController();
    owned.set(requestId, controller);
    const onDestroyed = () => controller.abort();
    sender.once("destroyed", onDestroyed);
    const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
    timeout.unref();
    try {
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([Buffer.from(audioBuffer)], {
          type: mimeType || "audio/webm",
        }),
        fileName || "audio.webm"
      );
      for (const [key, value] of Object.entries({ model, language, prompt })) {
        if (typeof value === "string" && value.trim()) formData.append(key, value.trim());
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: headers && typeof headers === "object" ? headers : {},
        body: formData,
        redirect: redirect === "error" ? "manual" : "follow",
        signal: controller.signal,
      });
      if (redirect === "error" && response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return { redirected: true };
      }
      const bodyText = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type") || "",
        headers: Object.fromEntries(response.headers.entries()),
        bodyText,
      };
    } catch (err) {
      return {
        fetchError: {
          message: err?.message || "Fetch failed",
          name: err?.name || "TypeError",
          code: err?.code,
          causeCode: err?.cause?.code,
        },
      };
    } finally {
      clearTimeout(timeout);
      sender.removeListener("destroyed", onDestroyed);
      owned.delete(requestId);
      if (!owned.size) requests.delete(sender);
    }
  });
}

module.exports = { registerSelfHostedTranscriptionProxy };
