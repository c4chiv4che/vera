// AgentContext object + useAgent hook live in their own file so that
// AgentContext.jsx exports only its React component (AgentProvider).
// Mixing the hook with the component file violates
// react-refresh/only-export-components and breaks Vite Fast Refresh
// for incremental updates of this provider.
import { createContext, useContext } from "react";

export const AgentContext = createContext(null);

export function useAgent() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent must be used within <AgentProvider>");
  return ctx;
}
