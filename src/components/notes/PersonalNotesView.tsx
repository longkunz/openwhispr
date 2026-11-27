import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  holdControlPanel,
  registerControlPanelReleaseFlusher,
  registerControlPanelReleaseGuard,
} from "../../utils/controlPanelRelease";
import { useTranslation } from "react-i18next";
import { Plus } from "../icons";
import { useToast } from "../ui/useToast";
import { PanelResizeHandle } from "../ui/PanelResizeHandle";
import NoteEditor from "./NoteEditor";
import { DeviceNoteView } from "./DeviceNoteView";
import SpacesTree from "./SpacesTree";
import { ContainerOverview } from "./overview/ContainerOverview";
import NotesStructureIntroDialog from "./NotesStructureIntroDialog";
import AddNotesToFolderDialog from "./AddNotesToFolderDialog";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import type { NoteMoveTarget } from "../../hooks/useNoteDragAndDrop";
import type { NoteItem, NoteMutationResult } from "../../types/electron";
import { cn } from "../lib/utils";
import logger from "../../utils/logger";
import type { CalendarEvent } from "../../types/calendar";
import {
  useNotes,
  useSpaces,
  useFolders,
  useActiveNote,
  useActiveNoteId,
  useActiveFolderId,
  useActiveContext,
  useIsTreeLoading,
  initializeNotes,
  initializeNotesTree,
  loadFolders,
  setActiveNoteId,
  setActiveContext,
  revealContainer,
  createFolder,
  getNoteFromStore,
  getSpacesValue,
  markNoteEdited,
  openNote,
  wasNoteDeletedHere,
} from "../../stores/noteStore";
import { useDeviceNotesStore } from "../../stores/deviceNotesStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { isSpaceInWorkspaceScope } from "../../lib/workspaceSelection";
import {
  useIsMeetingMode,
  useIsNarrowWindow,
  markRecordingNoteDeletedByUser,
  rescueRecordingNote,
} from "../../stores/meetingRecordingStore";
import { useNotesOnboarding } from "../../hooks/useNotesOnboarding";
import { useVoiceNoteRecorder } from "../../hooks/useVoiceNoteRecorder";
import { useCreateNote } from "../../hooks/useCreateNote";
import { useTeamSpacesCapability } from "../../hooks/useTeamSpacesCapability";
import {
  folderMutationErrorDescription,
  folderPathLabel,
  notesEmptyTitleKey,
  orderFoldersAsTree,
} from "./shared";
import { markIntroSeen, NOTES_STRUCTURE_INTRO, shouldShowIntro } from "../../lib/versionedIntro";
import { useModalGate } from "../../stores/modalGateStore";
import {
  applyNoteDraftMutation,
  collectPendingNoteWrites,
  documentSaveUpdates,
  enhancedSaveUpdates,
  planNoteTransition,
  shouldCancelPendingSavesForDelete,
  type NoteEditorDraft,
  type PendingDocumentSnapshot,
  type PendingEnhancedSnapshot,
  type PendingNoteWrite,
} from "../../lib/noteEditorPendingSave";

function makeContentHash(content: string): string {
  return String(content.length) + "-" + content.slice(0, 50);
}

function draftFromNote(note: NoteItem): NoteEditorDraft {
  return {
    noteId: note.id,
    title: note.title,
    content: note.content,
    enhancedContent: note.enhanced_content ?? null,
  };
}

