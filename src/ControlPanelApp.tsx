import ControlPanel from "./components/ControlPanel";
import { useAuth } from "./hooks/useAuth";
import { useControlPanelWindowDrag } from "./hooks/useControlPanelWindowDrag";
import { useNormalAppLifecycle } from "./hooks/useNormalAppLifecycle";

export default function ControlPanelApp() {
  const { isSignedIn } = useAuth();
  const ready = useNormalAppLifecycle(true, isSignedIn);
  useControlPanelWindowDrag(true);
  return ready ? <ControlPanel /> : null;
}
