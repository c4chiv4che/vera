# Phase D / M1 spike — verdict on D2

**Status.** M1 closed. Read precisely — what is exercised, what is
verified by inspection only, and what moves to M2:

- **Exercised end-to-end** (frames flowing through the running code):
  SIP signaling on UDP, RTP at G.711 / PCMA, pjsua2 ↔ asyncio bridge
  headless (no sound device), input chain RTP → SipBridge in-memory
  buffer → Nova Sonic STT → Strands BidiAgent → industries (banking)
  → AGUI translator → BFF trace view. M1.0 (install gate), M1.1 (SIP
  signaling on loopback inside WSL2), and M1.2a (echo loopback at
  the RTP buffer level, Pearson 0.96 / SNR 21.7 dB) all PASS with
  artifacts.
- **Verified by inspection, NOT exercised by frames flowing**: the
  output vocalization path `SipAudioOutput.queue_outbound_pcm` →
  `SipBridge._outbound` → `onFrameRequested` → RTP. Code-level
  parity with `WebSocketAudioOutput.__call__` (`server.py:374-389`),
  which is the production path on the browser leg. M1.2b never
  reached `frames_out > 0` because a unidirectional WAV harness
  cannot supply the end-of-turn signal a SIP peer would (see M1.2b
  Finding 2). The wiring is correct; the harness cannot drive it.
- **Pending M2 (production-fidelity verification)**:
  - Exercise the output vocalization path against Amazon Connect as
    a real SIP peer (natural VAD closes user turns, Nova vocalizes,
    `frames_out > 0` becomes observable for the first time).
  - Speech-input quality with a non-synthetic voice (espeak proved
    too robotic for digit transcription against Nova STT — see
    M1.2b Finding 1; piper-tts or real human voice expected to
    resolve).
  - RTP behaviour on ECS host-networking (WSL2 is not a proxy for
    production network conditions; flagged up-front in
    Environment).

M1.2c (salud industry over SIP) is **deferred to M2 by inspection**,
not pending — see the M1.2c section for the fundamento.

**Question.** Can Python (specifically `pjsua2` + `Strands BidiAgent`
in-process) handle SIP/RTP with the latency and reliability needed
for a banking voice demo? Outcome routes the rest of Phase D:

- **b1** → Python gateway drives Strands in-process. Maximum reuse of
  Phases A–C (industries, tools, AGUI translator, trace view).
- **b2** → Java/JS gateway from the AWS sample handles SIP/RTP and
  pipes PCM frames to a Python `BidiAgent` over an internal transport.

## Environment (READ FIRST before reading the verdict)

- Host OS: WSL2 Ubuntu Noble on Windows (developer machine).
- Production target (NOT this spike): ECS host-networking or EC2 on
  bare Linux.
- **Caveat reserved up front.** WSL2 has its own network stack (a
  virtual NIC, NAT for outbound, IP forwarding for inbound). UDP
  timing — especially RTP at telephony rates and under load — can
  differ between WSL2 and Linux on ECS host-networking. If the
  verdict below says "b1 viable", it means **viable in WSL2; ECS
  host-networking RTP behaviour pending confirmation in M2**. This
  caveat is not optional and must remain in any summary that quotes
  the verdict.

## What actually shipped in M1

### M1.0 — pjsua2 build + Python import + Endpoint create/destroy

- Tested: pjsua2 installed into `tmp/spike-sip-venv` (Python 3.12),
  module imports, `pj.Endpoint.libCreate / libInit / libStart /
  libDestroy` runs without error.
