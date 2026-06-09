# Phase D / M1 spike — operator notes

Throwaway runbook for `spike/phase-d-sip-python`. NOT a production
runbook. If this branch ever merges, these notes go away or move into
proper documentation.

The decision this spike is meant to settle is in
`docs/phase-d-m1-verdict.md`. Fill that file in as you test.

## Test progression (do these in order)

| stage  | env                | what it proves                                      | needs Nova Sonic? |
| ------ | ------------------ | --------------------------------------------------- | ----------------- |
| M1.1   | (default)          | SIP signaling + RTP path end-to-end                 | no                |
| M1.2a  | `VERA_SIP_ECHO=1`  | full audio loop incl. pjsua2↔asyncio threading      | no                |
| M1.2b  | (default, banking) | BidiAgent over the phone with banking tools         | YES               |
| M1.2c  | `VERA_SIP_INDUSTRY=salud` | cross-industry validation through SIP        | YES               |

For M1.1 you should hear silence (no audio path back yet from sip_spike,
just the signaling answering with 200 OK and the bidirectional media
established). The success signal is: the softphone shows the call as
connected and `dev-spike-sip.sh logs` shows `audio path up` with a small
t_invite→media latency.

For M1.2a (echo), you should hear your own voice back at near-zero
latency. If you hear yourself but heavily distorted or with big gaps,
that's a finding about the pjsua2↔asyncio bridge — write it in the
verdict.

For M1.2b, dial in, wait for Vera to greet, then run the banking
happy path (DNI 31234567 dictated digit-by-digit, loan 20.000 USD,
goodbye). Tool calls and the trace view should populate just like on
the WebSocket path.

## Spike server setup (one-time)

```bash
# from repo root
./dev-spike-sip.sh setup
```

This creates a fresh venv at `tmp/spike-sip-venv` and installs `pjsua2`
+ the main agent deps. `pjsua2` is the risk: there's no first-party
PyPI wheel for every Linux. The setup script tries `pip install pjsua2`
first. If that fails:

**Fallback A — apt package (Ubuntu / WSL2):**

```bash
sudo apt update
sudo apt install -y libpjproject-dev python3-pjsua2 swig
# Recreate the venv with system site-packages so it can find apt's pjsua2:
rm -rf tmp/spike-sip-venv
python3 -m venv --system-site-packages tmp/spike-sip-venv
./dev-spike-sip.sh setup   # will skip recreating, just install agent deps
```

**Fallback B — build pjproject + bindings from source:**

```bash
sudo apt install -y build-essential swig libssl-dev libasound2-dev
git clone https://github.com/pjsip/pjproject.git ~/src/pjproject
cd ~/src/pjproject
./configure --enable-shared && make dep && make && sudo make install
cd pjsip-apps/src/swig
make python
cd python
# Activate the spike venv, then:
"$SPIKE_VENV/bin/python" setup.py install
```

If neither fallback works in <2 hours of fight, **stop and document that
as the b2 trigger** — the spike's job is to surface this kind of friction.

## Running the spike

```bash
# Foreground (you watch logs live, Ctrl-C to stop):
./dev-spike-sip.sh foreground

# Or background + tail:
./dev.sh start bff           # the spike emits AGUI events to the BFF on :8787
./dev-spike-sip.sh start
./dev-spike-sip.sh logs

# Echo mode (M1.2a, no Nova Sonic, no AWS bill):
VERA_SIP_ECHO=1 ./dev-spike-sip.sh start

# Salud industry (M1.2c):
VERA_SIP_INDUSTRY=salud ./dev-spike-sip.sh restart
```

Stop with `./dev-spike-sip.sh stop`. The script SIGTERMs, waits 5 s,
then SIGKILLs.

The spike binds UDP 5060 by default. If something else is on 5060 (or
your softphone wants 5060 itself), set `VERA_SIP_PORT=15060` (or any
free UDP port) and point the softphone at that.

## Softphone choice and install

You need a SIP softphone that can call a SIP URI on an arbitrary host
and port. Both options below are free.

### Option 1 — Linphone on Windows (recommended for WSL2 host)

