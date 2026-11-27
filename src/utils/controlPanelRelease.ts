// Renderer-owned work must opt in before the main process can release this window.
const guards = new Set<() => boolean>();
const flushers = new Set<() => Promise<void>>();
let activeTasks = 0;

export function registerControlPanelReleaseGuard(guard: () => boolean): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

export function registerControlPanelReleaseFlusher(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

export function holdControlPanel(): () => void {
  activeTasks += 1;
  let released = false;
  return () => {
    if (!released) activeTasks -= 1;
    released = true;
  };
}

function canRelease(): boolean {
  return activeTasks === 0 && [...guards].every((guard) => guard());
}

export async function prepareControlPanelRelease(): Promise<boolean> {
  try {
    if (!canRelease()) return false;
    for (const flush of flushers) await flush();
    return canRelease();
  } catch {
    // A failed save keeps its window and draft alive for retry.
    return false;
  }
}
