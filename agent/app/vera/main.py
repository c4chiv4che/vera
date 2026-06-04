import os
import json
import urllib.request
import urllib.error
from pathlib import Path
# Suppress OpenTelemetry warnings during local development; remove for production
if os.getenv("LOCAL_DEV") == "1":
    os.environ["OTEL_SDK_DISABLED"] = "true"
import uvicorn
from dotenv import load_dotenv
from strands import Agent

# Industry tools are defined per-industry. Phase A's text agent currently
# hardcodes 'banking'; Phase C commit 3 will make this query-param driven.
from industries.banking.tools import (
    identificar_cliente,
    consultar_perfil_crediticio,
    evaluar_prestamo,
)
from ag_ui_strands import StrandsAgent, StrandsAgentConfig, create_strands_app
from model.load import load_model
from memory.session import get_memory_session_manager

# Load CRM_ENDPOINT and CRM_API_KEY from .env (gitignored)
load_dotenv()

CRM_ENDPOINT = os.environ.get("CRM_ENDPOINT", "")
CRM_API_KEY = os.environ.get("CRM_API_KEY", "")

PLAZO_MESES = 24



tools = [identificar_cliente, consultar_perfil_crediticio, evaluar_prestamo]

# System prompt loaded from the banking industry manifest.
# Phase C commit 3 will replace this with a manifest-aware loader.
_PROMPT_PATH = Path(__file__).parent / "industries" / "banking" / "prompt.txt"
SYSTEM_PROMPT = _PROMPT_PATH.read_text()

agent = Agent(
    model=load_model(),
    system_prompt=SYSTEM_PROMPT,
    tools=tools,
)

def session_manager_provider(input_data):
    return get_memory_session_manager(input_data.thread_id, "default-user")

config = StrandsAgentConfig(session_manager_provider=session_manager_provider)
agui_agent = StrandsAgent(agent=agent, name="vera", description="Asistente bancaria por voz", config=config)
app = create_strands_app(agui_agent, path="/invocations", ping_path="/ping")


@app.get("/metrics/{thread_id}")
def get_metrics(thread_id: str):
    """Return real token usage and latency for a thread's agent.
    Reads Strands' EventLoopMetrics from the per-thread agent maintained
    by the AG-UI adapter. Defensive: if the adapter's internal structure
    changes, returns zeros instead of erroring."""
    try:
        agent_for_thread = agui_agent._agents_by_thread.get(thread_id)
        if agent_for_thread is None:
            return {"found": False, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "latencyMs": 0}
        m = agent_for_thread.event_loop_metrics
        usage = m.accumulated_usage
        metrics = m.accumulated_metrics
        return {
            "found": True,
            "inputTokens": usage.get("inputTokens", 0),
            "outputTokens": usage.get("outputTokens", 0),
            "totalTokens": usage.get("totalTokens", 0),
            "latencyMs": metrics.get("latencyMs", 0),
        }
    except Exception as e:
        return {"found": False, "error": str(e), "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "latencyMs": 0}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
