"""
Phase D / M1 spike — SIP audio adapters for Strands BidiAgent.

Throwaway code. The job is to answer D2: can Python (pjsua2 + Strands)
drive a SIP call end-to-end with Nova Sonic in-process? See
docs/phase-d-m1-verdict.md for the question and verdict template.

Design mirrors the WebSocket adapters in server.py — same BidiInput /
BidiOutput shape — but the audio path is RTP via pjsua2's AudioMediaPort
instead of a WebSocket carrying base64 PCM. The Strands BidiAgent wiring
in sip_spike.py is byte-identical to server.py except for the adapter
classes used.

Threading:
  pjsua2 invokes onFrameReceived / onFrameRequested from its own media
  thread. Asyncio code must NOT be called from there directly. We bridge
  via loop.call_soon_threadsafe for inbound (pj → asyncio) and a plain
  thread-safe queue.Queue for outbound (asyncio → pj). The asyncio side
  blocks on asyncio.Queue.get; the pj side does a non-blocking get with
  silence fallback so the audio thread never stalls.

Sample rates (banking/vera.yaml is authoritative):
  SIP:           PCM16 mono @  8 kHz  (G.711 negotiated; pjsua2 decodes
                                       internally and hands us PCM16)
  Nova Sonic in: PCM16 mono @ 16 kHz  (input_rate from manifest)
  Nova Sonic out:PCM16 mono @ 24 kHz  (output_rate from manifest)

If the manifest changes those rates, the constants below need to follow.
"""
from __future__ import annotations

import asyncio
import audioop
import base64
import logging
import queue
from typing import TYPE_CHECKING

import pjsua2 as pj
from strands.experimental.bidi.types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiInterruptionEvent,
)
from strands.experimental.bidi.types.io import BidiInput, BidiOutput

if TYPE_CHECKING:
    from strands.experimental.bidi.agent import BidiAgent
    from strands.experimental.bidi.types.events import BidiOutputEvent

log = logging.getLogger("sip-audio")

