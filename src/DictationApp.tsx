import { useEffect } from "react";
import App from "./App.jsx";
import { mirrorActiveAccountScope } from "./lib/accountScopeMirror";
import { useNormalAppLifecycle } from "./hooks/useNormalAppLifecycle";

export default function DictationApp() {
  useEffect(mirrorActiveAccountScope, []);
  const ready = useNormalAppLifecycle(false);
  return ready ? <App /> : null;
}
