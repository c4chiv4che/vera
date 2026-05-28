import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:8787");
ws.on("open", () => console.log("[test] conectado al BFF, esperando eventos..."));
ws.on("message", (data) => {
  const ev = JSON.parse(data.toString());
  console.log("[event]", ev.type, ev.delta || ev.toolCallName || "");
});
ws.on("close", () => console.log("[test] desconectado"));
