import { createContext, useContext, useRef, useState, useEffect, useCallback } from "react";

const BFF_HTTP = "http://localhost:8787";
const BFF_WS = "ws://localhost:8787";

const AgentContext = createContext(null);

export function useAgent() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent must be used within <AgentProvider>");
  return ctx;
}

function parseResult(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function AgentProvider({ children }) {
  const [messages, setMessages] = useState([]);
  const [veraStatus, setVeraStatus] = useState("idle");
  const [toolCalls, setToolCalls] = useState([]);
  const [events, setEvents] = useState([]);
  const [conversationState, setConversationState] = useState("idle");
  const [isRunning, setIsRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [metrics, setMetrics] = useState(null);

  const streamingRef = useRef({ id: null, text: "" });
  const wsRef = useRef(null);

  const logEvent = useCallback((type, detail) => {
    const ts = new Date().toLocaleTimeString("es-AR", { hour12: false });
    setEvents((prev) => [...prev, { ts, type, detail }]);
  }, []);

  const handleEvent = useCallback((event) => {
    switch (event.type) {
      case "USER_MESSAGE":
        // The BFF owns the conversation; it tells us when a user message is registered
        setMessages((prev) => [...prev, { id: event.message.id, role: "user", content: event.message.content }]);
        break;

      case "RESET":
        setMessages([]);
        setMetrics(null);
        setVeraStatus("idle");
        setToolCalls([]);
        setEvents([]);
        setConversationState("idle");
        setIsRunning(false);
        streamingRef.current = { id: null, text: "" };
        break;

      case "RUN_STARTED":
        setConversationState("active");
        setIsRunning(true);
        logEvent("RUN_STARTED", `thread=${event.threadId}`);
        break;

      case "TEXT_MESSAGE_START":
        streamingRef.current = { id: event.messageId, text: "" };
        setVeraStatus("speaking");
        setMessages((prev) => [...prev, { id: event.messageId, role: "assistant", content: "" }]);
        break;

      case "TEXT_MESSAGE_CONTENT": {
        streamingRef.current.text += event.delta;
        const text = streamingRef.current.text;
        const id = streamingRef.current.id;
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: text } : m)));
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
          prev.map((t) => (t.id === event.toolCallId ? { ...t, result: parsed, status: "done" } : t))
        );
        logEvent("TOOL_CALL_RESULT", event.content?.slice(0, 80));
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

      case "METRICS":
        setMetrics({
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          latencyMs: event.latencyMs,
        });
        logEvent("METRICS", `tokens=${event.totalTokens} latency=${event.latencyMs}ms`);
        break;

      case "ERROR":
        setIsRunning(false);
        setVeraStatus("idle");
        logEvent("ERROR", event.detail);
        break;

      default:
        logEvent(event.type, "");
    }
  }, [logEvent]);

  // Connect to the BFF WebSocket on mount
  useEffect(() => {
    let ws;
    let closed = false;

    function connect() {
      ws = new WebSocket(BFF_WS);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) setTimeout(connect, 1500); // simple auto-reconnect
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (msg) => {
        try {
          handleEvent(JSON.parse(msg.data));
        } catch (e) {
          console.error("[ws] bad message", e);
        }
      };
    }

    connect();
    return () => { closed = true; if (ws) ws.close(); };
  }, [handleEvent]);

  const sendMessage = useCallback(async (text) => {
    if (!text?.trim() || isRunning) return;
    try {
      await fetch(`${BFF_HTTP}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      // The user message and all events come back via WebSocket broadcast
    } catch (e) {
      console.error("[chat] failed to send", e);
    }
  }, [isRunning]);

  const reset = useCallback(async () => {
    try {
      await fetch(`${BFF_HTTP}/reset`, { method: "POST" });
    } catch (e) {
      console.error("[reset] failed", e);
    }
  }, []);

  const value = {
    metrics,
    messages, veraStatus, toolCalls, events, conversationState, isRunning, connected,
    sendMessage, reset,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
