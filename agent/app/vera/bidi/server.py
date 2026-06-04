"""
B2.1 — Strands BidiAgent + Nova Sonic via WebSocket, with real CRM
tools, hardened privacy-preserving prompt, AND an AGUI bridge that
forwards events to the BFF so the other frontend views (flow, logs,
admin) can react to the voice conversation in real time.

Architecture (B2.1):

  Browser (PatientScreen, B2.2)         Other 3 views
      ↓ audio + meta                       ↓ AGUI events
      ↕ WebSocket :8081/ws                 ↑ WebSocket :8787/
   bidi server (this file)             BFF broadcaster
      │                                    ▲
      │ translate bidi events → AGUI       │
      └────── WS :8787/agent-events ───────┘

Audio stays on the short path (browser ↔ bidi). Only meta events
(transcripts, tool calls, metrics) travel to the BFF and from there
to the monitoring views. If the BFF is unavailable or restarts mid
session, the bridge logs a warning, reconnects in the background,
and drops any events that occurred while disconnected. The voice
conversation is never affected.

This is unchanged from B1.b iter 3:
  - 3 CRM tools wired into the BidiAgent
  - Privacy-preserving identity mismatch handling in the prompt
  - DNI confirmation step, identity cross-check, no loan assumption
"""
import asyncio
import base64
import json
import logging
import sys
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

load_dotenv(Path(__file__).parent.parent / ".env")

sys.path.insert(0, str(Path(__file__).parent.parent))

from agent_loader import available_industries, load_industry  # noqa: E402
from strands.experimental.bidi.agent import BidiAgent  # noqa: E402
from strands.experimental.bidi.models import BidiNovaSonicModel  # noqa: E402
from strands.experimental.bidi.types.events import (  # noqa: E402
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiInterruptionEvent,
)
from strands.experimental.bidi.types.io import BidiInput, BidiOutput  # noqa: E402

if TYPE_CHECKING:
    from strands.experimental.bidi.types.events import BidiOutputEvent

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("bidi-server")

BFF_AGUI_URL = "ws://localhost:8787/agent-events"
DEFAULT_INDUSTRY = "banking"


class AGUIBridge:
    """Maintains a WS connection to the BFF and forwards AGUI events.

    Reconnects in the background if the BFF is down or restarts. Events
    that occur while disconnected are dropped — the voice session is
    never blocked or slowed by bridge issues.
    """

    def __init__(self, url: str, thread_id: str):
        self._url = url
        self._thread_id = thread_id
        self._ws = None
        self._connect_task = None
        self._closed = False

    async def start(self):
        self._connect_task = asyncio.create_task(self._connect_loop())

    async def _connect_loop(self):
        backoff = 0.5
        while not self._closed:
            try:
                self._ws = await websockets.connect(self._url)
                log.info("agui-bridge: connected to %s", self._url)
                backoff = 0.5
                # Stay alive until the connection drops.
                await self._ws.wait_closed()
                log.info("agui-bridge: connection closed by peer")
                self._ws = None
            except Exception as e:
                log.warning("agui-bridge: connection failed (%s), retrying in %.1fs", e, backoff)
                self._ws = None
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 5.0)
            if self._closed:
                break

    async def emit(self, event: dict):
        """Send an AGUI event. Silently drops if not connected."""
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(json.dumps(event))
        except Exception as e:
            log.warning("agui-bridge: send failed (%s), event dropped", e)

    async def stop(self):
        self._closed = True
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        if self._connect_task is not None:
            self._connect_task.cancel()
            try:
                await self._connect_task
            except (asyncio.CancelledError, Exception):
                pass


