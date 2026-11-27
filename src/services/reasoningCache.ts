type ClearCache = typeof import("./ReasoningService").default.clearApiKeyCache;
let clearLoadedCache: ClearCache | null = null;

export function registerReasoningCache(clear: ClearCache): void {
  clearLoadedCache = clear;
}

// An unloaded service has no cached credentials. Key updates must not load its SDKs.
export function invalidateReasoningCache(...args: Parameters<ClearCache>): void {
  clearLoadedCache?.(...args);
}