interface PendingDocumentSave extends PendingDocumentSnapshot {
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingEnhancedSave extends PendingEnhancedSnapshot {
  readonly timer: ReturnType<typeof setTimeout>;
}

type PendingSaveReason = "switch" | "overview" | "unmount";

// Read about a vanished note when its save is sent. None of it goes into the copy, which holds
// only what the save carried.
interface LostNoteContext {
  // Named in the notice.
  readonly title: string;
  // Where it lived: a Private note's copy stays in that Private.
  readonly spaceId: number | null;
  // undefined: whose note it is was never read, so no copy is made.
  readonly ownerAccountId: string | null | undefined;
}

// Text the user typed in this session: a save carrying none (a title alone, a clear) has
// nothing worth a copy of its own.
function carriesTypedText(updates: PendingNoteWrite["updates"]): boolean {
  return !!updates.content?.trim() || !!updates.enhanced_content?.trim();
}

interface PersonalNotesViewProps {
  onOpenSettings?: (section: string) => void;
}

// The list's CSS cap: 30% of the view it shares with the note.
function notesListMaxWidth(panel: HTMLElement): number {
  const view = panel.parentElement?.parentElement;
  return Math.floor((view?.clientWidth ?? Infinity) * 0.3);
}

export default function PersonalNotesView({ onOpenSettings }: PersonalNotesViewProps) {
  const isMeetingMode = useIsMeetingMode();
  const isNarrowWindow = useIsNarrowWindow();
  const { t } = useTranslation();
  const { toast } = useToast();
  const notes = useNotes();
  const activeNoteId = useActiveNoteId();
  const isSidePanelLayout = isMeetingMode || (isNarrowWindow && activeNoteId != null);
  const notesListResize = useResizableWidth<HTMLDivElement>({
    storageKey: "notesSidebarWidth",
    edge: "end",
    min: 180,
    max: 420,
    getDragMax: notesListMaxWidth,
  });
  const notesListWidth = notesListResize.width ?? 208;
  const activeFolderId = useActiveFolderId();
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraftState] = useState<NoteEditorDraft | null>(null);
  const draftRef = useRef<NoteEditorDraft | null>(null);
  const [showAddNotesDialog, setShowAddNotesDialog] = useState(false);
  const pendingDocumentRef = useRef<PendingDocumentSave | null>(null);
  const pendingEnhancedRef = useRef<PendingEnhancedSave | null>(null);
  const failedAutosaveRef = useRef(false);
  useEffect(() => registerControlPanelReleaseGuard(() => !failedAutosaveRef.current), []);
  // The open note's last stored row and the account it was opened under: where a copy goes, and
  // for whom, should the note vanish before a save lands (see rescueLostNoteWrite).
  const openNoteRowRef = useRef<NoteItem | null>(null);
  const draftOwnerRef = useRef<{ noteId: number; accountId: string | null } | null>(null);
  // One copy per vanished note, so its later saves land in that copy.
  const lostNoteCopiesRef = useRef(new Map<number, Promise<NoteItem | null>>());

  const captureDraftOwner = useCallback(async (noteId: number): Promise<void> => {
    draftOwnerRef.current = null;
    try {
      const guard = await window.electronAPI.getNoteWriteGuard?.();
      if (guard && draftRef.current?.noteId === noteId) {
        draftOwnerRef.current = { noteId, accountId: guard.accountId };
      }
    } catch {
      // With no owner, a vanished note's refused save is only logged.
    }
  }, []);

  const commitDraft = useCallback(
    (next: NoteEditorDraft | null) => {
      const previousNoteId = draftRef.current?.noteId ?? null;
      draftRef.current = next;
      setDraftState(next);
      if (next && next.noteId !== previousNoteId) void captureDraftOwner(next.noteId);
    },
    [captureDraftOwner]
  );

  // Read when a save is sent: by the time a refusal comes back, the editor may show another note.
  const lostNoteContext = useCallback((noteId: number): LostNoteContext => {
    const draft = draftRef.current?.noteId === noteId ? draftRef.current : null;
    const row = openNoteRowRef.current?.id === noteId ? openNoteRowRef.current : null;
    return {
      title: draft?.title || row?.title || "",
      spaceId: row?.space_id ?? null,
      ownerAccountId:
        draftOwnerRef.current?.noteId === noteId ? draftOwnerRef.current.accountId : undefined,
    };
  }, []);

  // A new note in Private holding only the fields the refused save carried: what was typed here
  // since the last save. As when main keeps unsent work from a note that lost its teamspace,
  // nothing else of the note (its transcript, its summary unless that was being saved) leaves
  // it. Made only for the account that opened the note (a refusal also follows an account
  // switch), and refused by main if the account changes on the way.
  const copyLostNote = useCallback(
    async (write: PendingNoteWrite, context: LostNoteContext): Promise<NoteItem | null> => {
      const api = window.electronAPI;
      const guard = await api.getNoteWriteGuard?.();
      if (!guard || context.ownerAccountId === undefined) return null;
      if (guard.accountId !== context.ownerAccountId) return null;
      const { title = "", content = "", enhanced_content: enhancedContent } = write.updates;
      // Its own Private when it was in one; otherwise main's pick, the active workspace's.
      const source = getSpacesValue().find((space) => space.id === context.spaceId);
      const save = (spaceId: number | null) =>
        api
          .saveNote(title, content, "personal", null, null, null, spaceId, null, guard)
          .catch(() => null);
      let saved = source?.kind === "private" ? await save(source.id) : null;
      if (!saved?.success) saved = await save(null);
      if (!saved?.success || !saved.note) return null;
      if (!enhancedContent?.trim()) return saved.note;
      const updated = await api
        .updateNote(saved.note.id, { enhanced_content: enhancedContent })
        .catch(() => null);
      return updated?.success && updated.note ? updated.note : saved.note;
    },
    []
  );

