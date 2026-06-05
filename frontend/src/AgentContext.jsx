import { useRef, useState, useEffect, useCallback } from "react";
import { AgentContext } from "./useAgent";
import { reconcileEcho } from "./messageReconcile";

const BFF_HTTP = "http://localhost:8787";
const BFF_WS = "ws://localhost:8787";

function parseResult(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function AgentProvider({ children }) {
  // Read once at provider construction. The URL doesn't change during a
  // session, so no state/listener — App.jsx parses the same param the
  // same way; defaults to 'banking' so existing links stay working.
  const industry = new URLSearchParams(window.location.search).get("industry") || "banking";

  const [messages, setMessages] = useState([]);
  const [veraStatus, setVeraStatus] = useState("idle");
  const [toolCalls, setToolCalls] = useState([]);
  const [events, setEvents] = useState([]);
  const [traceLog, setTraceLog] = useState([]);
  const [conversationState, setConversationState] = useState("idle");
  const [isRunning, setIsRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [metrics, setMetrics] = useState(null);
  // True from the moment the user submits a text until the matching
  // RUN_FINISHED (threadId="vera-demo") or ERROR arrives. UI uses it to
  // disable the input/button and show a typing indicator. INTENTIONALLY
  // not gated on the generic isRunning — voice's RUN_STARTED would
  // otherwise lock text fallback for the entire call (the bug fixed in
  // 7425d66).
  const [textInFlight, setTextInFlight] = useState(false);

  const streamingRef = useRef({ id: null, text: "" });
  const wsRef = useRef(null);
  // Monotonic, independent of array length so future filtering can't
  // duplicate seq numbers. Reset alongside traceLog on RESET.
  const traceSeqRef = useRef(0);
  // Debounce in-flight text submits without coupling to `isRunning`, which
  // is set by RUN_STARTED from ANY agent run — including the voice session
  // — and would silently block text fallback for the entire voice call.
  const textBusyRef = useRef(false);
  // FIFO of {content, ts} for messages just submitted via sendMessage but
  // whose USER_MESSAGE broadcast from the BFF hasn't arrived yet.
  // reconcileEcho matches the head against incoming USER_MESSAGE to avoid
  // duplicating the bubble. Cleared on RESET.
  const pendingEchoesRef = useRef([]);
  // Mirror of `messages` so reconcileEcho (called from the WS handler) can
  // read the latest array synchronously without a stale-closure hazard.
  // Updated by the effect below after every commit.
  const messagesRef = useRef([]);
  // 30s backstop that releases textInFlight if neither RUN_FINISHED nor
  // ERROR arrives (e.g. BFF crashed mid-run). Cleared whenever those
  // events fire normally.
  const textInFlightTimeoutRef = useRef(null);

  // Keep messagesRef in sync after every render commit so the WS handler
  // can pass the latest array into reconcileEcho without needing to read
  // from a setState callback (which would deopt other update paths).
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const logEvent = useCallback((type, detail) => {
    const ts = new Date().toLocaleTimeString("es-AR", { hour12: false });
    setEvents((prev) => [...prev, { ts, type, detail }]);
  }, []);

  // Append a new entry to traceLog. seq is monotonic; ts in es-AR clock format.
  const pushTrace = useCallback((entry) => {
    const seq = ++traceSeqRef.current;
    const ts = new Date().toLocaleTimeString("es-AR", { hour12: false });
    setTraceLog((prev) => [...prev, { seq, ts, ...entry }]);
  }, []);

  // Coalescing update for streaming entries (assistant_message content, tool_call
  // args/result). Predicate matches the open entry; patch is a partial overlay.
  // For deltas that depend on previous value (args), callers can use setTraceLog
  // directly with a map — see TOOL_CALL_ARGS below.
  const updateTrace = useCallback((predicate, patch) => {
    setTraceLog((prev) => prev.map((e) => (predicate(e) ? { ...e, ...patch } : e)));
  }, []);

  // Clear the textInFlight backstop timer if armed. Used by every code
  // path that releases textInFlight normally (RUN_FINISHED text, ERROR,
  // RESET) so the 30s timer doesn't fire after the fact.
  const clearTextInFlightTimer = useCallback(() => {
    if (textInFlightTimeoutRef.current) {
      clearTimeout(textInFlightTimeoutRef.current);
      textInFlightTimeoutRef.current = null;
    }
  }, []);

  const handleEvent = useCallback((event) => {
    switch (event.type) {
      case "USER_MESSAGE": {
        // reconcileEcho dedupes against the local-echo bookkeeping when
        // the message comes from a recent text submit; otherwise it falls
        // through to a normal append (voice transcription, foreign client).
        const reconciled = reconcileEcho({
          messages: messagesRef.current,
          pendingEchoes: pendingEchoesRef.current,
          incoming: event.message,
        });
        pendingEchoesRef.current = reconciled.pendingEchoes;
        setMessages(reconciled.messages);
        pushTrace({ type: "user_message", messageId: event.message.id, content: event.message.content });
        break;
      }

      case "RESET":
        setMessages([]);
        setMetrics(null);
        setVeraStatus("idle");
        setToolCalls([]);
        setEvents([]);
        setTraceLog([]);
        traceSeqRef.current = 0;
        setConversationState("idle");
        setIsRunning(false);
        setTextInFlight(false);
        pendingEchoesRef.current = [];
        clearTextInFlightTimer();
        streamingRef.current = { id: null, text: "" };
        break;

      case "RUN_STARTED":
        setConversationState("active");
        setIsRunning(true);
        logEvent("RUN_STARTED", `thread=${event.threadId}`);
        pushTrace({ type: "run_started", threadId: event.threadId, runId: event.runId });
        break;

      case "TEXT_MESSAGE_START":
        streamingRef.current = { id: event.messageId, text: "" };
        setVeraStatus("speaking");
        setMessages((prev) => [...prev, { id: event.messageId, role: "assistant", content: "" }]);
        pushTrace({ type: "assistant_message", messageId: event.messageId, content: "", status: "streaming" });
        break;

      case "TEXT_MESSAGE_CONTENT": {
        streamingRef.current.text += event.delta;
        const text = streamingRef.current.text;
        const id = streamingRef.current.id;
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: text } : m)));
        updateTrace((e) => e.type === "assistant_message" && e.messageId === id, { content: text });
        break;
      }

      case "TEXT_MESSAGE_END": {
        // Capture messageId BEFORE setState callbacks fire — predicate must
        // not read mutable ref state that a future case could change.
        const id = streamingRef.current.id;
        setVeraStatus("idle");
        updateTrace((e) => e.type === "assistant_message" && e.messageId === id, { status: "done" });
        break;
      }

      case "TOOL_CALL_START":
        setVeraStatus("thinking");
        setToolCalls((prev) => [
          ...prev,
          { id: event.toolCallId, name: event.toolCallName, args: "", result: null, status: "running" },
        ]);
        logEvent("TOOL_CALL_START", `name=${event.toolCallName}`);
        pushTrace({
          type: "tool_call",
          toolCallId: event.toolCallId,
          toolName: event.toolCallName,
          args: "",
          result: null,
          status: "running",
        });
        break;

      case "TOOL_CALL_ARGS":
        setToolCalls((prev) =>
          prev.map((t) => (t.id === event.toolCallId ? { ...t, args: t.args + event.delta } : t))
        );
        // Delta accumulation — must read previous value, so map inline rather
        // than calling updateTrace (which only supports static patches).
        setTraceLog((prev) =>
          prev.map((e) =>
            e.type === "tool_call" && e.toolCallId === event.toolCallId
              ? { ...e, args: e.args + event.delta }
              : e
          )
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
        updateTrace(
          (e) => e.type === "tool_call" && e.toolCallId === event.toolCallId,
          { result: parsed, status: "done" }
        );
        if (parsed && parsed.decision && parsed.decision !== "aprobado") {
          setConversationState("escalated");
        }
        break;
      }

      case "RUN_FINISHED":
        setIsRunning(false);
        setVeraStatus("idle");
        setConversationState((s) => (s === "escalated" ? "escalated" : "resolved"));
        // Only the text path's RUN_FINISHED releases textInFlight — the
        // voice path also emits RUN_FINISHED but on a different threadId
        // ("banking-voice-<hex>"), and treating that as "text done" would
        // re-create the 7425d66 bug from the other direction.
        if (event.threadId === "vera-demo") {
          setTextInFlight(false);
          clearTextInFlightTimer();
        }
        logEvent("RUN_FINISHED", `thread=${event.threadId}`);
        pushTrace({ type: "run_finished", threadId: event.threadId });
        break;

      case "METRICS":
        setMetrics({
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          latencyMs: event.latencyMs,
        });
        logEvent("METRICS", `tokens=${event.totalTokens} latency=${event.latencyMs}ms`);
        pushTrace({
          type: "metrics",
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          latencyMs: event.latencyMs,
        });
        break;

      case "ERROR":
        setIsRunning(false);
        setVeraStatus("idle");
        // BFF broadcasts ERROR when the agent returns 4xx/5xx (Phase C
        // commit 4). Release textInFlight immediately so the user isn't
        // locked out for the 30s backstop window.
        setTextInFlight(false);
        clearTextInFlightTimer();
        logEvent("ERROR", event.detail);
        pushTrace({ type: "error", detail: event.detail });
        break;

      case "STATE_SNAPSHOT":
      case "MESSAGES_SNAPSHOT":
        // Periodic full-state syncs the agent runtime emits each turn (text
        // path). Useful for late-joining WS clients but noise for the trace
        // graph. Keep the legacy logEvent call so events[] stays byte-equivalent
        // to pre-change behavior; intentionally skip pushTrace.
        logEvent(event.type, "");
        break;

      default:
        logEvent(event.type, "");
        pushTrace({ type: "unknown", originalType: event.type, raw: event });
    }
  }, [logEvent, pushTrace, updateTrace, clearTextInFlightTimer]);

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
    if (!text?.trim()) return;
    if (textBusyRef.current) {
      console.warn("[chat] message dropped: send in flight");
      return;
    }
    textBusyRef.current = true;

    // Local echo: show the user's message immediately under a sentinel
    // id; reconcileEcho will replace it when the BFF rebroadcasts.
    const now = Date.now();
    pendingEchoesRef.current = pendingEchoesRef.current.filter(
      (e) => now - e.ts < 10_000
    );
    pendingEchoesRef.current.push({ content: text, ts: now });
    const echoId = `echo-${crypto.randomUUID()}`;
    setMessages((prev) => [
      ...prev,
      { id: echoId, role: "user", content: text, _pending: true },
    ]);

    // Lock the input + show typing indicator until RUN_FINISHED / ERROR.
    setTextInFlight(true);
    clearTextInFlightTimer();
    textInFlightTimeoutRef.current = setTimeout(() => {
      console.warn("[chat] textInFlight timeout — releasing without RUN_FINISHED");
      setTextInFlight(false);
      textInFlightTimeoutRef.current = null;
    }, 30_000);

    try {
      await fetch(`${BFF_HTTP}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, industry }),
      });
      // The user message and all events come back via WebSocket broadcast
    } catch (e) {
      console.error("[chat] failed to send", e);
      // POST failed before any run started — no broadcast will come;
      // release immediately rather than waiting on the 30s backstop.
      setTextInFlight(false);
      clearTextInFlightTimer();
    } finally {
      textBusyRef.current = false;
    }
  }, [industry, clearTextInFlightTimer]);

  const reset = useCallback(async () => {
    try {
      await fetch(`${BFF_HTTP}/reset`, { method: "POST" });
    } catch (e) {
      console.error("[reset] failed", e);
    }
  }, []);

  const value = {
    metrics,
    messages, veraStatus, toolCalls, events, traceLog, conversationState, isRunning, connected,
    textInFlight,
    sendMessage, reset,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
