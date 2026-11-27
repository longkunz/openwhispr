// A small capability leaf: dictation routing must not initialize inference clients.
const IMAGE_PROVIDERS = new Set([
  "openai",
  "custom",
  "openrouter",
  "anthropic",
  "gemini",
  "openwhispr",
]);

export const providerSupportsImages = (providerId: string | undefined): boolean =>
  Boolean(providerId && IMAGE_PROVIDERS.has(providerId));