1. Download Linphone Desktop (Windows installer) from linphone.org.
2. Install. On first launch it asks you to create / log in to an
   account — **skip / use without account** ("Use Linphone without an
   account"). We don't need a SIP registrar.
3. Settings → Audio: check that your default mic and speakers are
   selected. Use headphones to avoid echo with the open-mic spike.
4. Settings → Network: under "Transport" make sure UDP is enabled and
   pick a local port that isn't 5060 (e.g. 5070). Save.
5. To call: type `sip:vera@<WSL2_IP>:5060` in the search bar and hit
   the green call button. Find the WSL2 IP with `hostname -I` from
   inside WSL2 (the first address).

### Option 2 — Zoiper (Windows or Linux)

1. Download Zoiper 5 (Free) from zoiper.com. Skip the trial pitches.
2. On first launch: "Create an account" → choose "I already have an
   account" → leave it empty / cancel; we want the URI-call path, not
   account login.
3. In the dial field, type `sip:vera@<WSL2_IP>:5060` and call.
4. Audio settings: pick the right mic, prefer "Wide band" off (we
   negotiate G.711 at 8 kHz; if Zoiper insists on Opus the call still
   connects but pjsua2 will transcode and the audio path looks weird).

### Option 3 — Linphone inside WSL2 (only if WSLg is set up)

If your WSL2 has GUI support (WSLg), you can install Linphone in WSL2
and dial `sip:vera@127.0.0.1:5060` (loopback). Audio capture inside
WSL2 needs WSLg's PulseAudio bridge; if you don't already have that
working for other apps, **don't try to make it work for the spike** —
use Option 1 instead.

## Finding the WSL2 IP

From WSL2 (Ubuntu) terminal:

```bash
hostname -I | awk '{print $1}'
```

Use that address in the softphone URI. The address can change between
WSL2 restarts — re-check before each test session.

## Networking gotchas on WSL2

- The softphone in Windows sends RTP to the IP advertised by the
  server in SDP. pjsua2 picks the local interface's IP, which inside
  WSL2 is the virtual NIC's address — the SAME address Windows reaches
  WSL2 on. So this should "just work" without port forwarding.
- If you see SIP connect but no audio: it's almost certainly RTP UDP
  not reaching back. Check Windows Defender Firewall isn't blocking
  Linphone/Zoiper from receiving UDP on its random RTP port. Either
  allow the app once when prompted, or run a `nc -u -l <port>` on the
  Windows side to confirm packets arrive.
- Verdict caveat: WSL2's UDP timing under load can differ from native
  Linux on ECS host-networking. A "viable" verdict in WSL2 is NOT
  proof of production viability — write that in the verdict file.

## Verifying the spike outside of placing calls

The asyncio + audio code can be smoke-imported without pjsua2:

```bash
"$SPIKE_VENV/bin/python" -c "import sip_audio" \
  # works once pjsua2 is installed
```

If you want to skip the pjsua2 dep entirely and just test the resample
math, run `python3 -c "import audioop; ..." `. The resample uses stdlib
`audioop.ratecv` which is in core Python.

## What success looks like

- M1.1: softphone says "connected", spike log shows `audio path up`
  within ~200 ms of INVITE. No need to hear anything.
- M1.2a: in echo mode you hear yourself back. If quality is "phone-
  call-bad" that's expected (8 kHz). If quality is "robot underwater"
  → resample or threading bridge is broken; that's a finding.
- M1.2b: dial → silence for ~1 s → Vera says her greeting →
  conversation proceeds with `identificar_cliente` and
  `evaluar_prestamo` firing. The `?view=flow&trace=on` page populates
  with the call's trace identical to a browser session. Latency is
  subjective; aim for "less than ~1.5 s from end-of-your-sentence to
  start-of-Vera's-response". Anything over 3 s is a problem and a
  potential b2 signal.

## When to stop and call it b2

The plan defined these triggers — copy/paste decisions into the
verdict file as they happen:

- pjsua2 install fight >2 h and no path forward.
- Echo loop (M1.2a) has audible dropouts that buffering doesn't fix.
- M1.2b latency >5 s end-to-end on first response (not attributable
  to resample alone).
- SIP INVITE handshake fails with a standard softphone for non-trivial
  config reasons.

In all cases, the verdict explains the WHAT and the WHY — not "it
didn't work".