SIP_RATE = 8000
SIP_CHANNELS = 1
SIP_BITS_PER_SAMPLE = 16
SIP_FRAME_MS = 20
SIP_FRAME_BYTES = int(SIP_RATE * SIP_CHANNELS * (SIP_BITS_PER_SAMPLE // 8) * SIP_FRAME_MS / 1000)

NOVA_INPUT_RATE = 16000   # what we feed to Nova Sonic
NOVA_OUTPUT_RATE = 24000  # what Nova Sonic feeds back to us


class SipBridge:
    """One per call. Owns the pjsua2 AudioMediaPort plus the two queues
    that connect it to the asyncio loop.

    Inbound  (softphone mic → BidiAgent → Nova Sonic):
        pjsua2 thread  : onFrameReceived(frame)
            → loop.call_soon_threadsafe(_inbound.put_nowait, bytes)
        asyncio task   : await _inbound.get()
            → audioop.ratecv(... SIP_RATE → NOVA_INPUT_RATE ...)
            → b64 → BidiAudioInputEvent
    Outbound (Nova Sonic → BidiAgent → softphone speaker):
        asyncio task   : BidiAudioStreamEvent (24 kHz PCM16)
            → audioop.ratecv(... NOVA_OUTPUT_RATE → SIP_RATE ...)
            → chunk into SIP_FRAME_BYTES → _outbound.put(chunk)
        pjsua2 thread  : onFrameRequested(frame)
            → _outbound.get_nowait() or silence
    """

    def __init__(self):
        self._loop: asyncio.AbstractEventLoop | None = None
        self._inbound: asyncio.Queue[bytes] | None = None
        self._outbound: "queue.Queue[bytes]" = queue.Queue()
        self._silence_frame = b"\x00" * SIP_FRAME_BYTES
        self._in_state = None
        self._out_state = None
        self._port: "SipMediaPort | None" = None
        self._frames_in = 0
        self._frames_out = 0
        self._frames_silence = 0
        self._frames_dropped_pre_bind = 0

    # --- asyncio side --------------------------------------------------

    def bind_loop(self, loop: asyncio.AbstractEventLoop):
        # Idempotent: _wire_audio binds eagerly so the inbound queue exists
        # before the first RTP frame arrives. SipAudioInput.start() still
        # calls this defensively for standalone use; the no-op guard below
        # prevents pisar the existing queue (which would leak buffered frames).
        if self._loop is loop and self._inbound is not None:
            return
        self._loop = loop
        self._inbound = asyncio.Queue(maxsize=200)

    async def get_inbound_resampled(self) -> tuple[bytes, int]:
        if self._inbound is None:
            raise RuntimeError("SipBridge.bind_loop() not called yet")
        pcm8k = await self._inbound.get()
        pcm16k, self._in_state = audioop.ratecv(
            pcm8k, 2, SIP_CHANNELS, SIP_RATE, NOVA_INPUT_RATE, self._in_state
        )
        return pcm16k, NOVA_INPUT_RATE

    def queue_outbound_pcm(self, pcm24k: bytes):
        """Resample Nova Sonic PCM (24k) down to SIP (8k) and chunk into
        20ms frames for the pjsua2 thread to pull."""
        if not pcm24k:
            return
        pcm8k, self._out_state = audioop.ratecv(
            pcm24k, 2, SIP_CHANNELS, NOVA_OUTPUT_RATE, SIP_RATE, self._out_state
        )
        for i in range(0, len(pcm8k), SIP_FRAME_BYTES):
            chunk = pcm8k[i:i + SIP_FRAME_BYTES]
            if len(chunk) < SIP_FRAME_BYTES:
                chunk += b"\x00" * (SIP_FRAME_BYTES - len(chunk))
            self._outbound.put(chunk)
            self._frames_out += 1

    def clear_outbound(self):
        try:
            while True:
                self._outbound.get_nowait()
        except queue.Empty:
            pass

    def stats(self) -> dict:
        return {
            "frames_in": self._frames_in,
            "frames_out": self._frames_out,
            "frames_silence": self._frames_silence,
            "frames_dropped_pre_bind": self._frames_dropped_pre_bind,
            "outbound_queued": self._outbound.qsize(),
        }

    # --- pjsua2 side ---------------------------------------------------

    def make_port(self) -> "SipMediaPort":
        fmt = pj.MediaFormatAudio()
        fmt.type = pj.PJMEDIA_TYPE_AUDIO
        fmt.clockRate = SIP_RATE
        fmt.channelCount = SIP_CHANNELS
        fmt.bitsPerSample = SIP_BITS_PER_SAMPLE
        fmt.frameTimeUsec = SIP_FRAME_MS * 1000
        port = SipMediaPort(self, fmt)
        port.createPort("vera-sip-port", fmt)
        self._port = port
        return port

    def on_frame_received(self, pcm_bytes: bytes):
        """Called from the pjsua2 media thread. Must not block."""
        loop = self._loop
        inbound = self._inbound
        if loop is None or inbound is None:
            # Window between RTP starting (onCallMediaState wires the port)
            # and SipAudioInput.start() calling bind_loop(). Frames that land
            # here are the FIRST words of the caller — silently dropping them
            # means "Vera didn't hear the greeting", which is a nightmare to
            # debug. Log the first one and then every 50th (~1s of audio).
            self._frames_dropped_pre_bind += 1
            n = self._frames_dropped_pre_bind
            if n == 1 or n % 50 == 0:
                log.warning(
                    "inbound dropped pre-bind: bridge.bind_loop() not called yet "
                    "(total dropped this call: %d frames ≈ %d ms)",
                    n, n * SIP_FRAME_MS,
                )
            return
        self._frames_in += 1
        try:
            loop.call_soon_threadsafe(inbound.put_nowait, pcm_bytes)
        except RuntimeError:
            # Loop closed mid-call — surface, don't swallow.
            log.warning("inbound dropped: loop closed")
        except asyncio.QueueFull:
            log.warning("inbound queue full, dropping frame")

    def on_frame_requested(self) -> bytes:
        """Called from the pjsua2 media thread. Returns SIP_FRAME_BYTES."""
        try:
            return self._outbound.get_nowait()
        except queue.Empty:
            self._frames_silence += 1
            return self._silence_frame


class SipMediaPort(pj.AudioMediaPort):
    """Custom pjsua2 audio port that hands frames to/from the SipBridge.

    The pjsua2 Python binding usually exposes MediaFrame.buf as a list of
    ints. We convert both directions defensively in case a future binding
    revision changes that to bytes-like.
    """

    def __init__(self, bridge: SipBridge, fmt):
        super().__init__()
        self._bridge = bridge
        self._fmt = fmt

    def onFrameReceived(self, frame):  # noqa: N802 (pjsua2 vtbl naming)
        # frame.buf is a pj::ByteVector (SWIG-wrapped C++ vector). The binding
        # exposes copy_to_bytearray() as the canonical Python reader — see
        # pjsua2.py:438. Slicing the vector through __getitem__ also works
        # but is ~10x slower per frame.
        try:
            size = frame.size
            if not size:
                return
            buf = bytearray(size)
            frame.buf.copy_to_bytearray(buf)
            data = bytes(buf)
        except Exception as e:
            log.warning("onFrameReceived: cannot read frame.buf (%s)", e)
            return
        if data:
            self._bridge.on_frame_received(data)

    def onFrameRequested(self, frame):  # noqa: N802
        # frame.buf arrives empty and MUST be filled in-place (the setter is
        # typed pj::ByteVector* and rejects list/bytes — that was BUG 2).
        # assign_from_bytes() is the binding's canonical writer; see
        # pjsua2.py:435 and the onFrameRequested docstring at pjsua2.py:5779.
        data = self._bridge.on_frame_requested()
        try:
            frame.type = pj.PJMEDIA_FRAME_TYPE_AUDIO
            frame.buf.assign_from_bytes(data)
            frame.size = len(data)
        except TypeError:
            # Belt-and-braces: if the binding is strict about bytes vs bytearray
            # on this build, retry with bytearray. assign_from_bytes accepts
            # either in current PJSIP master, but pinning is uncertain.
            frame.buf.assign_from_bytes(bytearray(data))
            frame.size = len(data)
        except Exception as e:
            log.warning("onFrameRequested: cannot write frame.buf (%s)", e)


class SipAudioInput(BidiInput):
    """BidiInput that reads PCM from the SipBridge inbound queue."""

    def __init__(self, bridge: SipBridge):
        self._bridge = bridge

    async def start(self, agent: "BidiAgent") -> None:
        self._bridge.bind_loop(asyncio.get_running_loop())
        log.info("SipAudioInput started (%d Hz → %d Hz)", SIP_RATE, NOVA_INPUT_RATE)

    async def stop(self) -> None:
        log.info("SipAudioInput stopped; stats=%s", self._bridge.stats())

    async def __call__(self) -> BidiAudioInputEvent:
        pcm16k, rate = await self._bridge.get_inbound_resampled()
        return BidiAudioInputEvent(
            audio=base64.b64encode(pcm16k).decode("utf-8"),
            channels=SIP_CHANNELS,
            format="pcm",
            sample_rate=rate,
        )


class SipAudioOutput(BidiOutput):
    """BidiOutput that:
      - routes audio events back to the softphone via SipBridge
      - routes non-audio events to the AGUITranslator (same contract as
        WebSocketAudioOutput in server.py)
    """

    def __init__(self, bridge: SipBridge, translator):
        self._bridge = bridge
        self._translator = translator

    async def start(self, agent: "BidiAgent") -> None:
        log.info("SipAudioOutput started (%d Hz → %d Hz)", NOVA_OUTPUT_RATE, SIP_RATE)

    async def stop(self) -> None:
        log.info("SipAudioOutput stopped")

    async def __call__(self, event: "BidiOutputEvent") -> None:
        try:
            if isinstance(event, BidiAudioStreamEvent):
                pcm24k = base64.b64decode(event["audio"])
                self._bridge.queue_outbound_pcm(pcm24k)
                return
            if isinstance(event, BidiInterruptionEvent):
                self._bridge.clear_outbound()
                log.info("interruption: outbound cleared")
                return
            event_name = type(event).__name__
            log.info("event: %s | %s", event_name, str(event)[:300])
            await self._translator.translate(event)
        except Exception as e:
            log.error("SipAudioOutput error: %s: %s", type(e).__name__, e)
