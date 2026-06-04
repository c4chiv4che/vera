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
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from strands import Agent
from ag_ui_strands import StrandsAgent, StrandsAgentConfig
from ag_ui.core import EventType, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder

from agent_loader import load_industry
from model.load import load_model
from memory.session import get_memory_session_manager

# Load CRM_ENDPOINT and CRM_API_KEY from .env (gitignored)
load_dotenv()

CRM_ENDPOINT = os.environ.get("CRM_ENDPOINT", "")
CRM_API_KEY = os.environ.get("CRM_API_KEY", "")

PLAZO_MESES = 24

DEFAULT_INDUSTRY = "banking"


def session_manager_provider(input_data):
    return get_memory_session_manager(input_data.thread_id, "default-user")


config = StrandsAgentConfig(session_manager_provider=session_manager_provider)

# One StrandsAgent per industry, built lazily on first request. The instance
# stays for the process lifetime — text agents hold no AWS resources between
# requests, so caching is free, and request/response (vs voice's per-session)
# has no obvious boundary to re-read the manifest on. Trade-off: changes to
# industries/{industry}/prompt.txt only take effect after a server restart
# (unlike bidi/server.py, which reloads per WS session).
_agents_by_industry: dict[str, StrandsAgent] = {}


def _get_agui_agent(industry: str) -> StrandsAgent:
    if industry not in _agents_by_industry:
        cfg = load_industry(industry)
        inner = Agent(
            model=load_model(cfg.text_model_id or None),
            system_prompt=cfg.prompt,
            tools=cfg.tools,
        )
        _agents_by_industry[industry] = StrandsAgent(
            agent=inner,
            name="vera",
            description=f"Asistente {cfg.industry} por voz/texto",
            config=config,
        )
    return _agents_by_industry[industry]


app = FastAPI(title="vera-text")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/invocations")
async def invocations(
    input_data: RunAgentInput,
    request: Request,
    industry: str = DEFAULT_INDUSTRY,
):
    try:
        agui = _get_agui_agent(industry)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def event_generator():
        async for event in agui.run(input_data):
            try:
                yield encoder.encode(event)
            except Exception as e:
                error_event = RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=f"Encoding error: {str(e)}",
                    code="ENCODING_ERROR",
                )
                yield encoder.encode(error_event)
                break

    return StreamingResponse(event_generator(), media_type=encoder.get_content_type())


@app.get("/ping")
async def ping():
    return {"status": "healthy"}


@app.get("/metrics/{thread_id}")
def get_metrics(thread_id: str):
    """Return real token usage and latency for a thread's agent.
    Searches across all loaded industries (thread_ids are unique UUIDs, no
    collision risk). Returns zeros if the thread isn't tracked anywhere."""
    try:
        for agui in _agents_by_industry.values():
            agent_for_thread = agui._agents_by_thread.get(thread_id)
            if agent_for_thread is None:
                continue
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
        return {"found": False, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "latencyMs": 0}
    except Exception as e:
        return {"found": False, "error": str(e), "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "latencyMs": 0}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