  // A save refused because its note is gone (deleted on another device, with its folder, or
  // with a teamspace the user lost) would drop what was typed since the last save. Those edits
  // go to a new note in Private instead, unless the note was deleted here.
  const rescueLostNoteWrite = useCallback(
    async (write: PendingNoteWrite, context: LostNoteContext, error?: string): Promise<void> => {
      const api = window.electronAPI;
      const row = await api.getNote(write.noteId).catch(() => undefined);
      if (row === undefined || (row && !row.deleted_at) || wasNoteDeletedHere(write.noteId)) {
        logger.warn("Note save refused", { noteId: write.noteId, error }, "notes");
        return;
      }
      // The note being recorded: the edits join the copy the recording goes on in.
      const recordingCopyId = await rescueRecordingNote(write.noteId);
      if (recordingCopyId != null && recordingCopyId !== write.noteId) {
        const result = await api.updateNote(recordingCopyId, write.updates).catch(() => null);
        if (!result?.success) {
          logger.warn("Failed to save edits to a recording's new note", { error }, "notes");
        }
        return;
      }
      const copies = lostNoteCopiesRef.current;
      const earlier = copies.get(write.noteId);
      const earlierCopy = earlier ? await earlier : null;
      if (earlierCopy) {
        const result = await api.updateNote(earlierCopy.id, write.updates).catch(() => null);
        if (!result?.success) {
          logger.warn("Failed to save edits to a vanished note's copy", { error }, "notes");
        }
        return;
      }
      if (!carriesTypedText(write.updates)) {
        logger.warn("Note save refused", { noteId: write.noteId, error }, "notes");
        return;
      }
      // The first refusal, or the earlier copy failed: this write makes the copy.
      const attempt = copyLostNote(write, context);
      copies.set(write.noteId, attempt);
      const copy = await attempt;
      if (!copy) {
        if (copies.get(write.noteId) === attempt) copies.delete(write.noteId);
        logger.warn("Could not save a vanished note's edits", { noteId: write.noteId }, "notes");
        return;
      }
      toast({
        title: t("notes.editor.lostNoteCopy.title"),
        description: t("notes.editor.lostNoteCopy.description", {
          title: context.title || t("notes.list.untitled"),
        }),
        duration: 10000,
        actions: [{ label: t("notes.editor.lostNoteCopy.open"), onClick: () => openNote(copy) }],
      });
    },
    [copyLostNote, t, toast]
  );

  // Sends a save; one refused because its note is gone has its edits rescued.
  const writePendingSave = useCallback(
    async (write: PendingNoteWrite): Promise<NoteMutationResult | null> => {
      const release = holdControlPanel();
      try {
        const context = lostNoteContext(write.noteId);
        const result = await window.electronAPI.updateNote(write.noteId, write.updates);
        if (!result?.success) failedAutosaveRef.current = true;
        if (result && !result.success) await rescueLostNoteWrite(write, context, result.error);
        return result ?? null;
      } catch (error) {
        failedAutosaveRef.current = true;
        throw error;
      } finally {
        release();
      }
    },
    [lostNoteContext, rescueLostNoteWrite]
  );

  // Conflict-banner Refresh applies an external cloud copy: a queued
  // debounced save would clobber it with the pre-refresh buffer, so the
  // editor cancels pending saves for that note before the copy is applied.
  const cancelPendingSaves = useCallback((noteId: number) => {
    const document = pendingDocumentRef.current;
    if (document?.noteId === noteId) {
      clearTimeout(document.timer);
      pendingDocumentRef.current = null;
    }
    const enhanced = pendingEnhancedRef.current;
    if (enhanced?.noteId === noteId) {
      clearTimeout(enhanced.timer);
      pendingEnhancedRef.current = null;
    }
  }, []);

  // Conflict-banner Keep saves the note's pending edits before advancing the
  // base. They stay pending until written, so a failed save is retried by its
  // own timer and the draft is never replaced by the store copy meanwhile.
  const savePendingNow = useCallback(async (noteId: number) => {
    const release = holdControlPanel();
    try {
      const document =
        pendingDocumentRef.current?.noteId === noteId ? pendingDocumentRef.current : null;
      const enhanced =
        pendingEnhancedRef.current?.noteId === noteId ? pendingEnhancedRef.current : null;
      for (const write of collectPendingNoteWrites(document, enhanced)) {
        const result = await window.electronAPI.updateNote(write.noteId, write.updates);
        if (!result?.success) throw new Error(result?.error ?? "Note save failed");
      }
      // Retire only the saves just written; an edit made meanwhile stays pending.
      if (document && pendingDocumentRef.current === document) {
        clearTimeout(document.timer);
        pendingDocumentRef.current = null;
      }
      if (enhanced && pendingEnhancedRef.current === enhanced) {
        clearTimeout(enhanced.timer);
        pendingEnhancedRef.current = null;
      }
    } finally {
      release();
    }
  }, []);

