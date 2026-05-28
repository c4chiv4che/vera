import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:8787");
ws.on("open", () => console.log("[test] conectado, esperando eventos..."));
ws.on("message", (data) => {
  const ev = JSON.parse(data.toString());
  if (ev.type === "METRICS") {
    console.log("[event] METRICS", `in=${ev.inputTokens} out=${ev.outputTokens} total=${ev.totalTokens} latency=${ev.latencyMs}ms`);
  } else {
    console.log("[event]", ev.type, ev.delta || ev.toolCallName || "");
  }
});