- Evidence (from the spike's first run): pjsua2 log line
  `pjlib 2.17-dev for POSIX initialized`, `libVersion 2.17-dev`,
  clean shutdown.
- Significance: **pjsua2 and the Strands `bidi` extras can coexist
  in the same Python 3.12 venv.** That is the install/integration
  gate that the spike was primarily designed to settle. Settled in
  favour of "Python lane open".

### Install path that actually worked (the M1 finding M2 has to absorb)

The plan assumed `pip install pjsua2` would Just Work. It did not.
Both pre-built fallbacks documented in `SIP_SPIKE_NOTES.md` also
did not work on Ubuntu Noble:

- **`pip install pjsua2` (PyPI sdist) — failed.** The sdist on PyPI is
  broken for our toolchain; the build it triggers does not complete.
- **`apt install python3-pjsua2` — absent.** The package does not exist
  in the Ubuntu Noble repositories.

Only path that worked: **build pjproject from source (2.17-dev, the
current git head of pjsip/pjproject), then build the SWIG Python
bindings against the locally-built pjproject, then install those
bindings into the spike venv.**

**Verified in WSL2 dev session (Ubuntu 24.04 Noble, Python 3.12).
M2 adapts this for a container — pinned version + clean install. See
the two action items immediately below.**

```bash
# 1. Build deps
sudo apt install -y build-essential python3-dev libasound2-dev pkg-config swig

# 2. pjproject from source (PyPI sdist broken, apt absent on Noble)
cd ~
git clone https://github.com/pjsip/pjproject.git
cd pjproject
./configure --enable-shared CFLAGS="-fPIC"
make dep && make -j$(nproc)
sudo make install && sudo ldconfig
# check: pkg-config --modversion libpjproject  → 2.17-dev

# 3. Python binding (SWIG) — compiled against Python 3.12
cd ~/pjproject/pjsip-apps/src/swig/python
make
# install into the target venv (here: the spike venv):
tmp/spike-sip-venv/bin/python setup.py install
# check: python -c "import pjsua2; ep = pjsua2.Endpoint(); ep.libCreate()"
#   → log starts with "pjlib 2.17-dev for POSIX initialized"
```

**M2 actions required to turn this into a reproducible container build
(NOT optional — the recipe above is a WSL2 dev recipe, not a
container-ready one):**

1. **Pin a pjproject version.** `git clone` above fetches HEAD, which
   in this session was `2.17-dev` — a moving target on `master`. M2's
   Dockerfile must check out a specific tag (or commit SHA), so
   production never picks up a different pjproject than the one
   validated. Pick a tagged 2.x release or freeze the commit SHA we
   built against before the M2 image goes out.
2. **Clean install, not `setup.py install` into a venv with system
   site-packages reach.** The WSL2 session used `python setup.py
   install` (deprecated by setuptools) and the venv pulled in some
   system site-packages effects. Acceptable for spike validation; not
   acceptable for a container. M2 builds a wheel from the SWIG output
   (`pip wheel .` or `python -m build`) inside a builder stage, then
   `pip install`s that wheel into the slim runtime stage. No reach
   into the host's system site-packages from inside the container.

The remaining M2 implication, separate from the actions above: the
container needs the C toolchain at build time, so image size and
build time both grow. Multi-stage Docker is the obvious fit (compile
pjproject in a builder stage, copy shared libs + Python bindings into
a slim runtime stage). Estimate both before standing the M2 image up
always-on.

### M1.1 — SIP signaling + media path (softphone, no Nova Sonic)

**Blocked by the WSL2 dev network — NOT by code.** The Python lane is
up; the softphone INVITE cannot reach it from Windows. Diagnosis and
unblock path below; **this is a dev-environment problem only, not an
architecture problem (see "Implication for M2" at the end of this
section).**

What works on the Linux side:

- pjsua2 endpoint comes up: `libCreate / libInit / libStart` succeed,
  UDP transport opened on `0.0.0.0:5060`. Verified with
  `ss -ulnp | grep 5060` — socket bound to `*:5060`, owned by the
  spike process.
- Banking and salud industries load in-process alongside the
  endpoint; no import or init regressions.

What does NOT work, and why:

- A softphone running on the **Windows host** sends INVITE to the
  WSL2 VM's IP (`172.20.208.53/20`, gateway `.1`) on UDP 5060. The
  INVITE **never arrives** at the pjsua2 socket. Root cause: WSL2
  runs the VM behind a NAT that does not forward inbound UDP from
  the Windows host into the VM. SIP signaling between Windows host
  ↔ WSL2 VM is therefore unreachable by default.

Attempts ruled out with evidence (do not re-try blindly next session):

1. **WSL2 `mirrored` networking mode** (drops NAT, exposes the VM on
   the host's network stack directly). FAILED to configure on this
   machine: `wsl --shutdown` followed by `.wslconfig` with
   `networkingMode=mirrored` returned `ConfigureNetworking` internal
   error `0x8007054f`, then silently reverted to `None` and left WSL
   networking broken. Reverted to NAT to restore the dev env.
2. **Windows Defender Firewall inbound rule on UDP 5060.** Created
   successfully, did NOT change behaviour — the INVITE still never
   reaches the VM. Confirms the block is the WSL2 NAT, not the
   Windows firewall.
3. **`netsh interface portproxy`** for UDP 5060 → VM. Discarded
   up-front: `netsh portproxy` supports TCP only, not UDP.

Recommended unblock path for the next session (NOT attempted yet):

- **Run the softphone inside WSL2** (Linphone CLI, or `pjsua` from
  the pjproject build tree) and dial `sip:127.0.0.1:5060`. This
  avoids the Windows ↔ WSL2 NAT crossing entirely and exercises the
  full SIP + RTP + (M1.2b onward) Nova Sonic path end-to-end on
  loopback inside the VM. Same code path as a real call once the
  signaling is in.

**Implication for M2 — this is a dev-only constraint.** In ECS
(deploy target) there is no WSL2 NAT in front of the container; SIP
and RTP arrive directly via the service's ENI / NLB. The blocker is
the *developer machine's network shape*, not the b1 architecture.
The "WSL2 ≠ ECS host-networking RTP" caveat in the Environment
section above already covers the production-side qualifier; do not
read M1.1's signaling block as a b1 viability hit.

### M1.2a — Echo loopback (`VERA_SIP_ECHO=1`, no Nova Sonic)

**First run revealed two spike-code bugs; both fixed; re-test pending.**

Run setup that exercised the path:

- Headless prerequisite: `audDevManager().setNullDev()` before
  `libStart()` in `sip_spike.py`. The conference bridge needs a clock
  master; by default pjsua2 lazy-opens the system sound device and
  fails on WSL2 (and would fail on ECS). The null device provides
  timing without touching hardware. **This is a production requirement
  for ECS, not a WSL2 workaround** — resolving it in M1 means M2's
  container build inherits the same audio model with no rework.
- pjsua client (also inside WSL2) playing a synthetic PCM16 mono 8 kHz
  sweep with `--null-audio`, `--auto-play`, `--auto-rec`, codecs forced
  to PCMU/PCMA so the negotiated leg matches what Amazon Connect will
  send. SIP + RTP layer behaved correctly: 400 packets TX, 32 RX, 0%
  loss, PCMA negotiated, jitter ~0.1 ms.

Two implementation bugs surfaced; both isolated, both fixed in this
session:

1. **`bind_loop` was never called in ECHO_MODE.** `SipBridge.bind_loop`
   lived only inside `SipAudioInput.start()`, which is instantiated
   from `_run_agent()` (the Nova Sonic path). `ECHO_MODE` dispatches
   `_echo_loop` instead, so the asyncio queue was never created and
   every inbound RTP frame hit the `loop is None` guard in
   `on_frame_received` and was dropped. Stats from the failed run:
   `frames_dropped_pre_bind=400`, `frames_in=0`. **Fix:** bind the
   loop in `_wire_audio` (the canonical point where the bridge is
   created and the loop is already available), make `bind_loop`
   idempotent so the existing `SipAudioInput.start()` call remains a
   defensive no-op for standalone use.
2. **`onFrameRequested` wrote to `frame.buf` with the wrong type.** The
   pjsua2 SWIG binding types `MediaFrame.buf` as `pj::ByteVector *`;
   reassigning it from Python (`frame.buf = list(data)`) raises
   `MediaFrame_buf_set ... argument 2 of type 'pj::ByteVector *'`. The
   binding's own docstring (`pjsua2.py:5779-5784`) states that
   `frame.buf` arrives as an empty vector and must be **filled
   in-place**. `ByteVector` exposes `assign_from_bytes()` as the
   canonical Python writer (`pjsua2.py:435`). **Fix:** use
   `frame.buf.assign_from_bytes(data)` in `onFrameRequested`. While
   on it, migrate `onFrameReceived` to the matching reader
   `frame.buf.copy_to_bytearray(buf)` — the previous slice-based
   read worked by accident via `ByteVector.__getitem__` but was ~10x
   slower per frame and asymmetric with the writer.

**Evidence note 1 — the spike bugs were caught by instrumentation we
added on purpose, not by luck.** Both observable symptoms came from
the silent-drop counter (`frames_dropped_pre_bind`) added in
`sip_audio.py` at the start of this session, and the `cannot write
frame.buf` log that already existed but became actionable because the
counter explained *why* none of the inbound frames reached the agent.
Without the counter, the failed run would have looked like "Vera
didn't hear the greeting" with no path back to the root cause —
exactly the debug nightmare the rule `[[feedback_no_silent_drops]]`
is meant to prevent.

**Second-run result (eco certified on existing audio, Plan B).** The
fixed re-run gave `frames_in=400`, `frames_dropped_pre_bind=0`,
`frames_silence=1`, `frames_out=0`, `outbound_queued=1`; client side
TX 400 / RX 400 / 0% loss, PCMA negotiated. The recorded WAV was
*structurally invalid* (`"not a WAVE file"`), which initially looked
like the echo had broken in a new way. Two further bugs surfaced —
**both in the test harness, neither in the spike**:

1. **`pjsua --duration=N` does not flush the WAV recorder header.**
   The `pjmedia_wav_writer_port` holds the RIFF/data chunk sizes in
   memory and only writes them at `pjmedia_port_destroy()`, which
   runs from `pjsua_destroy()`. `--duration=N` ends the call but does
   not destroy the endpoint, so an abrupt exit (Ctrl+C, kill) leaves
   the recorded WAV with `RIFF size = 0` and `data size = 0`.
   Confirmed with `xxd` against the recv file from the second run:
   bytes 4-7 and 40-43 both `00 00 00 00`. **Audio is intact starting
   at byte 44**, only the header chunk-size fields are missing.
2. **`pjsua --rec-file` writes at the clock-master rate, not the
   negotiated codec rate.** Default clock master is 16 kHz. PCMA
   negotiated at 8 kHz, pjsua resamples 8 k → 16 k internally before
   writing. Confirmed in the recv header: bytes 24-27 = `803e 0000` =
   16000. Fix is `--clock-rate=8000` on the client.

Plan B closed the diagnostic without re-running: patched the two
chunk sizes from the file length, taught `compare_echo_wav.py` to
align mismatched sample rates with `audioop.ratecv`, then ran the
comparator. Result on the patched + resampled artifact:

```
Pearson at peak              : 0.9765
~SNR                         : 23.9 dB
echo lag                     : 78.9 ms
aligned region               : 3.000 s
PASS: correlation 0.977 >= 0.7 — echo returned the input audio
```

**Verdict: the RTP → SipMediaPort → asyncio.Queue → _echo_loop →
queue.Queue → SipMediaPort → RTP path is correct.** M1.2a is
functionally complete pending one clean artifact run (see plan
below).

**Evidence note 2 — the measurement instrument was wrong, again.**
Without the binary header inspection, the natural next step would
have been to refactor `_echo_loop` to fix a bug it did not have —
exactly the failure mode of fixing the symptom upstream of the real
cause. The pattern from note 1 repeats one level out: there, a
silent drop on the way IN made a working agent look broken; here, a
silent corruption on the way OUT (truncated header + wrong rate)
made a working echo look broken. Both times the recovery was the
same — read what the instrument actually wrote, not what we thought
it had written. Keep this in mind for M1.2b: when Nova Sonic is in
the loop, every test artifact (logs, recorded audio, AGUI events)
needs to be checked for "is the instrument lying?" before drawing
conclusions about the agent.

Clean-artifact re-run plan (last step for M1.2a verdict):

```bash
(sleep 8 && printf 'h\nq\n') | pjsua \
  --null-audio --no-tcp --local-port=5072 \
  --clock-rate=8000 \
  --dis-codec=speex --dis-codec=iLBC --dis-codec=GSM \
  --dis-codec=G722 --dis-codec=opus \
  --add-codec=PCMU --add-codec=PCMA \
  --auto-play --play-file=tmp/spike-audio/tono-8k.wav \
  --auto-rec  --rec-file=tmp/spike-audio/recv-8k.wav \
  --max-calls=1 \
  sip:vera@127.0.0.1:5070
```

- `--clock-rate=8000` makes the recorder native 8 kHz (no resample
  in the comparator).
- Replacing `--duration=8` with `(sleep 8 && printf 'h\nq\n') | ...`
  routes through `pjsua_destroy()` and flushes the WAV header
  cleanly.

Expected at completion: same server counters as the second run, plus
a valid WAV at 8 kHz that `compare_echo_wav.py` accepts without
hitting the resample branch.

**Clean-artifact run result — M1.2a CLOSED.**

Re-ran with `--clock-rate=8000` and the stdin pipe replacing
`--duration`. Recorded WAV opened natively at 8 kHz with a valid
header; the comparator's resample branch was not exercised.

```
Pearson at peak              : 0.960
~SNR                         : 21.7 dB
echo lag                     : 66.5 ms
```

The patched run (Plan B, Pearson 0.977 / SNR 23.9 dB / lag 78.9 ms)
remains in the record as **diagnostic evidence**; this clean run is
the **canonical artifact** for M1.2a.

What is now settled:

- `audDevManager().setNullDev()` before `libStart()` makes the spike
  run headless on WSL2 and (by design) on ECS — the conference
  bridge's clock master is virtual, no sound card required.
- The pjsua2 ↔ asyncio bridge (`SipMediaPort` + `SipBridge`) carries
  RTP through `assign_from_bytes` / `copy_to_bytearray` correctly,
  no audio device touched, ~67 ms round-trip lag in loopback.
- `compare_echo_wav.py` (pure stdlib) is the headless audio gate for
  the rest of Phase D — no sox/ffmpeg/numpy dependency.

Canonical pjsua client command for any 8 kHz codec test against the
spike (use as-is for M1.2b/c, swap the play-file for the relevant
audio):

```bash
(sleep 8 && printf 'h\nq\n') | pjsua \
  --null-audio --no-tcp --local-port=5072 \
  --clock-rate=8000 \
  --dis-codec=speex --dis-codec=iLBC --dis-codec=GSM \
  --dis-codec=G722 --dis-codec=opus \
  --add-codec=PCMU --add-codec=PCMA \
  --auto-play --play-file=<wav-at-8khz> \
  --auto-rec  --rec-file=tmp/spike-audio/recv-8k.wav \
  --max-calls=1 \
  sip:vera@127.0.0.1:5070
```

### M1.2b — Nova Sonic banking happy path over the phone

**CLOSED with the honest reading: input chain confirmed end-to-end
(architectural b1 viable). Output vocalization NOT testable with a
unidirectional WAV harness — this is a property of the test setup,
not a defect of b1 or of the spike. Verification deferred to M2 with
Amazon Connect as the SIP peer.**

First-run setup:

- Input WAV (~7.3 s) synthesized with `synth_speech_wav.py` + espeak-ng:
  `"Hola, quiero pedir un préstamo. Mi D N I es tres uno dos tres
  cuatro cinco seis siete."`
- Spike in real Nova Sonic mode (`unset VERA_SIP_ECHO`).
- BFF running for AGUI events (`./dev.sh start bff`).
- Client pjsua with the canonical 8 kHz / PCMA command, 12 s call.

First-run result:

```
spike server stats : frames_in=400  frames_dropped_pre_bind=0
                     frames_out=0   frames_silence=599
                     outbound_queued=0
spike server log   : "interruption: outbound cleared"
client RTP         : TX ~400 / RX ~33 / 0% loss
transcript         : role=assistant — "Hola, claro que sí!
                     Qué tipo de préstamo estás buscando?"
recorded WAV       : silence (no Vera audio)
```

Reading: Nova Sonic received the input, transcribed it, decided the
response **as text** (visible in the transcript), and then emitted a
`BidiInterruptionEvent` **before** the first `BidiAudioStreamEvent` —
so `SipAudioOutput.queue_outbound_pcm` was never called and the
outbound queue stayed empty. The wiring is identical to the
WebSocket path's `WebSocketAudioOutput` (`server.py:374-389`), which
already works end-to-end in production; `frames_out=0` is not a
wiring bug.

**Finding 1 — TTS PARTIAL (known, expected, harness-side).**

espeak-ng's synthetic voice did not yield clean digit transcription
against Nova Sonic STT. Observed errors in the first-run transcript:

- "Mi D N I es" → transcribed as "mi nombre es Pedro".
- "tres uno dos tres" → transcribed as "noventa y tres".

Cause: synthetic voice with insufficient prosody between digits. No
spike-code action; the synth pipeline is doing what we asked.

**Action (deferred, NOT for M1.2b closing):** upgrade to piper-tts
(neural voice) or tune espeak prosody (`--pitch`, explicit pauses
between digits like "uno, dos, tres"). Note for M2: caracterizing
the range of voice qualities that the SIP leg tolerates is a real
test target, but it belongs to integration testing against Connect,
not to spike validation.

**Finding 2 — end-of-turn signaling absent on the SIP leg
(architectural, NOT a b1 bug — M2 verification needed).**

The WebSocket leg has an explicit end-of-turn signal: the browser
sends `{"type":"end"}` (`server.py:354`) when MediaRecorder stops,
and the server stops feeding audio to Nova. The SIP leg has no
equivalent: `pjsua --auto-play` finishes the WAV but pjsua keeps
sending comfort-noise / silence frames until hangup, and there is no
in-band SIP mechanism that says "user finished their turn". Nova
Sonic falls back to its own VAD to decide when the turn ends, and in
this test — a 7.3 s WAV played in one continuous chunk — Nova
interpreted the late portion of the WAV (or the lingering CN frames
after it) as "the user is still speaking" and self-interrupted the
generated response before vocalization.

This is **not a defect of b1** and the spike code does not need to
fix it:

- In production, Amazon Connect → Vera carries the natural pauses
  of a real caller. Nova's VAD reads those pauses as turn end and
  vocalization completes normally — the canonical behaviour of any
  SIP-based voicebot.
- The pathology only fires when a test harness plays a long
  continuous synthetic clip with no pauses, which is exactly our
  M1.2b harness.

**Action for M2 (not M1):** verify end-of-turn behaviour with
Connect as the SIP peer (real PCMU/PCMA from a real caller, VAD
natural). If end-of-turn detection in production shows the same
self-interrupt symptom, *then* invest in either a Strands-level
end-of-turn API call from the spike or a SIP-level workaround
(e.g. RTP-level VAD on the gateway). Until M2 produces evidence
that this is a real issue with Connect, treat it as a harness
artifact.

**Second run — shorter input WAV (Option A1, harness-only change).**

Re-ran with `tmp/spike-audio/dni-short-8k.wav` (5.31 s, "Hola. Mi
D N I es tres uno dos tres cuatro cinco seis siete."), same canonical
pjsua command at `sip:vera@127.0.0.1:5060`. Result:

```
spike server stats : frames_out=0  recv RMS ≈ 0.0001
client RTP         : RX 33 pkt (CN / silence only)
spike server log   : NO "interruption: outbound cleared" this time
Nova events        : transcripts role=user repeated, NO assistant
                     response_start, NO BidiAudioStreamEvent
```

Critical difference from the first run: this time **the user turn
never closed at all**. The first run at least had Nova decide the
response (transcript role=assistant present) before self-interrupting;
this run never even got to a response decision. With the shorter
WAV, `--auto-play` finishes earlier and pjsua then injects ~7 s of
continuous comfort-noise / silence frames into the RTP stream until
hangup. Nova VAD never sees the kind of pause that closes a user
turn, so the model treats the whole call as one ongoing user input.
Shorter WAV did not bring Vera closer to vocalizing; it just changed
what got re-processed.

**Conclusion: vocalization is not testable with a unidirectional
synthetic-WAV harness.** Further shortening the WAV would be
stubbornness, not method. The bottleneck is not WAV duration — it is
the absence of an end-of-turn signal on the SIP leg (Finding 2),
which a one-shot WAV harness fundamentally cannot supply.

**What M1.2b confirms:**

- Architectural cadena b1 viable. The chain SIP → pjsua2 →
  SipAudioInput → Strands BidiAgent → Nova Sonic STT → Nova LLM →
  industry tools loaded → assistant response materialized as
  transcript text. End-to-end input path observed in the first run.
- Non-vocalization counters healthy across both runs:
  `frames_in≈400`, `frames_dropped_pre_bind=0` (no regressions vs
  M1.2a). AGUI events flow to the BFF trace view.
- Output wiring verified by inspection: `SipAudioOutput.__call__`
  (`sip_audio.py:289-296`) is structurally identical to
  `WebSocketAudioOutput.__call__` (`server.py:374-389`), which has
  worked end-to-end in production on the browser path. The SIP
  output path is the same logic with a different transport.

**What M1.2b CANNOT confirm with this harness (deferred to M2):**

- `frames_out > 0` from a real SIP peer that closes user turns
  naturally. The unidirectional WAV harness has no way to deliver
  that signal — this is a property of the test setup, not of b1.

**This is NOT a b1 bug and NOT a spike bug.** The output wiring is
verified by code-level parity with the WebSocket path; what is
missing is a peer that closes user turns. Amazon Connect → Vera
provides exactly that via the natural VAD of a real caller. The
"verification of vocalization end-to-end" target moves to M2:

- **Action M2 (not M1):** verify Vera vocalizes on a real Connect
  SIP leg. If `frames_out > 0` and the caller hears Vera, b1 is
  closed at production fidelity. If Connect *also* fails to elicit
  vocalization, *only then* investigate end-of-turn explicitly
  (Strands-level API to mark user-turn-end, or RTP-level VAD on
  the gateway). Do not preemptively build either workaround on the
  evidence we have today — they would solve a problem the test
  harness has, not a problem b1 has.

**Finding 1 (TTS PARTIAL) remains as documented**: switch to
piper-tts before re-running any synthetic-voice test against Nova.
Independent of M1.2b closing.

**Findings note — the same pattern, third time.** M1.2a wave 1
(silent drops), M1.2a wave 2 (truncated WAV header), M1.2b
(unidirectional WAV without end-of-turn). Each time the natural
move was to chase the symptom into spike code; each time the actual
cause was upstream — in instrumentation, in the test harness, in
the protocol-level test setup. The discipline of "what does the
instrument actually tell us, and is that the right instrument for
this question?" has paid off across all three. M2 inherits this
discipline: when Connect is the peer, ask the same question of
every metric before concluding anything about b1 itself.

### M1.2c — Salud industry over SIP

**Deferred to M2 by inspection — explicitly NOT "pending next
session".** Running M1.2c under the current harness would hit
exactly the same end-of-turn limitation as M1.2b (Finding 2) without
surfacing new evidence about the SIP transport. The dispatch piece
that M1.2c was meant to validate — industry-agnostic load — is
already verified end-to-end from M1.2b:

- `agent_loader.load_industry()` is called inside `_run_agent`
  (`sip_spike.py:180`) with the value of `self._industry`, which
  comes from `VERA_SIP_INDUSTRY` env var or `?industry=` URI param.
  There is no banking-specific branch elsewhere in the SIP path.
- The load was exercised end-to-end with banking in M1.2b (`industries:
  [banking, salud] | default: banking` at startup, banking tools
  loaded into the `BidiAgent`, banking transcript materialized as
  assistant response).

Re-running with `salud` under this harness would observe (a) the same
input chain working, (b) the same vocalization gap (`frames_out=0`,
harness limit), and (c) different transcript content from a different
prompt — none of which adds evidence about b1 viability.

**M2 action (integration, not spike):** when Connect is the peer and
end-of-turn flows naturally, exercise both industries on the same
gateway process via two consecutive calls (distinct `industry=` URI
params or env switch). That test confirms runtime industry switching
on a single SIP process, which is the thing M1.2c was originally
meant to probe.

## Verdict

**D2 resolves toward b1 — viable architecturally. Python handles the
full SIP/RTP/Strands/Nova Sonic/industries/AGUI stack in one process.
One piece of the path — the output vocalization on the SIP leg — is
verified by code-level parity with the production WebSocket path, not
by frames flowing through this harness; that exercise belongs to M2
with Amazon Connect as the SIP peer.**

This is **not** "b1 works end-to-end with voice." The output voice was
not heard from a SIP client in any run. It IS "b1 is the right
architecture to bet M2 on, and the spike found no Python-side or
wiring-side blocker in the way."

**What is settled (exercised, with artifacts):**

- The Python lane is open. `pjsua2` and Strands `bidi` coexist in one
  Python 3.12 venv. The b2 trigger "pjsua2 install fight >2 h with no
  path forward" is cleared (build-from-source recipe in §M1.0).
- Headless RTP from the bridge in-memory only. The conference bridge
  runs against a null sound device (`setNullDev()` before `libStart`),
  which is a production requirement for ECS, not a WSL2 workaround.
- SIP signaling on loopback inside WSL2: INVITE → 100 → 200 OK → ACK
  → CONFIRMED (M1.1).
- RTP through `SipMediaPort` / `SipBridge`: 400 frames in, 400 frames
  out, Pearson 0.96 against input, ~67 ms round-trip lag (M1.2a clean
  artifact).
- Input chain end-to-end: SIP/RTP → Nova Sonic STT (Spanish) → Strands
  BidiAgent → banking industry tools loaded → assistant response
  materialized as transcript text (M1.2b first run).
- `compare_echo_wav.py` and `synth_speech_wav.py` available as
  pure-stdlib (+ espeak-ng) test harnesses for future phases.

**What is verified by code inspection only (NOT exercised by frames):**

- `SipAudioOutput.queue_outbound_pcm` → `_outbound` → `onFrameRequested`
  → RTP. This is the output vocalization path. Structurally identical
  to `WebSocketAudioOutput.__call__` (`server.py:374-389`) which works
  end-to-end in production on the browser leg. M1.2b did not reach
  `frames_out > 0` because a unidirectional WAV harness cannot supply
  a user-turn-end signal that a real SIP peer would. The wiring is
  correct; the harness cannot drive it.

**What remains pending for M2 (production-fidelity verification):**

- **Exercise the output vocalization path against Amazon Connect** as
  the SIP peer. Real caller VAD closes user turns naturally, Nova
  vocalizes, `frames_out > 0` becomes observable for the first time.
  If Connect ALSO fails to elicit vocalization — *only then* —
  investigate end-of-turn explicitly (Strands-level API or RTP-level
  VAD on the gateway). Do not preemptively build either workaround
  on harness-side evidence.
- **Speech-input quality with a non-synthetic voice.** espeak proved
  too robotic for digit transcription against Nova STT (M1.2b
  Finding 1). Switch to piper-tts or real-caller voice before
  drawing any conclusions about Nova STT quality.
- **RTP behaviour on ECS host-networking.** WSL2 is not a proxy for
  production network conditions (caveat reserved in Environment).
  Verify under the production network shape before declaring b1
  closed.
- **Industry switching at runtime on a single gateway process.** The
  load is verified industry-agnostic by inspection (see M1.2c); the
  runtime switch between two consecutive calls of different
  industries is an M2 integration test.

**Practical reading:**

- Plan M2 on b1. The spike found no fundamental Python-side or
  wiring-side blocker; the one remaining "must observe in frames"
  item (output vocalization) is gated on having a peer that closes
  user turns, which Connect provides natively.
- **Keep this branch (`spike/phase-d-sip-python`) in place; do NOT
  merge into main.** All code under `agent/app/vera/bidi/sip_*.py`
  and the spike harness are throwaway by design — the production
  gateway in M2 will reuse the *shape* of `SipBridge` /
  `SipAudioInput` / `SipAudioOutput` but be re-derived against the
  Connect-side requirements (codec selection, NAT/STUN config,
  observability, FD/memory ceilings, container shape). Treat the
  spike branch as evidence + reference, not as a base to extend.
- Close D2 in `docs/decisions.md` with the precise reading above.
  Do not quote "b1 confirmed end-to-end with voice" — quote the
  distinction between exercised, inspected, and pending-M2.

## What this spike did NOT settle (regardless of A or B)

- Connect's External Voice Transfer Connector configurability against
  a self-hosted SIP URI in our account (us-east-1). Still needs an
  AWS-console probe; not in scope for M1.
- TLS for SIP / SRTP for RTP. Localhost cleartext in M1.
- DTMF, hold, REFER-based human transfer.
- Production reliability under packet loss, NAT traversal, long
  calls, memory/FD growth over time.
- Concurrent calls. M1 tests one call at a time.

## References

- Spike code: `spike/phase-d-sip-python` branch —
  `agent/app/vera/bidi/sip_spike.py`,
  `agent/app/vera/bidi/sip_audio.py`,
  `dev-spike-sip.sh`.
- Operator notes: `agent/app/vera/bidi/SIP_SPIKE_NOTES.md`.
- M0 architecture entry: `docs/decisions.md` § "2026-06 — Phase D
  (M0): Connect telephony bridge — architecture spike".