  const takePendingSnapshots = useCallback((): {
    document: PendingDocumentSnapshot | null;
    enhanced: PendingEnhancedSnapshot | null;
  } => {
    const document = pendingDocumentRef.current;
    const enhanced = pendingEnhancedRef.current;

    if (document) clearTimeout(document.timer);
    if (enhanced) clearTimeout(enhanced.timer);
    pendingDocumentRef.current = null;
    pendingEnhancedRef.current = null;

    return { document, enhanced };
  }, []);

  useEffect(
    () =>
      registerControlPanelReleaseFlusher(async () => {
        const document = pendingDocumentRef.current;
        const enhanced = pendingEnhancedRef.current;
        // Stop the debounce before awaiting IPC so its timer cannot race the flush.
        if (document) clearTimeout(document.timer);
        if (enhanced) clearTimeout(enhanced.timer);
        const noteIds = new Set([document?.noteId, enhanced?.noteId]);
        for (const noteId of noteIds) {
          if (noteId != null) await savePendingNow(noteId);
        }
        if (pendingDocumentRef.current || pendingEnhancedRef.current) {
          throw new Error("Note changed during close preparation");
        }
      }),
    [savePendingNow]
  );

  const persistPendingWrites = useCallback(
    (writes: PendingNoteWrite[], reason: PendingSaveReason) => {
      for (const write of writes) {
        void writePendingSave(write).catch((err: unknown) => {
          logger.warn(
            `Failed to flush note before ${reason}`,
            { error: (err as Error).message },
            "notes"
          );
        });
      }
    },
    [writePendingSave]
  );

  const flushPendingSaves = useCallback(
    (reason: PendingSaveReason) => {
      const pending = takePendingSnapshots();
      persistPendingWrites(collectPendingNoteWrites(pending.document, pending.enhanced), reason);
    },
    [persistPendingWrites, takePendingSnapshots]
  );

  const transitionToNote = useCallback(
    (nextNote: NoteItem | null, reason: Extract<PendingSaveReason, "switch" | "overview">) => {
      const pending = takePendingSnapshots();
      const transition = planNoteTransition(nextNote, pending.document, pending.enhanced);
      persistPendingWrites(transition.writes, reason);
      commitDraft(transition.nextDraft);
    },
    [commitDraft, persistPendingWrites, takePendingSnapshots]
  );
  const { isComplete: isOnboardingComplete, complete: completeOnboarding } = useNotesOnboarding();
  const isSignedIn = false;
  const teamSpacesAvailable = useTeamSpacesCapability(isSignedIn);
  const isTreeLoading = useIsTreeLoading();
  const [structureIntroPending, setStructureIntroPending] = useState(() =>
    shouldShowIntro(localStorage, NOTES_STRUCTURE_INTRO)
  );
  const [showStructureIntro, setShowStructureIntro] = useState(false);

  const spaces = useSpaces();
  const viewNoteId = useDeviceNotesStore((s) => s.viewNoteId);
  const folders = useFolders();
  const activeContext = useActiveContext();
  const overviewSpace = useMemo(
    () => (activeContext ? (spaces.find((s) => s.id === activeContext.spaceId) ?? null) : null),
    [activeContext, spaces]
  );
  const overviewFolder = useMemo(
    () =>
      activeContext?.folderId != null
        ? (folders.find((f) => f.id === activeContext.folderId) ?? null)
        : null,
    [activeContext, folders]
  );

  useEffect(() => {
    initializeNotesTree();
  }, []);

  // Due once only the notes tree is still loading; the workspace intro waits for it from then on.
  const structureIntroDue =
    structureIntroPending &&
    isOnboardingComplete &&
    isSignedIn &&
    teamSpacesAvailable &&
    !isSidePanelLayout;
  useModalGate("notesStructureIntroPending", structureIntroDue);

  useEffect(() => {
    if (structureIntroDue && !isTreeLoading) setShowStructureIntro(true);
  }, [structureIntroDue, isTreeLoading]);

  const handleStructureIntroOpenChange = useCallback((open: boolean) => {
    setShowStructureIntro(open);
    if (!open) {
      markIntroSeen(localStorage, NOTES_STRUCTURE_INTRO);
      setStructureIntroPending(false);
    }
  }, []);

  const activeNote = useActiveNote();

  // Derive folder name and calendar event name for the metadata chips
  const activeFolderName = useMemo(() => {
    if (!activeNote?.folder_id) return null;
    const folder = folders.find((f) => f.id === activeNote.folder_id);
    return folder ? folderPathLabel(folder, folders, t) : null;
  }, [activeNote?.folder_id, folders, t]);

