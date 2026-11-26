// One batch transport for dictation and voice notes. Keep abort ownership in the caller.
/**
 * @param {{ endpoint: string, audio: Blob, fileName: string, mimeType?: string,
 * headers?: Record<string, string>, redirect?: "error" | "follow", model?: string,
 * language?: string, prompt?: string, signal?: AbortSignal }} options
 */
export async function requestSelfHostedBatch({
  endpoint,
  audio,
  fileName,
  mimeType = audio.type || "audio/webm",
  headers = {},
  redirect = "follow",
  model,
  language,
  prompt,
  signal,
}) {
  signal?.throwIfAborted();
  const api = typeof window !== "undefined" ? window.electronAPI : null;
  if (!api?.proxySelfHostedTranscription) {
    const body = new FormData();
    body.append("file", audio, fileName);
    for (const [key, value] of Object.entries({ model, language, prompt })) {
      if (value) body.append(key, value);
    }
    return fetch(endpoint, {
      method: "POST",
      headers,
      body,
      redirect: redirect === "error" ? "manual" : redirect,
      signal,
    });
  }

  const audioBuffer = await audio.arrayBuffer();
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => {
      api.cancelSelfHostedTranscription?.(requestId);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([
      api.proxySelfHostedTranscription({
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
      }),
      cancelled,
    ]);
    signal?.throwIfAborted();
    if (result?.fetchError) {
      const error = new TypeError(result.fetchError.message || "fetch failed");
      error.name = result.fetchError.name || "TypeError";
      if (result.fetchError.code) error.code = result.fetchError.code;
      if (result.fetchError.causeCode) error.cause = { code: result.fetchError.causeCode };
      throw error;
    }
    return {
      ok: Boolean(result?.ok),
      status: result?.status ?? 0,
      statusText: result?.statusText ?? "",
      type: result?.redirected ? "opaqueredirect" : "basic",
      headers: new Headers(result?.headers),
      text: async () => result?.bodyText ?? "",
    };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
