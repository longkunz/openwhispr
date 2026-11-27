type Service = typeof import("../services/ReasoningService").default;

export function createLazyReasoningService(load: () => Promise<Service>) {
  let loaded: Service | null = null;
  let pending: Promise<Service> | null = null;
  let cancellation = 0;
  const getService = () => {
    pending ??= load()
      .then((service) => {
        loaded = service;
        return service;
      })
      .catch((error) => {
        pending = null;
        throw error;
      });
    return pending;
  };
  return {
    async processText(...args: Parameters<Service["processText"]>) {
      const generation = cancellation;
      const service = await getService();
      if (generation !== cancellation)
        throw new DOMException("Cancelled while loading reasoning", "AbortError");
      return service.processText(...args);
    },
    async isAvailable() {
      return (await getService()).isAvailable();
    },
    cancelAllRequests() {
      cancellation += 1;
      loaded?.cancelAllRequests();
    },
  };
}

export default createLazyReasoningService(() =>
  import("../services/ReasoningService").then((module) => module.default)
);
