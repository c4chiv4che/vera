import express from "express";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import http from "http";

const PORT = process.env.PORT || 8787;
const AGENT_URL = process.env.AGENT_URL || "http://localhost:8080/invocations";
// Derive the metrics endpoint base from the agent URL (strip /invocations)
const AGENT_BASE = AGENT_URL.replace(/\/invocations\/?$/, "");
const DEMO_THREAD_ID = "vera-demo";

const app = express();
app.use(express.json());

// CORS for local dev (the frontend runs on a different port)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Track connected monitors
const clients = new Set();
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[bff] monitor connected (${clients.size} total)`);
  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[bff] monitor disconnected (${clients.size} total)`);
  });
});

function broadcast(event) {
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// Keep the running conversation history server-side so every monitor shares it
let conversation = [];

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message (string) is required" });
  }

  // Add the user's message to the shared history and tell monitors about it
  const userMsg = { id: randomUUID(), role: "user", content: message };
  conversation.push(userMsg);
  broadcast({ type: "USER_MESSAGE", message: userMsg });

  const runInput = {
    thread_id: "vera-demo",
    run_id: randomUUID(),
    state: {},
    messages: conversation.map((m) => ({ id: m.id, role: m.role, content: m.content })),
    tools: [],
    context: [],
    forwardedProps: {},
  };

  try {
    const agentRes = await fetch(AGENT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(runInput),
    });

    if (!agentRes.ok) {
      const text = await agentRes.text();
      console.error(`[bff] agent error ${agentRes.status}: ${text}`);
      broadcast({ type: "ERROR", detail: `Agent responded ${agentRes.status}` });
      return res.status(502).json({ error: "agent error" });
    }

    // Read the SSE stream and re-broadcast each event over WebSocket
    const reader = agentRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines; lines start with "data: "
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep the last partial line in the buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;
        try {
          const event = JSON.parse(jsonStr);
          broadcast(event);
          // Accumulate assistant text to save into shared history
          if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) {
            assistantText += event.delta;
          }
        } catch (e) {
          console.error("[bff] could not parse SSE line:", jsonStr);
        }
      }
    }

    // Save the assistant's full reply into the shared history
    if (assistantText) {
      conversation.push({ id: randomUUID(), role: "assistant", content: assistantText });
    }

    // Fetch real token usage + latency from the agent and broadcast it
    try {
      const metricsRes = await fetch(`${AGENT_BASE}/metrics/${DEMO_THREAD_ID}`);
      if (metricsRes.ok) {
        const metrics = await metricsRes.json();
        broadcast({
          type: "METRICS",
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          totalTokens: metrics.totalTokens,
          latencyMs: metrics.latencyMs,
        });
      }
    } catch (e) {
      console.error("[bff] could not fetch metrics:", e);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[bff] error talking to agent:", e);
    broadcast({ type: "ERROR", detail: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

// Reset the conversation (for the demo "reiniciar" button)
app.post("/reset", (req, res) => {
  conversation = [];
  broadcast({ type: "RESET" });
  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ ok: true, monitors: clients.size }));

server.listen(PORT, () => {
  console.log(`[bff] listening on http://localhost:${PORT}`);
  console.log(`[bff] talking to agent at ${AGENT_URL}`);
});
