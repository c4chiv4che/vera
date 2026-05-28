import { HttpAgent } from "@ag-ui/client";

// Apunta al endpoint local del agente AG-UI (uv run main.py en :8080).
// If CORS blocks this, we'll switch to a Vite proxy.
const AGENT_URL = "http://localhost:8080/invocations";

export async function testAgent(prompt = "Hola, soy Laura, DNI 31234567, quiero un préstamo de 20000") {
  const agent = new HttpAgent({ url: AGENT_URL });

  // Seed the conversation with the user's message
  agent.messages = [
    { id: crypto.randomUUID(), role: "user", content: prompt },
  ];

  console.log("%c[agent] connecting and running...", "color:#5eead4");

  agent.subscribe({
    onEvent({ event }) {
      console.log("[event]", event.type, event);
    },
    onRunFinalized() {
      console.log("%c[agent] run finished", "color:#34d399");
    },
    onRunFailed(err) {
      console.error("[agent] run failed", err);
    },
  });

  try {
    await agent.runAgent();
  } catch (e) {
    console.error("[agent] error:", e);
  }
}

// Expose for manual testing from the browser console
if (typeof window !== "undefined") {
  window.testAgent = testAgent;
}