class AGUITranslator:
    """Translates BidiAgent events into AGUI events on the fly.

    Coalescing strategy (revised in B2.4 after observing real Nova Sonic
    behaviour):

    Nova Sonic emits BidiTranscriptStreamEvent per-SENTENCE, not per-turn,
    AND emits each sentence TWICE: once with is_final=False and once with
    is_final=True. Both copies carry the *full sentence text* in both
    `delta.text` and `text` fields — they are NOT incremental deltas.

    Naive treatment ("emit a TEXT_MESSAGE per is_final=True, then close
    and reopen") produced (a) every sentence duplicated in the UI from
    the False+True pair, and (b) every sentence rendered as its own
    bubble because we closed/reopened on each is_final.

    What we do instead:
      - Ignore is_final=False entirely. The True copy is the authoritative
        end-of-sentence event; the False one is redundant.
      - On the first is_final=True after a user turn, open a TEXT_MESSAGE
        and emit the sentence as a CONTENT delta.
      - On every subsequent is_final=True while the message is open,
        append another CONTENT delta with the new sentence.
      - Close the message (emit TEXT_MESSAGE_END) only when the actor
        actually changes: a USER_MESSAGE arrives, a tool is called, a
        tool result comes back, or the session ends.

    METRICS:
      Nova Sonic emits BidiUsageEvent ~100 times per session as a
      running counter. Forwarding all of them spams the broadcast for
      no value (consumers only need the latest). We hold the latest
      counter internally and emit a single METRICS event when the
      assistant message is closed (end of turn) and when the session
      ends, capturing the running totals at meaningful boundaries.
    """

    def __init__(self, thread_id: str, bridge: AGUIBridge):
        self._thread_id = thread_id
        self._bridge = bridge
        self._current_assistant_message_id = None
        # Latest usage counters from Nova Sonic; emitted only at turn end.
        self._latest_usage = None

    async def emit_run_started(self):
        await self._bridge.emit({
            "type": "RUN_STARTED",
            "threadId": self._thread_id,
            "runId": str(uuid.uuid4()),
        })

    async def emit_run_finished(self):
        # Flush the last usage snapshot before saying goodbye.
        await self._flush_metrics()
        await self._close_assistant_message_if_open()
        await self._bridge.emit({
            "type": "RUN_FINISHED",
            "threadId": self._thread_id,
        })

    async def _close_assistant_message_if_open(self):
        if self._current_assistant_message_id is not None:
            await self._bridge.emit({
                "type": "TEXT_MESSAGE_END",
                "messageId": self._current_assistant_message_id,
            })
            self._current_assistant_message_id = None
            # Closing the assistant turn is also the point to flush metrics.
            await self._flush_metrics()

    async def _flush_metrics(self):
        if self._latest_usage is None:
            return
        await self._bridge.emit({
            "type": "METRICS",
            "inputTokens": self._latest_usage.get("inputTokens", 0),
            "outputTokens": self._latest_usage.get("outputTokens", 0),
            "totalTokens": self._latest_usage.get("totalTokens", 0),
            "latencyMs": 0,
        })
        # Don't clear; subsequent calls during the same session will
        # re-emit the latest snapshot, which is fine — it's last-wins.

    async def translate(self, event):
        """Inspect a BidiOutputEvent and emit zero or more AGUI events."""
        event_name = type(event).__name__

        if event_name == "BidiTranscriptStreamEvent":
            role = event.get("role")
            is_final = event.get("is_final", False)
            # The is_final=False event is a redundant copy of the same
            # sentence; only act on is_final=True.
            if not is_final:
                return

            text = event.get("text", "")
            if not text:
                return

            if role == "user":
                # User turn: a user message also closes whatever assistant
                # message was still open (defensive — should already be
                # closed when the tool result for the previous turn came).
                await self._close_assistant_message_if_open()
                await self._bridge.emit({
                    "type": "USER_MESSAGE",
                    "message": {
                        "id": str(uuid.uuid4()),
                        "role": "user",
                        "content": text,
                    },
                })
                return

            if role == "assistant":
                # If no message is open yet, open one.
                if self._current_assistant_message_id is None:
                    self._current_assistant_message_id = str(uuid.uuid4())
                    await self._bridge.emit({
                        "type": "TEXT_MESSAGE_START",
                        "messageId": self._current_assistant_message_id,
                    })
                # Append this sentence as a content delta.
                await self._bridge.emit({
                    "type": "TEXT_MESSAGE_CONTENT",
                    "messageId": self._current_assistant_message_id,
                    "delta": text,
                })
                return

        if event_name == "ToolUseStreamEvent":
            # A tool call marks end-of-turn from the assistant's side.
            await self._close_assistant_message_if_open()
            tool_use = (event.get("delta") or {}).get("toolUse") or {}
            tool_call_id = tool_use.get("toolUseId")
            tool_name = tool_use.get("name")
            tool_input = tool_use.get("input")
            if tool_call_id and tool_name:
                await self._bridge.emit({
                    "type": "TOOL_CALL_START",
                    "toolCallId": tool_call_id,
                    "toolCallName": tool_name,
                })
                if tool_input is not None:
                    await self._bridge.emit({
                        "type": "TOOL_CALL_ARGS",
                        "toolCallId": tool_call_id,
                        "delta": json.dumps(tool_input),
                    })
            return

        if event_name == "ToolResultEvent":
            result = event.get("tool_result") or {}
            tool_call_id = result.get("toolUseId")
            content_list = result.get("content") or []
            content_text = ""
            if content_list and isinstance(content_list, list):
                first = content_list[0]
                if isinstance(first, dict):
                    content_text = first.get("text", "")
            if tool_call_id:
                await self._bridge.emit({
                    "type": "TOOL_CALL_END",
                    "toolCallId": tool_call_id,
                })
                await self._bridge.emit({
                    "type": "TOOL_CALL_RESULT",
                    "toolCallId": tool_call_id,
                    "content": content_text,
                })
            return

        if event_name == "BidiUsageEvent":
            # Keep the latest counter; flush at turn-end / session-end.
            # Avoids ~100 redundant METRICS broadcasts per session.
            self._latest_usage = {
                "inputTokens": event.get("inputTokens", 0),
                "outputTokens": event.get("outputTokens", 0),
                "totalTokens": event.get("totalTokens", 0),
            }
            return


