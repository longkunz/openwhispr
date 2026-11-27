const test = require("node:test");
const assert = require("node:assert/strict");
const { deferred } = require("../helpers/harness/deferred");

test("idle cancellation never loads reasoning; a cancelled lazy load never starts inference", async () => {
  const { createLazyReasoningService } = await import("../../src/helpers/lazyReasoningService.ts");
  const loading = deferred();
  let loads = 0;
  const requests = [];
  let cancellations = 0;
  const service = createLazyReasoningService(() => {
    loads++;
    return loading.promise;
  });
  service.cancelAllRequests();
  assert.equal(loads, 0);
  const cancelled = service.processText("cancelled");
  service.cancelAllRequests();
  loading.resolve({
    processText: async (...args) => {
      requests.push(args);
      return "cleaned";
    },
    isAvailable: async () => true,
    cancelAllRequests: () => {
      cancellations++;
    },
  });
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.deepEqual(requests, []);
  assert.equal(await service.processText("latest"), "cleaned");
  assert.equal(await service.isAvailable(), true);
  assert.equal(loads, 1);
  service.cancelAllRequests();
  assert.equal(cancellations, 1);
  assert.deepEqual(requests, [["latest"]]);
});

test("reasoning can retry loading after an import failure", async () => {
  const { createLazyReasoningService } = await import("../../src/helpers/lazyReasoningService.ts");
  let attempts = 0;
  const service = createLazyReasoningService(async () => {
    if (++attempts === 1) throw new Error("chunk load failed");
    return { processText: async () => "retried" };
  });
  await assert.rejects(service.processText("first"), /chunk load failed/);
  assert.equal(await service.processText("second"), "retried");
});
