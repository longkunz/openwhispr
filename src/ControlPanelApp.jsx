import { useEffect } from "react";
import ControlPanel from "./components/ControlPanel";
import { useAuth } from "./hooks/useAuth";
import { useControlPanelWindowDrag } from "./hooks/useControlPanelWindowDrag";
import { useNormalAppLifecycle } from "./hooks/useNormalAppLifecycle";
import { usePolicyStore } from "./stores/policyStore";

export default function ControlPanelApp() {
  const { isSignedIn, isLoaded } = useAuth();
  const policyStatus = usePolicyStore((state) => state.status);
  const localOnly = usePolicyStore((state) => state.localOnly);
  const ready = useNormalAppLifecycle(true, isSignedIn);
  useControlPanelWindowDrag(true);
  useEffect(() => {
    if (
      !ready ||
      !isLoaded ||
      !isSignedIn ||
      localOnly ||
      !["managed", "unmanaged", "error"].includes(policyStatus)
    )
      return;
    void import("./services/SyncService.js").then(({ syncService }) => syncService.startAutoSync());
  }, [ready, isLoaded, isSignedIn, localOnly, policyStatus]);
  return ready ? <ControlPanel /> : null;
}
