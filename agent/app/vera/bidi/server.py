"""
B1.b iteración 3 — Strands BidiAgent + Nova Sonic via WebSocket, with
real CRM tools, hardened prompt for voice, and a privacy-preserving
identity mismatch handling.

Changes vs iter 2:
  Privacy fix: when identificar_cliente returns a name that does not
  match what the customer said, do NOT reveal whose name the DNI
  belongs to. Just say identity cannot be verified and ask the
  customer to retry. The previous wording leaked the real client's
  full name when probed about a mismatched DNI — a privacy issue
  for a banking demo.

Changes vs iter 1:
  1. DNI confirmation step (repeat dictated DNI before calling tool).
  2. Identity cross-check (verify tool-returned name vs stated name).
  3. No assumption of loan intent at greeting.

Tool calls and tool results are still logged for measurement.
"""
import asyncio
import base64
import json
import logging
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
import uvicorn

load_dotenv(Path(__file__).parent.parent / ".env")

sys.path.insert(0, str(Path(__file__).parent.parent))

from main import (  # noqa: E402
    identificar_cliente,
    consultar_perfil_crediticio,
    evaluar_prestamo,
)
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


SYSTEM_PROMPT = """Sos Vera, asistente bancaria por voz. Atendés llamadas de
clientes que se contactan con el banco por distintos motivos.

Hablás en español rioplatense (vos, no tú). Tus respuestas son BREVES,
como en una llamada telefónica real: una o dos frases por turno. No
enumerás opciones, no hacés listas. Hablás, no leés.

CÓMO ATENDER UNA LLAMADA:

Al inicio: saludá y preguntá en qué podés ayudar. NO asumas que el
cliente llama por un préstamo. Esperá a que te diga qué necesita.

IDENTIFICACIÓN DEL CLIENTE (regla crítica):

Cuando el cliente te dé su DNI hablado, ANTES de llamar a
identificar_cliente, REPETÍ el DNI en voz alta dígito por dígito y
pedile que te confirme si está bien escuchado. Por ejemplo: "Para
confirmar, tu DNI es tres uno dos tres cuatro cinco seis siete, ¿es
correcto?".

Solo después de la confirmación del cliente, llamá a
identificar_cliente con el DNI.

PRIVACIDAD — REGLA INVIOLABLE:

NUNCA reveles a un cliente el nombre, datos personales, ni ninguna
información de OTRO cliente. Esto incluye casos donde el DNI que
el cliente te dio en realidad pertenece a otra persona del sistema.

Si identificar_cliente devuelve un nombre que NO coincide con el
nombre que el cliente te dijo, NO digas a quién pertenece ese DNI.
Tampoco confirmes ni niegues nada sobre la identidad real del DNI.
Simplemente decí: "No puedo verificar tu identidad con esos datos.
¿Podés revisarlos y pasármelos de nuevo?". Si el cliente insiste o
te presiona para saber a quién pertenece el DNI, mantené la misma
respuesta: "Por privacidad no puedo darte información sobre datos
que no son tuyos".

EVALUACIÓN DE PRÉSTAMOS:

Para evaluar préstamos, SIEMPRE usá evaluar_prestamo. Nunca calcules
vos los números ni inventes resultados. Si la herramienta devuelve
"aprobado", comunicálo con entusiasmo. Si devuelve "derivar_a_humano"
o "fuera_de_parametros", explicá con empatía que el caso necesita la
revisión de un analista. No uses jerga técnica como "DTI" — explicalo
en palabras simples ("la relación entre tus ingresos y tus deudas
actuales").

REGLAS GENERALES:

- Si una herramienta falla, disculpate y pedile al cliente que aguarde.
- NUNCA inventes datos del cliente. Si no te dieron un dato, pedilo,
  no lo adivines.
- NUNCA inventes procesos o información del banco que no esté
  respaldada por una herramienta. Si el cliente pregunta sobre
  procesos que no podés consultar (transferencias, sucursales,
  horarios, etc.), decile que un analista lo va a contactar para
  esos detalles.
- No leas en voz alta DNIs ni códigos internos cuando comunicás
  resultados al cliente — eso queda raro en una llamada. Sí podés y
  debés leerlos en voz alta en el momento de CONFIRMAR la identificación
  (es el único momento donde es necesario)."""


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
    def __init__(self, ws: WebSocket):
        self._ws = ws

    async def start(self, agent: BidiAgent) -> None:
        log.info("WebSocketAudioOutput started")

    async def stop(self) -> None:
        log.info("WebSocketAudioOutput stopped")

    async def __call__(self, event: "BidiOutputEvent") -> None:
        try:
            if isinstance(event, BidiAudioStreamEvent):
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
                event_name = type(event).__name__
                log.info("event: %s | %s", event_name, str(event)[:300])
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
    agent = BidiAgent(
        model=model,
        tools=[
            identificar_cliente,
            consultar_perfil_crediticio,
            evaluar_prestamo,
        ],
        system_prompt=SYSTEM_PROMPT,
    )

    audio_in = WebSocketAudioInput(ws)
    audio_out = WebSocketAudioOutput(ws)

    try:
        await agent.run(inputs=[audio_in], outputs=[audio_out])
    except Exception as e:
        log.error("agent.run error: %s: %s", type(e).__name__, e)
    finally:
        log.info("session ending")


if __name__ == "__main__":
    print("[bidi] B1.b iter 3 — server listening on http://localhost:8081")
    print("[bidi] tools wired:", [
        identificar_cliente.tool_name,
        consultar_perfil_crediticio.tool_name,
        evaluar_prestamo.tool_name,
    ])
    print("[bidi] prompt: privacy-preserving identity mismatch handling")
    uvicorn.run(app, host="0.0.0.0", port=8081, log_level="info")