  // The editor's move-to-folder chip only offers folders in the note's own
  // space; cross-space moves change the audience and need an explicit confirm.
  const editorFolders = useMemo(
    () =>
      orderFoldersAsTree(
        activeNote ? folders.filter((f) => f.space_id === activeNote.space_id) : folders
      ),
    [activeNote, folders]
  );

  // The linked event's stored row, tagged with the id it was looked up for so a
  // stale lookup never shows against another link.
  const [linkedEventLookup, setLinkedEventLookup] = useState<{
    id: string;
    event: CalendarEvent | null;
  } | null>(null);
  const linkedEventId = activeNote?.calendar_event_id || null;
  useEffect(() => {
    if (!linkedEventId) return;
    let cancelled = false;
    window.electronAPI.gcalGetEvent?.(linkedEventId).then((result) => {
      if (!cancelled) {
        setLinkedEventLookup({ id: linkedEventId, event: result?.success ? result.event : null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [linkedEventId]);

  useEffect(() => {
    const currentDraft = draftRef.current;

    if (!activeNote) {
      // Space/folder activation shows its overview by clearing activeNoteId.
      if (currentDraft || pendingDocumentRef.current || pendingEnhancedRef.current) {
        transitionToNote(null, "overview");
      }
      return;
    }

    if (!currentDraft || activeNote.id !== currentDraft.noteId) {
      // Captured writes retain the old owner while the complete next draft is
      // installed atomically.
      transitionToNote(activeNote, "switch");
      // After the transition, which reads the previous note's row for its saves.
      openNoteRowRef.current = activeNote;
      return;
    }

    openNoteRowRef.current = activeNote;
    const hasPendingLocalSave =
      pendingDocumentRef.current?.noteId === activeNote.id ||
      pendingEnhancedRef.current?.noteId === activeNote.id;
    if (!hasPendingLocalSave) {
      // External update (e.g. AI chat tool) — replace the complete draft only
      // when it has no local save pending.
      commitDraft(draftFromNote(activeNote));
    }
  }, [activeNote, commitDraft, transitionToNote]);

  // A save leaves the draft behind any store update it held off (see the
  // effect above). Once nothing is pending for the note, the draft takes the
  // saved row: fields the save did not write carry what a pull or ack applied.
  const resyncDraftAfterSave = useCallback(
    (noteId: number, saved: NoteItem | undefined) => {
      if (
        !saved ||
        saved.id !== noteId ||
        draftRef.current?.noteId !== noteId ||
        pendingDocumentRef.current?.noteId === noteId ||
        pendingEnhancedRef.current?.noteId === noteId
      )
        return;
      commitDraft(draftFromNote(saved));
    },
    [commitDraft]
  );

  const scheduleDocumentSave = useCallback(
    (
      snapshot: NoteEditorDraft,
      edits: Pick<PendingDocumentSnapshot, "contentEdited" | "clearContent">
    ) => {
      void window.electronAPI.discardNoteUndo?.(snapshot.noteId);
      markNoteEdited(snapshot.noteId);
      const current = pendingDocumentRef.current;
      if (current) clearTimeout(current.timer);

      const pending: PendingDocumentSave = {
        noteId: snapshot.noteId,
        title: snapshot.title,
        content: snapshot.content,
        ...edits,
        timer: setTimeout(async () => {
          if (pendingDocumentRef.current !== pending) return;
          pendingDocumentRef.current = null;
          setIsSaving(true);
          try {
            const result = await writePendingSave({
              noteId: pending.noteId,
              updates: documentSaveUpdates(pending),
            });
            if (result?.success) resyncDraftAfterSave(pending.noteId, result.note);
          } catch (err) {
            logger.warn("Failed to save note", { error: (err as Error).message }, "notes");
          } finally {
            setIsSaving(false);
          }
        }, 1000),
      };
      pendingDocumentRef.current = pending;
    },
    [resyncDraftAfterSave, writePendingSave]
  );

  const scheduleEnhancedSave = useCallback(
    (snapshot: NoteEditorDraft) => {
      void window.electronAPI.discardNoteUndo?.(snapshot.noteId);
      markNoteEdited(snapshot.noteId);
      const current = pendingEnhancedRef.current;
      if (current) clearTimeout(current.timer);

      const pending: PendingEnhancedSave = {
        noteId: snapshot.noteId,
        enhancedContent: snapshot.enhancedContent,
        timer: setTimeout(async () => {
          if (pendingEnhancedRef.current !== pending) return;
          pendingEnhancedRef.current = null;
          setIsSaving(true);
          try {
            const result = await writePendingSave({
              noteId: pending.noteId,
              updates: enhancedSaveUpdates(pending),
            });
            if (result?.success) resyncDraftAfterSave(pending.noteId, result.note);
          } catch (err) {
            logger.warn(
              "Failed to save enhanced note content",
              { error: (err as Error).message },
              "notes"
            );
          } finally {
            setIsSaving(false);
          }
        }, 1000),
      };
      pendingEnhancedRef.current = pending;
    },
    [resyncDraftAfterSave, writePendingSave]
  );

  const handleTitleChange = useCallback(
    (sourceNoteId: number, title: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "title",
        value: title,
      });
      if (!next) return;
      commitDraft(next);
      // A title edit before the save fires shares that save, so it keeps an
      // edit or a clear of the notes; on its own it writes only the title.
      const pending =
        pendingDocumentRef.current?.noteId === next.noteId ? pendingDocumentRef.current : null;
      scheduleDocumentSave(next, {
        contentEdited: pending?.contentEdited ?? false,
        clearContent: pending?.clearContent ?? false,
      });
    },
    [commitDraft, scheduleDocumentSave]
  );

  const handleContentChange = useCallback(
    (sourceNoteId: number, content: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "content",
        value: content,
      });
      if (!next) return;
      commitDraft(next);
      scheduleDocumentSave(next, { contentEdited: true, clearContent: !content.trim() });
    },
    [commitDraft, scheduleDocumentSave]
  );

  const handleVoiceNoteTranscribed = useCallback(
    async (targetNoteId: number, text: string) => {
      const currentDraft = draftRef.current;
      if (currentDraft && currentDraft.noteId === targetNoteId) {
        const existing = currentDraft.content || "";
        const nextContent = existing.trim() ? `${existing.trimEnd()}\n\n${text}` : text;
        handleContentChange(targetNoteId, nextContent);
        return;
      }
      const fallbackNote = getNoteFromStore(targetNoteId);
      const existing = fallbackNote?.content || "";
      const nextContent = existing.trim() ? `${existing.trimEnd()}\n\n${text}` : text;
      await writePendingSave({ noteId: targetNoteId, updates: { content: nextContent } });
    },
    [handleContentChange, writePendingSave]
  );

  const voiceNoteRecorder = useVoiceNoteRecorder(handleVoiceNoteTranscribed);

  const startRecording = useCallback(() => {
    if (!activeNote) return;
    void voiceNoteRecorder.startRecording(activeNote.id);
  }, [activeNote, voiceNoteRecorder]);

  const stopRecording = useCallback(async () => {
    await voiceNoteRecorder.stopRecording();
  }, [voiceNoteRecorder]);

  const handleEnhancedContentChange = useCallback(
    (sourceNoteId: number, content: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "enhancedContent",
        value: content,
      });
      if (!next) return;
      commitDraft(next);
      scheduleEnhancedSave(next);
    },
    [commitDraft, scheduleEnhancedSave]
  );

