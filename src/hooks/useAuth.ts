import type { OfflineAccountProfile } from "../lib/offlineAccountProfile";

interface LocalSession {
  isSignedIn: boolean;
  isGracePeriodOnly: boolean;
  isLoaded: boolean;
  session: null;
  user: OfflineAccountProfile | null;
  isOfflineAccount: boolean;
  refetch: () => Promise<null>;
}

const localSession: LocalSession = {
  isSignedIn: false,
  isGracePeriodOnly: false,
  isLoaded: true,
  session: null,
  user: null,
  isOfflineAccount: false,
  refetch: async () => null,
};

// Account UI and cloud sync are retired. Do not subscribe to Better Auth or
// reconcile/purge account-owned local data merely because a window mounted.
export function useAuth() {
  return localSession;
}
