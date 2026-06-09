# Phase D / M1 spike — verdict on D2

**Status.** M1 partial. Install/integration gate cleared (pjsua2
imports and creates a SIP Endpoint in the same Python 3.12 venv as
Strands BidiAgent). Audio end-to-end with a softphone (M1.1 → M1.2c)
NOT YET RUN; pending the next session.

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

**Not yet run.** Pending next session.

### M1.2a — Echo loopback (`VERA_SIP_ECHO=1`, no Nova Sonic)

**Not yet run.** Pending next session.

### M1.2b — Nova Sonic banking happy path over the phone

**Not yet run.** Pending next session.

### M1.2c — Salud industry over SIP

**Not yet run.** Pending next session.

## Verdict

**D2 resolves toward b1, at the integration level only.**

What is settled:

- The Python lane is open. `pjsua2` and the Strands `bidi` stack live
  together in one venv on Python 3.12. There is no fundamental
  Python-side blocker to running SIP/RTP in the same process as the
  `BidiAgent`.
- The b2 trigger "pjsua2 install fight >2 h with no path forward" is
  cleared — a path forward exists. It is build-from-source, which is
  more expensive than `pip install` but is a known engineering shape.

What is NOT settled by M1.0 (must not be quoted as resolved):

- **Audio quality / latency over a real call.** All four softphone-based
  tests (M1.1, M1.2a, M1.2b, M1.2c) are still pending. The pjsua2 ↔
  asyncio bridge has been compiled and imported, not yet exercised
  with frames flowing through it. Any of the b2 triggers that depend
  on audio behaviour — dropouts buffering cannot fix, latency >5 s,
  unresolvable resample artifacts — could still fire when those tests
  run.
- **ECS host-networking RTP behaviour.** WSL2 is not a proxy for
  production network conditions.

Practical reading:

- Proceed planning M2 on the assumption that b1 is the path, **but
  hold the spike branch in place** until M1.1 → M1.2b have run and
  the verdict status above moves from "M1 partial" to "M1 complete —
  b1 confirmed for the demo target". If those tests surface a hard
  blocker, this section becomes Option B with evidence.

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
