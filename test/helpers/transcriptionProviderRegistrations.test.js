const test = require("node:test");
const assert = require("node:assert/strict");
const { bundledRegistryData } = require("../../src/models/registryData.js");
const { resolveProviderRequest } = require("../../src/helpers/providerConnectionTest");

// The catalog alone lists a provider in onboarding. Each place below is a
// hand-kept list, and none of them fails loudly for a provider it does not
// know: onboarding drops the typed key or never unlocks, and the route sends
// the audio to OpenAI with OpenAI's key. The bundled catalog is read so the
// providers the app ships itself count. Two more such lists are held to the
// same catalog elsewhere: Settings' tabs by
// test/components/transcriptionModelPickerCheck.test.js, and the key Audio
// Upload and the chat microphone read by
// test/services/fileTranscriptionApiKeys.test.js.
const providers = bundledRegistryData.transcriptionProviders.map((provider) => provider.id);

// Onboarding unlocks Proceed only on a check's verdict, so a provider the check
// has no request for could never be set up.
test("every provider has a connection check", () => {
  for (const id of providers) {
    assert.doesNotThrow(() => resolveProviderRequest({ provider: id, apiKey: "key" }), id);
  }
});

test("only OpenAI resolves to OpenAI's endpoint and key", async () => {
  const { resolveTranscriptionRoute } = await import("../../src/helpers/transcriptionRoute.ts");

  for (const id of providers) {
    const route = resolveTranscriptionRoute({
      settings: {
        transcriptionMode: "providers",
        cloudTranscriptionMode: "byok",
        cloudTranscriptionProvider: id,
      },
    });
    // A provider with no batch endpoint fails closed, which names no one's.
    if (route.transport === "error") continue;
    assert.equal(route.provider, id);
    if (id === "openai") continue;
    assert.doesNotMatch(String(route.endpoint), /openai\.com/, id);
    assert.notEqual(route.auth?.keyRef, "openai", id);
  }
});
