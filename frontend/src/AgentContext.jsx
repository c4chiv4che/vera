import { createContext, useContext, useRef, useState, useCallback } from "react";
import { HttpAgent } from "@ag-ui/client";

const AGENT_URL = "http://localhost:8080/invocations";

const AgentContext = createContext(null);

export function useAgent() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent must be used within <AgentProvider>");
  return ctx;
}

// Decode a tool result JSON string safely (handles the \uXXXX escaping)
function parseResult(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function AgentProvider({ children }) {
  const [messages, setMessages] = useState([]);        // {role, content} for screen 1
  const [veraStatus, setVeraStatus] = useState("idle"); // idle | thinking | speaking
  const [toolCalls, setToolCalls] = useState([]);       // {id, name, args, result, status}
  const [events, setEvents] = useState([]);             // raw log lines for screen 3
  const [conversationState, setConversationState] = useState("idle"); // idle | active | resolved | escalated
  const [isRunning, setIsRunning] = useState(false);

  const agentRef = useRef(null);
  // Track the streaming assistant message id -> accumulated text
  const streamingRef = useRef({ id: null, text: "" });

  const logEvent = useCallback((type, detail) => {
    const ts = new Date().toLocaleTimeString("es-AR", { hour12: false });
    setEvents((prev) => [...prev, { ts, type, detail }]);
  }, []);

  const handleEvent = useCallback((event) => {
    switch (event.type) {
      case "RUN_STARTED":
        setConversationState("active");
        setIsRunning(true);
        logEvent("RUN_STARTED", `thread=${event.threadId}`);
        break;

      case "TEXT_MESSAGE_START":
        streamingRef.current = { id: event.messageId, text: "" };
        setVeraStatus("speaking");
        // add an empty assistant message we'll fill in
        setMessages((prev) => [...prev, { id: event.messageId, role: "assistant", content: "" }]);
        break;

      case "TEXT_MESSAGE_CONTENT": {
        streamingRef.current.text += event.delta;
        const text = streamingRef.current.text;
        const id = streamingRef.current.id;
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: text } : m))
        );
        break;
      }

      case "TEXT_MESSAGE_END":
        setVeraStatus("idle");
        break;

      case "TOOL_CALL_START":
        setVeraStatus("thinking");
        setToolCalls((prev) => [
          ...prev,
          { id: event.toolCallId, name: event.toolCallName, args: "", result: null, status: "running" },
        ]);
        logEvent("TOOL_CALL_START", `name=${event.toolCallName}`);
        break;

      case "TOOL_CALL_ARGS":
        setToolCalls((prev) =>
          prev.map((t) => (t.id === event.toolCallId ? { ...t, args: t.args + event.delta } : t))
        );
        break;

      case "TOOL_CALL_END":
        logEvent("TOOL_CALL_END", `id=${event.toolCallId}`);
        break;

      case "TOOL_CALL_RESULT": {
        const parsed = parseResult(event.content);
        setToolCalls((prev) =>
          prev.map((t) =>
            t.id === event.toolCallId ? { ...t, result: parsed, status: "done" } : t
          )
        );
        logEvent("TOOL_CALL_RESULT", event.content?.slice(0, 80));
        // Detect escalation from the loan evaluation
        if (parsed && parsed.decision && parsed.decision !== "aprobado") {
          setConversationState("escalated");
        }
        break;
      }

      case "RUN_FINISHED":
        setIsRunning(false);
        setVeraStatus("idle");
        setConversationState((s) => (s === "escalated" ? "escalated" : "resolved"));
        logEvent("RUN_FINISHED", `thread=${event.threadId}`);
        break;

      default:
        // STATE_SNAPSHOT, MESSAGES_SNAPSHOT, etc. — logged but not acted on for now
        logEvent(event.type, "");
    }
  }, [logEvent]);

  const sendMessage = useCallback(async (text) => {
    if (!text?.trim() || isRunning) return;

    // Add the user's message to screen 1 immediately
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: text }]);

    const agent = new HttpAgent({ url: AGENT_URL });
    agentRef.current = agent;
    // Send full history so the agent has context (memory)
    agent.messages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ id: m.id, role: m.role, content: m.content }))
      .concat([{ id: crypto.randomUUID(), role: "user", content: text }]);

    agent.subscribe({
      onEvent({ event }) {
        handleEvent(event);
      },
      onRunFailed(err) {
        console.error("[agent] run failed", err);
        setIsRunning(false);
        setVeraStatus("idle");
      },
    });

    try {
      await agent.runAgent();
    } catch (e) {
      console.error("[agent] error:", e);
      setIsRunning(false);
      setVeraStatus("idle");
    }
  }, [messages, isRunning, handleEvent]);

  const reset = useCallback(() => {
    setMessages([]);
    setVeraStatus("idle");
    setToolCalls([]);
    setEvents([]);
    setConversationState("idle");
    setIsRunning(false);
    streamingRef.current = { id: null, text: "" };
  }, []);

  const value = {
    messages, veraStatus, toolCalls, events, conversationState, isRunning,
    sendMessage, reset,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
