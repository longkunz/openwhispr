import { CloudApiError, cloudGet } from "./cloudApi.js";
import type { NoteAccessState, NoteShareInvitation, ShareSettings } from "../types/electron";

export interface ShareStateResponse {
  share: ShareSettings;
  invitations: NoteShareInvitation[];
  // Optional so the desktop can roll out against the legacy sharing service.
  access?: NoteAccessState;
}

function sharePath(cloudId: string, suffix: string = ""): string {
  return `/api/notes/${encodeURIComponent(cloudId)}/share${suffix}`;
}

function accessPath(cloudId: string, suffix: string = ""): string {
  return `/api/notes/${encodeURIComponent(cloudId)}/access${suffix}`;
}

async function getShareSettings(cloudNoteId: string): Promise<ShareStateResponse> {
  const state = await cloudGet<ShareStateResponse>(sharePath(cloudNoteId));
  if (state.access) return state;

  // The ACL API is deployed independently from legacy link sharing. A 404 is
  // the expected compatibility response until that rollout reaches a server.
  try {
    return { ...state, access: await getAccessSettings(cloudNoteId) };
  } catch (error) {
    if (error instanceof CloudApiError && (error.status === 404 || error.code === "not_found")) {
      return state;
    }
    throw error;
  }
}

async function getAccessSettings(cloudNoteId: string): Promise<NoteAccessState> {
  return cloudGet<NoteAccessState>(accessPath(cloudNoteId));
}

// Permission reads remain available for existing cloud-backed notes.
export const NoteSharingService = {
  getShareSettings,
  getAccessSettings,
};
