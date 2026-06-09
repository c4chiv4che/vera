# Phase D / M1 spike — verdict on D2

**Status.** In progress (template only — fill in as tests are run).

**Question.** Can Python (specifically `pjsua2` + `Strands BidiAgent`
in-process) handle SIP/RTP with the latency and reliability needed for
a banking voice demo? Outcome routes the rest of Phase D:

- **b1** → Python gateway drives Strands in-process. Maximum reuse of
  Phases A–C (industries, tools, AGUI translator, trace view).
- **b2** → Java/JS gateway from the AWS sample handles SIP/RTP and pipes
  PCM frames to a Python `BidiAgent` over an internal transport.

## Environment (READ FIRST before reading the verdict)

- Host OS: WSL2 Ubuntu on Windows (developer machine).
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

## Tests run

### M1.1 — SIP signaling + media path (no Nova Sonic)

- Softphone used: <fill>
- Outcome: <call connected? answered with 200 OK? media negotiated?>
- t_invite → audio path up (from spike log): <ms>
- Findings:

### M1.2a — Echo loopback (`VERA_SIP_ECHO=1`, no Nova Sonic)

- Outcome: <hear your own voice back? dropouts? distortion?>
- Subjective round-trip impression (clap test): <fast / OK / sluggish>
- Findings about the pjsua2 ↔ asyncio bridge:

### M1.2b — Nova Sonic banking happy path

- Test script: dial in, greet, dictate DNI `31234567` digit by digit,
  confirm "Laura Fernández", request a loan of 20.000 USD, accept,
  hang up.
- Outcome: <Vera greeted? identificar_cliente fired? evaluar_prestamo
  fired? privacy rule held under any probe?>
- Trace view populated at `?view=flow&trace=on` for this SIP call:
  <yes/no, and same look as a browser session?>
- Subjective latency on first Vera response: <fast / OK / >1.5 s / >3 s>
- Resample artifacts heard (8↔16 kHz inbound, 24→8 kHz outbound):
  <none / mild / makes ASR misfire>
- Findings:

### M1.2c — Salud industry over SIP (optional)

- Run with `VERA_SIP_INDUSTRY=salud`.
- Outcome: <identifies a seeded patient? agendar_turno fires?>
- Findings:

## Verdict

<Pick exactly one and fill in.>

### Option A — b1 viable in WSL2 (ECS pending M2)

**Recommended:** option b1 (Python gateway drives Strands in-process).

Evidence supporting this:

- <bullet>
- <bullet>

Caveats that MUST carry forward to M2:

- WSL2 was the test bed. ECS host-networking RTP behaviour under
  realistic load (jitter, packet loss, multiple concurrent calls) is
  unverified by this spike.
- <other caveats from the test runs above>

What M2 needs to do before "b1 viable" becomes "b1 confirmed":

- Stand the spike (or its production successor) on an ECS task with
  host networking, against a known SIP test fixture, and re-run the
  M1.1 / M1.2a / M1.2b scripts.
- Test under at least 2 concurrent calls.
- Measure jitter and packet loss tolerance.

### Option B — b2 recommended

**Recommended:** option b2 (Java/JS gateway pipes PCM to a Python bidi
over an internal transport).

Specific blocker(s) found in M1:

- <blocker, with evidence: log excerpt, latency number, install error>
- <blocker>

What was ruled out before settling on b2:

- <Approaches tried in M1 to make b1 work and why they didn't.>

What this implies for M2:

- The Python `BidiAgent` wiring stays in our codebase; only the audio
  transport changes (WebSocket → internal pipe from the Java/JS
  gateway). Phases A–C reuse is preserved in everything except
  `WebSocketAudioInput`/`WebSocketAudioOutput`, which gain a sibling
  adapter for the internal transport.
- We adopt the AWS sample's gateway as the SIP/RTP front door,
  configuring it to forward PCM to our Python service rather than to
  Nova Sonic directly.

## What this spike did NOT settle (regardless of A or B)

- Connect's External Voice Transfer Connector configurability against
  a self-hosted SIP URI in our account (us-east-1). Still needs an
  AWS-console probe; not in scope for M1.
- TLS for SIP / SRTP for RTP. Localhost cleartext in M1.
- DTMF, hold, REFER-based human transfer.
- Production reliability under packet loss, NAT traversal, long calls,
  memory/FD growth over time.
- Concurrent calls. M1 tested one at a time.

## References

- Spike code: `spike/phase-d-sip-python` branch — `agent/app/vera/bidi/sip_spike.py`,
  `agent/app/vera/bidi/sip_audio.py`, `dev-spike-sip.sh`.
- Operator notes: `agent/app/vera/bidi/SIP_SPIKE_NOTES.md`.
- M0 architecture entry: `docs/decisions.md` § "Phase D (M0): Connect
  telephony bridge — architecture spike".
