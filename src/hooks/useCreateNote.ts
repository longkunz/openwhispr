import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  revealContainer,
  setActiveContext,
  setActiveNoteId,
  useActiveContext,
} from "../stores/noteStore";

/**
 * Creates a note, opens it, and starts recording into it unless policy keeps that
 * manual. A null space resolves to the private space in the database, so this works
 * before the Notes tree loads.
 */
export function useCreateNote() {
  const { t } = useTranslation();
  const activeContext = useActiveContext();
  const createNoteIn = useCallback(
    async (spaceId: number | null, folderId: number | null) => {
      const result = await window.electronAPI.saveNote(
        t("notes.list.untitledNote"),
        "",
        "personal",
        null,
        null,
        folderId,
        spaceId
      );
      if (!result.success || !result.note) return;
      setActiveContext(result.note.space_id, result.note.folder_id);
      revealContainer(result.note.space_id, result.note.folder_id);
      setActiveNoteId(result.note.id);
    },
    [t]
  );

  const createNote = useCallback(
    () => createNoteIn(activeContext?.spaceId ?? null, activeContext?.folderId ?? null),
    [activeContext, createNoteIn]
  );

  return { createNote, createNoteIn };
}
