import type { ShareSettings } from "../../types/electron";

type ShareLinkSettings = Pick<ShareSettings, "visibility" | "token_prefix">;
export type LocalShareState = { isShared: boolean; shareToken: string | null };
type LocalShareStateUpdate = { is_shared: number; share_token?: null };

function currentShareToken(token: string | null, prefix: string | null): string | null {
  return token && prefix && token.startsWith(prefix) ? token : null;
}

/**
 * The DB write that brings a note's local share flag in line with the server,
 * or null when it already agrees. Every write re-pushes a shared note, so a
 * stale stored token never triggers one on its own; it is cleared only when
 * the flag is written anyway.
 */
export function reconcileLocalShareState(
  local: LocalShareState,
  share: ShareLinkSettings
): LocalShareStateUpdate | null {
  const serverShared = share.visibility !== "private";
  if (serverShared === local.isShared) return null;
  if (!serverShared) return { is_shared: 0, share_token: null };
  return local.shareToken && !currentShareToken(local.shareToken, share.token_prefix)
    ? { is_shared: 1, share_token: null }
    : { is_shared: 1 };
}
