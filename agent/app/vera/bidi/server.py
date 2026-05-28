"""
B1.a — Strands BidiAgent + Nova Sonic via WebSocket.

Implements BidiInput and BidiOutput protocols for WebSocket transport
instead of local PyAudio. Same shape as Strands' own _BidiAudioInput,
just reads from / writes to a WebSocket instead of the local audio
devices.
"""
import asyncio
import base64
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
import uvicorn

load_dotenv(Path(__file__).parent.parent / ".env")

from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models import BidiNovaSonicModel
from strands.experimental.bidi.types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiInterruptionEvent,
)
from strands.experimental.bidi.types.io import BidiInput, BidiOutput

if TYPE_CHECKING:
    from strands.experimental.bidi.types.events import BidiOutputEvent

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("bidi-server")


SYSTEM_PROMPT = """Sos Vera, asistente bancaria por voz, hablás en español rioplatense
(usás "vos"). Respondés breve y natural, como en una llamada por teléfono.
Por ahora estás en modo de prueba: no tenés acceso al CRM todavía. Si el cliente
te pide algo concreto, decile amablemente que el sistema todavía no está conectado."""


class WebSocketAudioInput(BidiInput):
    """Read audio chunks from a WebSocket, surface them as BidiAudioInputEvent."""

    def __init__(self, ws: WebSocket):
        self._ws = ws
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._channels = 1
        self._format = "pcm"
        self._rate = 16000
        self._receive_task: asyncio.Task | None = None

    async def start(self, agent: BidiAgent) -> None:
        cfg = agent.model.config["audio"]
        self._channels = cfg["channels"]
        self._format = cfg["format"]
        self._rate = cfg["input_rate"]
        self._receive_task = asyncio.create_task(self._receive_loop())
        log.info("WebSocketAudioInput started (rate=%d)", self._rate)

    async def stop(self) -> None:
        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
            try:
                await self._receive_task
            except (asyncio.CancelledError, Exception):
                pass
        log.info("WebSocketAudioInput stopped")

    async def __call__(self) -> BidiAudioInputEvent:
        """Pulled by the agent — return the next audio chunk as a typed event."""
        data = await self._queue.get()
        return BidiAudioInputEvent(
            audio=base64.b64encode(data).decode("utf-8"),
            channels=self._channels,
            format=self._format,
            sample_rate=self._rate,
        )

    async def _receive_loop(self):
        """Background task: pull messages from WS, push PCM bytes into the queue."""
        try:
            while True:
                msg = await self._ws.receive_text()
                data = json.loads(msg)
                if data.get("type") == "audio":
                    pcm = base64.b64decode(data["data"])
                    await self._queue.put(pcm)
                elif data.get("type") == "end":
                    log.info("client sent 'end'")
                    return
        except WebSocketDisconnect:
            log.info("client disconnected (input loop)")
        except Exception as e:
            log.error("input loop error: %s: %s", type(e).__name__, e)


class WebSocketAudioOutput(BidiOutput):
    """Forward agent output events to a WebSocket as JSON messages."""

    def __init__(self, ws: WebSocket):
        self._ws = ws

    async def start(self, agent: BidiAgent) -> None:
        log.info("WebSocketAudioOutput started")

    async def stop(self) -> None:
        log.info("WebSocketAudioOutput stopped")

    async def __call__(self, event: "BidiOutputEvent") -> None:
        try:
            if isinstance(event, BidiAudioStreamEvent):
                # Already base64 in the event; just forward.
                await self._ws.send_text(json.dumps({
                    "type": "audio",
                    "data": event["audio"],
                }))
            elif isinstance(event, BidiInterruptionEvent):
                await self._ws.send_text(json.dumps({
                    "type": "interrupt",
                    "reason": event.get("reason", ""),
                }))
                log.info("interruption forwarded")
            else:
                # Other event types (text, tool calls, etc.) — log for now
                log.debug("output event: %s", type(event).__name__)
        except WebSocketDisconnect:
            log.info("client disconnected (output)")


app = FastAPI()


@app.get("/")
async def index():
    return FileResponse(Path(__file__).parent / "index.html")


@app.websocket("/ws")
async def voice_endpoint(ws: WebSocket):
    await ws.accept()
    log.info("client connected")

    model = BidiNovaSonicModel(
        model_id="amazon.nova-sonic-v1:0",
        provider_config={
            "audio": {
                "input_rate": 16000,
                "output_rate": 24000,
                "voice": "lupe",
                "channels": 1,
                "format": "pcm",
            }
        },
    )
    agent = BidiAgent(model=model, tools=[], system_prompt=SYSTEM_PROMPT)

    audio_in = WebSocketAudioInput(ws)
    audio_out = WebSocketAudioOutput(ws)

    try:
        await agent.run(inputs=[audio_in], outputs=[audio_out])
    except Exception as e:
        log.error("agent.run error: %s: %s", type(e).__name__, e)
    finally:
        log.info("session ending")


if __name__ == "__main__":
    print("[bidi] server listening on http://localhost:8081")
    uvicorn.run(app, host="0.0.0.0", port=8081, log_level="info")