  useEffect(() => {
    return () => flushPendingSaves("unmount");
  }, [flushPendingSaves]);

  const { createNote, createNoteIn } = useCreateNote();

  const handleNotesAdded = useCallback(async () => {
    if (activeFolderId) {
      await initializeNotes(null, 50, activeFolderId);
    }
    loadFolders();
  }, [activeFolderId]);

  const handleDelete = useCallback(
    async (id: number) => {
      if (shouldCancelPendingSavesForDelete(draftRef.current?.noteId ?? null, id)) {
        cancelPendingSaves(id);
      }
      // Deleting the note being recorded deletes its transcript too, rather than saving it
      // to a copy as a delete made elsewhere would.
      const unmark = markRecordingNoteDeletedByUser(id);
      try {
        const result = await window.electronAPI.deleteNote(id);
        if (!result?.success) unmark();
      } catch (error) {
        unmark();
        throw error;
      }
    },
    [cancelPendingSaves]
  );

  // Answers with main's result: the tree tells a refused move (success false) from a done one.
  const handleMoveNote = useCallback(
    async (noteId: number, target: NoteMoveTarget): Promise<NoteMutationResult> => {
      const result = await window.electronAPI.updateNote(noteId, {
        folder_id: target.folderId,
        space_id: target.spaceId,
      });
      // A refused move leaves the open note where it is.
      if (noteId !== activeNoteId || result?.success === false) return result;
      // The view follows the open note within the workspace. Moved to another workspace's
      // Private, the note closes: following it there would switch workspace.
      const { activeWorkspaceId, workspaces, defaultWorkspaceId } = useWorkspaceStore.getState();
      const space = getSpacesValue().find((s) => s.id === target.spaceId);
      if (
        space &&
        isSpaceInWorkspaceScope(space, activeWorkspaceId, workspaces, defaultWorkspaceId)
      ) {
        setActiveContext(target.spaceId, target.folderId);
        revealContainer(target.spaceId, target.folderId);
      } else {
        setActiveNoteId(null);
      }
      return result;
    },
    [activeNoteId]
  );