class WebSocketAudioInput(BidiInput):
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
        data = await self._queue.get()
        return BidiAudioInputEvent(
            audio=base64.b64encode(data).decode("utf-8"),
            channels=self._channels,
            format=self._format,
            sample_rate=self._rate,
        )

    async def _receive_loop(self):
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
    def __init__(self, ws: WebSocket, translator: AGUITranslator):
        self._ws = ws
        self._translator = translator

    async def start(self, agent: BidiAgent) -> None:
        log.info("WebSocketAudioOutput started")

    async def stop(self) -> None:
        log.info("WebSocketAudioOutput stopped")

    async def __call__(self, event: "BidiOutputEvent") -> None:
        try:
            if isinstance(event, BidiAudioStreamEvent):
                # Audio: only to the browser, never to the BFF.
                await self._ws.send_text(json.dumps({
                    "type": "audio",
                    "data": event["audio"],
                }))
                return

            if isinstance(event, BidiInterruptionEvent):
                await self._ws.send_text(json.dumps({
                    "type": "interrupt",
                    "reason": event.get("reason", ""),
                }))
                log.info("interruption forwarded")
                return

            # All other events: log for measurement AND forward translated
            # to the BFF as AGUI events for the monitoring views.
            event_name = type(event).__name__
            log.info("event: %s | %s", event_name, str(event)[:300])
            await self._translator.translate(event)

        except WebSocketDisconnect:
            log.info("client disconnected (output)")


app = FastAPI()


@app.websocket("/ws")
async def voice_endpoint(ws: WebSocket):
    await ws.accept()
    industry = ws.query_params.get("industry", DEFAULT_INDUSTRY)
    log.info("client connected (industry=%s)", industry)

    try:
        cfg = load_industry(industry)
    except ValueError as e:
        log.warning("rejecting session: %s", e)
        await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        await ws.close(code=4404)
        return

    thread_id = f"{cfg.thread_id_prefix}-{uuid.uuid4().hex[:8]}"
    bridge = AGUIBridge(BFF_AGUI_URL, thread_id)
    await bridge.start()
    translator = AGUITranslator(thread_id, bridge)

    # Announce the start of the run so the views switch to "active".
    await asyncio.sleep(0.3)  # give the bridge a moment to connect
    await translator.emit_run_started()

    model = BidiNovaSonicModel(
        model_id=cfg.voice["model_id"],
        provider_config={
            "audio": {
                "input_rate": cfg.voice["input_rate"],
                "output_rate": cfg.voice["output_rate"],
                "voice": cfg.voice["voice_id"],
                "channels": 1,
                "format": "pcm",
            }
        },
    )
    agent = BidiAgent(
        model=model,
        tools=cfg.tools,
        system_prompt=cfg.prompt,
    )

    audio_in = WebSocketAudioInput(ws)
    audio_out = WebSocketAudioOutput(ws, translator)

    try:
        await agent.run(inputs=[audio_in], outputs=[audio_out])
    except Exception as e:
        log.error("agent.run error: %s: %s", type(e).__name__, e)
    finally:
        try:
            await translator.emit_run_finished()
        except Exception:
            pass
        await bridge.stop()
        log.info("session ending")


if __name__ == "__main__":
    print("[bidi] Phase C commit 2 — server listening on http://localhost:8081")
    print(f"[bidi] industries available: {available_industries()}")
    print(f"[bidi] default industry: {DEFAULT_INDUSTRY}")
    print(f"[bidi] AGUI bridge target: {BFF_AGUI_URL}")
    uvicorn.run(app, host="0.0.0.0", port=8081, log_level="info")
