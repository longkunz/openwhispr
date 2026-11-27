import type { NoteMutationResult } from "../types/electron";
import { holdControlPanel, registerControlPanelReleaseFlusher } from "../utils/controlPanelRelease";
import { mergePendingNoteUpdates, type PendingNoteWrite } from "./noteEditorPendingSave";

type SaveNote = (write: PendingNoteWrite) => Promise<NoteMutationResult | null>;
interface PendingSave {
  write: PendingNoteWrite;
  save: SaveNote;
  cancelled: boolean;
}
const pending = new Map<number, PendingSave>();
const active = new Map<number, Set<PendingSave>>();
const inFlight = new Map<number, Promise<NoteMutationResult | null>>();

export function hasPendingNoteWrite(noteId: number): boolean {
  return pending.has(noteId);
}

export function cancelPendingNoteWrite(noteId: number): void {
  for (const entry of active.get(noteId) ?? []) entry.cancelled = true;
  pending.delete(noteId);
}

// Pending writes belong to the renderer, so leaving Notes cannot discard a failed save.
// Serialize each note's IPC calls, including saves from a newly mounted Notes view.
export async function persistNoteWrite(
  write: PendingNoteWrite,
  save: SaveNote
): Promise<NoteMutationResult | null> {
  const entry = {
    write: {
      noteId: write.noteId,
      updates: mergePendingNoteUpdates(
        pending.get(write.noteId)?.write.updates ?? {},
        write.updates
      ),
    },
    save,
    cancelled: false,
  };
  pending.set(write.noteId, entry);
  const entries = active.get(write.noteId) ?? new Set<PendingSave>();
  entries.add(entry);
  active.set(write.noteId, entries);
  const release = holdControlPanel();
  const previous = inFlight.get(write.noteId);
  const attempt = (async () => {
    await previous?.catch(() => {});
    if (entry.cancelled) return null;
    const result = await save(entry.write);
    if (result?.success && pending.get(write.noteId) === entry) pending.delete(write.noteId);
    return result;
  })();
  inFlight.set(write.noteId, attempt);
  try {
    return await attempt;
  } finally {
    entries.delete(entry);
    if (entries.size === 0) active.delete(write.noteId);
    if (inFlight.get(write.noteId) === attempt) inFlight.delete(write.noteId);
    release();
  }
}

registerControlPanelReleaseFlusher(async () => {
  for (const entry of [...pending.values()]) {
    const { write, save } = entry;
    // Another note may have been edited, saved or discarded while an earlier retry awaited IPC.
    if (pending.get(write.noteId) !== entry) continue;
    await persistNoteWrite(write, save);
    if (pending.has(write.noteId)) throw new Error("Note save failed");
  }
  if (pending.size > 0) throw new Error("Notes changed during close preparation");
}, "persistence");