  const handleMoveToFolder = useCallback(
    async (noteId: number, folderId: number) => {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return;
      await handleMoveNote(noteId, { spaceId: folder.space_id, folderId });
    },
    [folders, handleMoveNote]
  );

  const handleCreateFolderAndMove = useCallback(
    async (noteId: number, folderName: string) => {
      const spaceId =
        getNoteFromStore(noteId)?.space_id ??
        (await window.electronAPI.getPrivateSpaceId?.()) ??
        null;
      if (spaceId == null) return;
      const result = await createFolder(folderName, spaceId);
      if (result.success && result.folder) {
        await handleMoveToFolder(noteId, result.folder.id);
      } else if (result.error) {
        toast({
          title: t("notes.folders.couldNotCreate"),
          description: folderMutationErrorDescription(result, folders, t, {
            name: folderName,
            nested: false,
          }),
          variant: "destructive",
        });
      }
    },
    [handleMoveToFolder, toast, t, folders]
  );

  const activeNoteRawTranscript = activeNote?.transcript || "";
  const activeDraft = draft?.noteId === activeNote?.id ? draft : null;
  const editorNote = activeNote
    ? {
        ...activeNote,
        title: activeDraft ? activeDraft.title : activeNote.title,
        content: activeDraft ? activeDraft.content : activeNote.content,
        enhanced_content: activeDraft
          ? activeDraft.enhancedContent
          : (activeNote.enhanced_content ?? null),
      }
    : null;
  const editorEnhancedContent = editorNote?.enhanced_content ?? null;

  const isEnhancementStale = useMemo(() => {
    if (!editorEnhancedContent || !activeNote?.enhanced_at_content_hash) return false;
    const currentHash = makeContentHash(`${editorNote?.content ?? ""}\n${activeNoteRawTranscript}`);
    return currentHash !== activeNote.enhanced_at_content_hash;
  }, [
    activeNote?.enhanced_at_content_hash,
    activeNoteRawTranscript,
    editorEnhancedContent,
    editorNote?.content,
  ]);

  const handleExportNote = useCallback(
    async (format: "md" | "txt") => {
      if (!activeNoteId) return;
      await window.electronAPI.exportNote(activeNoteId, format);
    },
    [activeNoteId]
  );

  const handleExportTranscript = useCallback(
    async (format: "txt" | "srt" | "json" | "md", recorderLabel?: string) => {
      if (!activeNoteId) return;
      await window.electronAPI.exportTranscript(activeNoteId, format, { recorderLabel });
    },
    [activeNoteId]
  );

  // Final and periodic transcript persistence live in MeetingRecordingMount /
  // the store — this view can be unmounted when an auto-end stop fires.
  const isActiveNoteRecording =
    voiceNoteRecorder.isRecording && voiceNoteRecorder.recordingNoteId === activeNote?.id;

