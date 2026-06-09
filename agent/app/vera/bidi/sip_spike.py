"""
Phase D / M1 spike — pjsua2 SIP server that drives a Strands BidiAgent.

Throwaway code. The question this answers is in docs/phase-d-m1-verdict.md:
can Python (pjsua2 + Strands in-process) handle SIP/RTP end-to-end with
acceptable latency for a banking voice demo? If yes → b1; if no → b2.

NOT to be merged. Spike-only. Not production hardened. Do not deploy.

Architecture mirrors server.py (the WebSocket bidi server) deliberately:
  - same load_industry → BidiAgent wiring
  - same AGUIBridge / AGUITranslator broadcast to the BFF on :8787
  - same AGUI event shape so the existing flow/logs/admin/trace views
    react to a phone call exactly like they react to a browser session
The ONLY thing that changes is the audio transport: SIP/RTP via pjsua2
instead of a browser WebSocket.

Run with: ./dev-spike-sip.sh foreground   (or `start` for background).

Test stages (M1.1 → M1.2c) are documented in
agent/app/vera/bidi/SIP_SPIKE_NOTES.md.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
import threading
import time
import uuid
from pathlib import Path

import pjsua2 as pj
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")
sys.path.insert(0, str(Path(__file__).parent.parent))

from agent_loader import available_industries, load_industry  # noqa: E402
from strands.experimental.bidi.agent import BidiAgent  # noqa: E402
from strands.experimental.bidi.models import BidiNovaSonicModel  # noqa: E402

# Reuse the existing AGUI bridge / translator from server.py so trace +
# monitoring views work for SIP calls without any frontend change.
from server import AGUIBridge, AGUITranslator, BFF_AGUI_URL  # noqa: E402

# Local spike adapters.
from sip_audio import SipAudioInput, SipAudioOutput, SipBridge  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
log = logging.getLogger("sip-spike")

SIP_PORT = int(os.getenv("VERA_SIP_PORT", "5060"))
DEFAULT_INDUSTRY = os.getenv("VERA_SIP_INDUSTRY", "banking")
ECHO_MODE = os.getenv("VERA_SIP_ECHO", "0") == "1"  # M1.2a loopback


def _industry_from_uri(uri: str) -> str:
    """Try to read ?industry= from the request URI. Softphones generally
    don't let you set arbitrary URI params on outgoing calls, so this is
    a best-effort hook for testers that DO control the URI (e.g. via
    pjsua's CLI). Falls back to the env default."""
    if "industry=" in uri:
        tail = uri.split("industry=", 1)[1]
        return tail.split("&", 1)[0].split(">", 1)[0].split(";", 1)[0]
    return DEFAULT_INDUSTRY


class VeraSipAccount(pj.Account):
    def __init__(self, asyncio_loop: asyncio.AbstractEventLoop):
        super().__init__()
        self._loop = asyncio_loop
        self._calls: list[VeraSipCall] = []

    def onIncomingCall(self, prm):  # noqa: N802
        call = VeraSipCall(self, prm.callId, self._loop)
        self._calls.append(call)
        op = pj.CallOpParam(True)
        op.statusCode = pj.PJSIP_SC_OK
        try:
            call.answer(op)
            log.info("incoming call answered (callId=%s)", prm.callId)
        except pj.Error as e:
            log.error("answer failed: %s", e)


class VeraSipCall(pj.Call):
    def __init__(self, acc, call_id, asyncio_loop):
        super().__init__(acc, call_id)
        self._loop = asyncio_loop
        self._bridge: SipBridge | None = None
        self._port = None
        self._industry = DEFAULT_INDUSTRY
        self._t_invite = time.monotonic()
        self._agent_future = None
        self._wired = False

    def onCallState(self, prm):  # noqa: N802
        try:
            ci = self.getInfo()
        except pj.Error:
            return
        log.info("call state: %s code=%s", ci.stateText, ci.lastStatusCode)
        try:
            self._industry = _industry_from_uri(ci.remoteUri or ci.localUri or "")
        except Exception:
            pass
        if ci.state == pj.PJSIP_INV_STATE_DISCONNECTED:
            log.info("call disconnected; bridge stats=%s",
                     self._bridge.stats() if self._bridge else "(no bridge)")

    def onCallMediaState(self, prm):  # noqa: N802
        try:
            ci = self.getInfo()
        except pj.Error:
            return
        for i, mi in enumerate(ci.media):
            if mi.type == pj.PJMEDIA_TYPE_AUDIO and mi.status == pj.PJSUA_CALL_MEDIA_ACTIVE:
                call_audio = self.getAudioMedia(i)
                self._wire_audio(call_audio)
                break

    def _wire_audio(self, call_audio):
        if self._wired:
            return
        self._wired = True
        self._bridge = SipBridge()
        self._port = self._bridge.make_port()
        # Bidirectional: call → port (mic) and port → call (speaker).
        call_audio.startTransmit(self._port)
        self._port.startTransmit(call_audio)
        ms = (time.monotonic() - self._t_invite) * 1000
        log.info("audio path up (industry=%s, t_invite→media=%.0f ms)",
                 self._industry, ms)

        if ECHO_MODE:
            log.info("ECHO_MODE on: short-circuiting audio in→out (no Nova Sonic)")
            self._agent_future = asyncio.run_coroutine_threadsafe(
                self._echo_loop(), self._loop
            )
        else:
            self._agent_future = asyncio.run_coroutine_threadsafe(
                self._run_agent(), self._loop
            )

    async def _echo_loop(self):
        """M1.2a: loop inbound PCM straight back to the speaker queue,
        skipping resample on purpose (8 kHz both ends). Verifies the full
        RTP → port → queue → port → RTP path without Nova Sonic in the
        equation."""
        assert self._bridge is not None
        log.info("echo loop started")
        try:
            while True:
                # Drain inbound; re-emit at 8 kHz directly.
                if self._bridge._inbound is None:
                    await asyncio.sleep(0.05)
                    continue
                pcm = await self._bridge._inbound.get()
                # Skip resample: feed back as if it were 8 kHz from "nova",
                # which sip_audio doesn't do automatically. Use a thin wrapper
                # that just queues the raw 8 kHz chunks.
                for i in range(0, len(pcm), 320):
                    chunk = pcm[i:i + 320]
                    if len(chunk) < 320:
                        chunk += b"\x00" * (320 - len(chunk))
                    self._bridge._outbound.put(chunk)
        except asyncio.CancelledError:
            log.info("echo loop cancelled")
        except Exception as e:
            log.error("echo loop error: %s: %s", type(e).__name__, e)

    async def _run_agent(self):
        assert self._bridge is not None
        try:
            cfg = load_industry(self._industry)
        except ValueError as e:
            log.error("unknown industry '%s': %s", self._industry, e)
            return

        thread_id = f"{cfg.thread_id_prefix}-sip-{uuid.uuid4().hex[:8]}"
        log.info("starting BidiAgent (thread_id=%s)", thread_id)

        agui = AGUIBridge(BFF_AGUI_URL, thread_id)
        await agui.start()
        translator = AGUITranslator(thread_id, agui)
        await asyncio.sleep(0.3)
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
        agent = BidiAgent(model=model, tools=cfg.tools, system_prompt=cfg.prompt)
        audio_in = SipAudioInput(self._bridge)
        audio_out = SipAudioOutput(self._bridge, translator)

        try:
            await agent.run(inputs=[audio_in], outputs=[audio_out])
        except Exception as e:
            log.error("agent.run error: %s: %s", type(e).__name__, e)
        finally:
            try:
                await translator.emit_run_finished()
            except Exception:
                pass
            await agui.stop()
            log.info("agent session ended; bridge stats=%s", self._bridge.stats())


def _pjsua2_worker(ep: pj.Endpoint, ready: threading.Event):
    """pjsua2 has its own event loop driven by libHandleEvents. Spin it
    on a dedicated thread so the asyncio main thread is free."""
    try:
        pj.Endpoint.instance().libRegisterThread("vera-pj-worker")
    except Exception as e:
        log.warning("libRegisterThread: %s", e)
    ready.set()
    while True:
        try:
            ep.libHandleEvents(20)
        except Exception as e:
            log.error("libHandleEvents error: %s", e)
            return


async def main_async():
    log.info("Vera SIP spike starting on UDP :%d", SIP_PORT)
    log.info("industries: %s | default: %s", available_industries(), DEFAULT_INDUSTRY)
    log.info("echo mode: %s", "ON (no Nova Sonic)" if ECHO_MODE else "off")

    ep = pj.Endpoint()
    ep.libCreate()

    ep_cfg = pj.EpConfig()
    ep_cfg.logConfig.level = 3
    ep_cfg.uaConfig.threadCnt = 0  # we drive libHandleEvents from _pjsua2_worker
    ep.libInit(ep_cfg)

    tport_cfg = pj.TransportConfig()
    tport_cfg.port = SIP_PORT
    ep.transportCreate(pj.PJSIP_TRANSPORT_UDP, tport_cfg)
    ep.libStart()
    log.info("pjsua2 endpoint up")

    ready = threading.Event()
    worker = threading.Thread(
        target=_pjsua2_worker, args=(ep, ready), daemon=True, name="pj-worker",
    )
    worker.start()
    ready.wait(timeout=2.0)

    loop = asyncio.get_running_loop()
    acc = VeraSipAccount(loop)
    acc_cfg = pj.AccountConfig()
    acc_cfg.idUri = "sip:vera@127.0.0.1"
    acc.create(acc_cfg)
    log.info("ready. Place a call to sip:<any-user>@<host>:%d", SIP_PORT)

    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        log.info("shutdown requested")
    finally:
        try:
            ep.libDestroy()
        except Exception as e:
            log.warning("libDestroy: %s", e)


if __name__ == "__main__":
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        pass