  return (
    <div className="flex h-full">
      <div
        className={cn(
          // A wide list never takes more than 30% of the window, so the note and its chat keep room.
          "max-w-[30%] shrink-0 overflow-hidden transition-[width] duration-300 ease-out",
          // Follows the pointer while it's dragged; the transition is for collapsing.
          notesListResize.isResizing && "transition-none"
        )}
        style={{ width: isSidePanelLayout ? 0 : notesListWidth }}
      >
        <div
          ref={notesListResize.panelRef}
          className="relative max-w-full shrink-0 border-e border-border dark:border-white/10 flex flex-col h-full"
          style={{ width: notesListWidth }}
        >
          <PanelResizeHandle
            edge="end"
            isResizing={notesListResize.isResizing}
            onPointerDown={notesListResize.startResize}
          />
          <SpacesTree
            onDeleteNote={handleDelete}
            onMoveNote={handleMoveNote}
            onCreateFolderAndMove={handleCreateFolderAndMove}
            onNewNote={createNoteIn}
            onShowStructureIntro={() => setShowStructureIntro(true)}
          />
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {viewNoteId != null ? (
          <DeviceNoteView id={viewNoteId} />
        ) : editorNote ? (
          <>
            <NoteEditor
              key={editorNote.id}
              note={editorNote}
              onTitleChange={handleTitleChange}
              onContentChange={handleContentChange}
              isSaving={isSaving}
              isRecording={isActiveNoteRecording}
              isProcessing={voiceNoteRecorder.isProcessing}
              recordingStartedAt={voiceNoteRecorder.recordingStartedAt}
              readMicLevel={voiceNoteRecorder.getMicLevel}
              recordingAllowed={true}
              onStartRecording={startRecording}
              onStopRecording={stopRecording}
              onExportNote={handleExportNote}
              onExportTranscript={handleExportTranscript}
              enhancement={
                editorEnhancedContent
                  ? {
                      content: editorEnhancedContent,
                      isStale: isEnhancementStale,
                      onChange: handleEnhancedContentChange,
                    }
                  : undefined
              }
              folderName={activeFolderName}
              folders={editorFolders}
              onMoveToFolder={handleMoveToFolder}
              onCreateFolderAndMove={handleCreateFolderAndMove}
            />
          </>
        ) : activeContext && overviewSpace ? (
          <ContainerOverview
            key={
              activeContext.folderId != null
                ? `f:${activeContext.folderId}`
                : `s:${activeContext.spaceId}`
            }
            space={overviewSpace}
            folder={overviewFolder}
            onOpenNote={setActiveNoteId}
            onNewNote={createNote}
            onAddExisting={activeFolderId != null ? () => setShowAddNotesDialog(true) : undefined}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center -mt-6">
            <svg
              className="text-foreground dark:text-white mb-5"
              width="72"
              height="64"
              viewBox="0 0 72 64"
              fill="none"
            >
              <rect
                x="22"
                y="2"
                width="32"
                height="42"
                rx="3"
                transform="rotate(6 38 23)"
                fill="currentColor"
                fillOpacity={0.025}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <rect
                x="18"
                y="5"
                width="32"
                height="42"
                rx="3"
                transform="rotate(3 34 26)"
                fill="currentColor"
                fillOpacity={0.04}
                stroke="currentColor"
                strokeOpacity={0.08}
              />
              <rect
                x="14"
                y="8"
                width="32"
                height="42"
                rx="3"
                fill="currentColor"
                fillOpacity={0.05}
                stroke="currentColor"
                strokeOpacity={0.1}
              />
              <rect
                x="20"
                y="16"
                width="16"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.08}
              />
              <rect
                x="20"
                y="21"
                width="20"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.06}
              />
              <rect
                x="20"
                y="26"
                width="12"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.05}
              />
              <rect
                x="20"
                y="31"
                width="18"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.04}
              />
              <circle
                cx="54"
                cy="50"
                r="5"
                fill="currentColor"
                fillOpacity={0.03}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <path
                d="M51.5 50L53 51.5L56.5 48"
                stroke="currentColor"
                strokeOpacity={0.12}
                strokeWidth={1.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {notes.length === 0 ? (
              <>
                <h3 className="text-xs font-semibold text-foreground/60 mb-1">
                  {t(notesEmptyTitleKey(activeFolderId != null))}
                </h3>
                <p className="text-xs text-foreground/50 dark:text-foreground/45 text-center max-w-55 mb-4">
                  {t("notes.empty.description")}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={createNote}
                    className="flex items-center gap-1.5 px-4 h-7 rounded-md bg-primary/8 dark:bg-primary/10 border border-primary/12 dark:border-primary/15 text-xs font-medium text-primary/70 hover:bg-primary/12 hover:text-primary hover:border-primary/20 transition-colors"
                  >
                    <Plus size={11} />
                    {t("notes.empty.createNote")}
                  </button>
                  {/* AddNotesToFolderDialog only mounts for folder contexts —
                      space-root empty states offer just "Create note". */}
                  {activeFolderId != null && (
                    <button
                      onClick={() => setShowAddNotesDialog(true)}
                      className="flex items-center gap-1.5 px-4 h-7 rounded-md border border-foreground/8 dark:border-white/10 text-xs text-foreground/45 hover:text-foreground/60 hover:border-foreground/15 hover:bg-foreground/3 dark:hover:bg-white/3 transition-colors"
                    >
                      {t("notes.addToFolder.addExisting")}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <h3 className="text-xs font-semibold text-foreground/60 mb-1">
                  {t("notes.empty.selectTitle")}
                </h3>
                <p className="text-xs text-foreground/50 dark:text-foreground/45 text-center max-w-50">
                  {t("notes.empty.selectDescription")}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {activeFolderId && (
        <AddNotesToFolderDialog
          open={showAddNotesDialog}
          onOpenChange={setShowAddNotesDialog}
          targetFolderId={activeFolderId}
          onNotesAdded={handleNotesAdded}
        />
      )}

      <NotesStructureIntroDialog
        open={showStructureIntro}
        onOpenChange={handleStructureIntroOpenChange}
      />
    </div>
  );
}
