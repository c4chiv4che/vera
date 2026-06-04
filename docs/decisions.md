# Decision Log

Architectural and strategic decisions for the Vera project. Each entry records
what was decided, what alternatives were considered, and why one was chosen.
The goal is to make it easy for someone joining the project later (or our
future selves) to understand *why* things are the way they are, not just *what*
they are.

## 2026-05 — Voice channel: Connect as transport, Strands stays the brain

**Context.** We need to add a voice channel to Vera. Today the agent runs as
a Strands/AgentCore service with its own tool-calling loop against the real
CRM. The frontend talks to it through a BFF; the agent screen, flow, logs and
admin views all consume its events live.

**Options considered.**

- **Path 2 — Connect as voice channel, Strands stays the brain.**
  Connect handles telephony, transcription (Transcribe/Nova Sonic), and
  speech synthesis (Polly/Nova Sonic). A Lambda bridges Connect to the
  existing Strands agent: it forwards transcripts in, streams responses out.
  The agent, its tools, the CRM, the BFF and all four views remain
  unchanged.

- **Path 3 — Connect AI agents (native, with MCP).**
  Announced at re:Invent 2025. The agent lives *inside* Connect: Nova Sonic
  handles voice natively, tools are exposed via an MCP server that Connect
  consumes. Native interruption handling, no glue code for the audio
  pipeline.

- **Hybrid — External Voice Transfer over SIP.**
  Connect receives the call and SIP-transfers it to an externally hosted
  voice bot. Mostly used for third-party bots (PolyAI, etc.); building one
  ourselves around Strands would be non-idiomatic and complex.

**Decision: Path 2.**

**Why.**

- **Strategic constraint on MCP.** Project sponsors have an explicit
  preference against MCP-based architectures. Path 3's value proposition
  hinges on MCP for tool integration; without MCP it loses most of its
  advantage.
- **AgentCore / open-source as a strategic requirement.** Sponsorship and
  funding for the project are tied to using AgentCore and the open-source
  agent stack. Path 3 would mean retiring Strands/AgentCore as the brain.
- **Sunk work preserved.** Phase A built a real Strands agent with real
  tools against a real CRM, with real token metrics flowing end to end.
  Path 2 keeps all of that intact; Path 3 would require re-platforming the
  brain onto Connect AI agents.
- **Reproducibility of the kit.** The project's goal is a reproducible kit
  another SA can deploy with `terraform apply`. Path 2 is closer to a
  generic pattern (any external agent + Connect for voice) than Path 3,
  which couples the kit to Connect's specific agentic stack.

**Trade-offs accepted.**

- We have to build the audio bridge ourselves (KVS or Connect's streaming
  APIs into a Lambda that talks to the agent, then back to Polly/Nova
  Sonic). More moving parts than Path 3.
- We don't get Nova Sonic's voice quality for free; we have to wire it
  (or Polly) explicitly.
- If the strategic constraints change later (sponsor accepts MCP, or
  funding shifts away from open-source agent), Path 3 becomes the better
  technical option and a future migration may be considered. This entry
  exists so that decision is informed.

**Status.** Superseded by the 2026-05 entry below. The Path 2 plan was abandoned after deeper research revealed Nova Sonic exists as a standalone bidirectional streaming API with native function calling, and that AWS published an official reference architecture combining Nova Sonic, Strands, and AgentCore for exactly our use case (voice banking).



## 2026-05 — Voice channel: adopt AWS's reference architecture (Strands BidiAgent on AgentCore Runtime + Nova Sonic)

**Context.** After committing to Path 2 (Connect + Lex bridge to a text Strands agent), research revealed that Nova Sonic exists as a standalone bidirectional streaming API on Bedrock with native function calling. Initial reaction was to use Nova Sonic standalone with Strands removed from the voice path. Further research surfaced that AWS published, in October-December 2025, an official multi-agent voice banking reference architecture that uses all three pieces our sponsor requires: Nova Sonic (voice), Strands BidiAgent (orchestration), AgentCore Runtime (host). The reference is in `awslabs/agentcore-samples`. This invalidates the "find AgentCore a role" framing of the earlier replanning: AgentCore Runtime is the official host for bidi voice agents, not a checkbox.

**Decision.** Adopt the AWS reference architecture as-is from day one, refactoring whatever in the current Phase A code does not fit. No "build first, integrate later" — the official pattern is the target from the start.

The target architecture:
Browser (microphone + speaker, WebSocket client)
↕ WebSocket (bidirectional audio + control events)
AgentCore Runtime (hosts the Strands BidiAgent)
↕ Strands BidiAgent orchestrates
Nova Sonic v1 model on Bedrock (speech-to-speech + function calling)
↕ tool calls
Our existing CRM (Lambda + API Gateway + DynamoDB from Phase A)

The other three frontend views (flow, logs, admin) continue to react to the live conversation via a broadcast service (the current BFF or its successor, to be decided when we get to that piece).

**Why this plan.**

- **Demo quality is non-negotiable.** A voice demo with 5s latency and robotic voice is not credible to AWS Solutions Architects.
- **The pattern is endorsed by AWS for the exact use case.** The reference multi-agent banking sample uses Nova Sonic + Strands + AgentCore for a voice banking assistant. Following the documented recipe instead of inventing architecture.
- **Every sponsor-required piece has a genuine role.** AgentCore is the runtime host (not decoration). Strands is the agent framework. Nova Sonic is the voice. Each serves a real function.
- **Phase A investment is mostly preserved.** The CRM and tool logic carry forward unchanged. The three Strands `@tool` definitions are reusable inside a `BidiAgent`. The user view in the frontend is rewritten (text → voice) but the other three views keep their structure.

**Specific design choices within this decision.**

- **Use Strands `@tool` directly, not MCP Gateway.** The reference sample uses MCP Gateway to expose tools. Strands supports defining tools directly with `@tool` decorators (as we already do). We use the direct path. This avoids the MCP component (which the sponsor opposes) without losing functionality.
- **Use Nova Sonic v1, not Nova 2 Sonic.** v1 has been GA since April 2025 with more samples and reported usage. v2 (Dec 2025) looks better on paper but has less production material. Migration to v2 is a model ID swap.
- **Use the `lupe` voice (Spanish, feminine, es-US locale).** Nova Sonic's Spanish is es-US (neutral Hispanic), not rioplatense. Compromise accepted: rioplatense content (system prompt with "vos", "plata") with neutral-Hispanic voice. No regional Spanish variants in Nova Sonic's announced roadmap.
- **Browser microphone via Web Audio API, not PyAudio.** AWS's own production guidance says PyAudio is sample-only and browsers provide built-in echo cancellation. Critical for demo quality with open speakers.
- **Region: us-east-1.** Nova Sonic available, demo account already there.

**Known risks and gotchas.**

- **Function calling is ~85% reliable in Nova Sonic v1.** Reports describe the model sometimes gathering tool parameters and then saying "I'll do that" without emitting the toolUse event. Mitigation: `toolChoice: "any"` at critical moments, strict schema validation, design the demo flow tolerant to retry. v2 claims improvement here.
- **WebRTC and reconnection logic is the time sink.** Production reports describe spending more time on connection lifecycle and edge cases than on AI. Budgeted explicitly.
- **Echo cancellation with open speakers.** PyAudio samples require headsets. Browser-based audio handles it natively via Web Audio API `echoCancellation` constraint. Mitigation confirmed.
- **Spanish is not rioplatense.** Documented above.
- **AgentCore Runtime deployment is new territory.** Phase A agent ran with `uv run` locally. Phase B requires actual deploy. Docker is required and currently NOT installed on the dev machine.

**What gets refactored from Phase A.**

- **Preserved unchanged:** CRM infrastructure (Terraform, Lambda, DynamoDB, API Gateway), `@tool` definitions, business logic (DTI, loan decisions), four-view structure of the frontend.
- **Rewritten:** the user view (text chat → voice interface with microphone/audio playback), the agent class (`StrandsAgent` text → `BidiAgent` with `BidiNovaSonicModel` voice), the BFF role (HTTP-AGUI proxy → broadcast service for the other views, or removed if AgentCore Runtime's streaming serves the other views directly).
- **Added:** `BidiAgent` configuration, WebSocket client in the frontend, AgentCore Runtime deploy, browser audio capture/playback.

**Phase B sub-stages.**

- **B1.** Strands BidiAgent working locally with Nova Sonic using a simple Python client (no browser). Verify tools fire, voice quality is acceptable, function calling works for FSI cases. Riskiest part; done first.
- **B2.** Move from local Python client to browser-based microphone via WebSocket. The frontend `?view=user` rewritten as voice interface.
- **B3.** Deploy the Strands BidiAgent to AgentCore Runtime. Until this point we run locally.
- **B4.** Re-integrate the other three views (flow, logs, admin) to the new event stream. BFF question gets answered here.
- **B5.** Add Connect on top so a real phone call can reach the same agent. Add-on once B1–B4 work.

**Status.** Active. The original plan was to keep all Phase B work on a long-lived `phase-b/nova-sonic` branch and merge to `main` only when Phase B was fully verified. In practice we merged each B1 sub-stage (B1.a, B1.b) to `main` as it completed, using short-lived feature branches. The change happened because B1 was more exploratory than expected and the long-lived branch created friction without protecting `main` from anything meaningful. The decision to merge incrementally is now the working pattern for Phase B.


## 2026-05 — B1.b: real CRM tools wired into the voice agent, with prompt-engineered guardrails for identity verification

**Context.** B1.a verified the WebSocket plumbing: Strands `BidiAgent` running locally over Nova Sonic v1, audio in both directions through the browser, no tools. B1.b's job was to wire the three Phase A `@tool` functions (`identificar_cliente`, `consultar_perfil_crediticio`, `evaluar_prestamo`) into the same `BidiAgent` and verify function calling works end-to-end over voice with a realistic banking conversation.

The technical wiring was the small part. The bulk of B1.b turned out to be prompt engineering for voice: getting the agent to behave correctly when speech recognition is imperfect, when users dictate numbers in ambiguous ways, and — most importantly — when the conversation surfaces edge cases that have privacy implications in a banking context.

**Decision.** Ship B1.b with three guardrails baked into the system prompt, plus one explicit privacy rule with no-leak wording. Specifically:

1. **DNI confirmation step.** Before calling `identificar_cliente`, the agent must read the dictated DNI back digit-by-digit and ask the customer to confirm. Calling the tool with a misheard DNI is worse than asking once.
2. **No assumption of intent at greeting.** The agent greets and asks what the customer needs, instead of assuming the call is about a loan. Voice demos default to loans because the FSI sample skews that way; the prompt corrects for it.
3. **Identity cross-check.** When the tool returns a name that does not match what the customer said, the agent does not silently accept the tool's name as ground truth.
4. **Privacy-preserving mismatch handling (the critical rule).** When the cross-check fails, the agent must NOT reveal whose name the DNI actually belongs to. The exact wording is "No puedo verificar tu identidad con esos datos. ¿Podés revisarlos y pasármelos de nuevo?" and, under pressure, "Por privacidad no puedo darte información sobre datos que no son tuyos." No confirmation of the real owner's name, no hints, even when the user explicitly states the mismatched name in conversation.

**Why this set of rules.**

- The first three rules came from observed failures in B1.b iteration 1 testing: tool calls firing on misheard DNIs, the agent jumping to loan flow before the customer asked, and the agent calling the customer "Laura" without ever having been told the customer was Laura (just because the tool returned that name).
- The fourth rule (privacy) came from a live test in iteration 2 where the tester said "soy Pedro" and gave a DNI belonging to Laura Fernández in the seeded CRM. The agent detected the mismatch (rule 3 working) but communicated it by saying verbatim "el DNI que me diste corresponde a Laura Fernández" — leaking another customer's full name to a user who failed identity verification. In a real bank this would be a reportable privacy incident. The tester's reaction at the time — "estás filtrando información de otros clientes" — was correct and was what drove iteration 3.

**How iteration 3 was verified.** A single live session combining the happy path and three adversarial probes:

- Diego flow (happy): customer states DNI 20111222, agent confirms, tool returns "Diego Sosa", agent proceeds as Diego. Correct.
- Retroactive name mismatch: same session, customer then says "yo no soy Diego, soy Pedro". Agent responded with the privacy-preserving wording, did not reference "Diego Sosa". Correct.
- DNI 31234567 belonging to Laura, customer claims to be Pedro: agent processed the tool result and used the name "Laura" returned by the tool, because by that point in the long session the agent had lost track of the earlier "soy Pedro" claim. Correct as a privacy outcome (no leak of an unrelated customer's data), but reveals a separate identity-tracking gap documented below.
- Direct probes for information: "¿recordás cuál era mi nombre cuando empezamos la llamada?" and "yo me llamo Pedro y me aprobaste un DNI de Laura". The agent held the privacy line in both cases, refusing to confirm or repeat any name from the session and replying with the privacy wording.

**Trade-offs accepted.**

- The privacy rule is intentionally over-broad. The agent now refuses to discuss names of "other customers" even when those names were just provided by the customer themselves in the same turn. Conservative behaviour preferred over leakage. Sharpening this is on the B1.c list.
- DNI dictation reliability stays around ~75% on first attempt with Nova Sonic v1's Spanish ASR for naturally-spoken Argentine number forms ("veintitrés, cuarenta y cinco"). Improves to near-100% when the customer dictates digit-by-digit. The confirmation step (rule 1) catches the failures; no model change needed.
- The agent loses track of the user-stated name across long sessions with multiple failed identifications. Documented as a known gap, not blocking B1.b.

**Known issues deferred to B1.c.**

- *Identity persistence across turns.* The agent should remember the name the customer stated at the start of the call and cross-check it against every subsequent tool result, not just the first. Today this is implicit in the prompt; needs to be explicit.
- *Hallucinated bank processes.* When asked questions outside the tools' scope ("¿cómo me transfieren la plata?"), the agent invents plausible-sounding answers about account registration and transfers. Should redirect to "un analista te va a contactar para esos detalles" instead.
- *Invented DNIs when none is given.* When the customer is vague about their DNI, the agent occasionally fabricates one to call the tool with, rather than re-asking. Observed once in iteration 1, did not recur in iteration 3, but the prompt rule against invention should be strengthened.

**Status.** B1.b verified and closed. The iter-3 prompt lives in `agent/app/vera/bidi/server.py` on `main`. B1 milestones (B1.a, B1.b) were merged to `main` as they completed rather than accumulating on a long-lived phase-b branch; this is a deviation from the original Phase B plan, accepted because the work is exploratory and the branch was getting in the way more than it helped. B1.c is queued as the first prompt-engineering pass to start after B2, unless we choose to refine the prompt before exposing it through the real frontend.


## 2026-05 — B2.1: bidi server bridged to BFF via AGUI events for the monitoring views

**Context.** Phase A built a four-view frontend (user, flow, logs, admin) where all views subscribe to AGUI events broadcast by the BFF. B1 added a bidi voice agent on its own WebSocket server (`:8081`), but that server emitted Strands `BidiAgent` events directly to its log without going to the BFF, so the flow/logs/admin views had no visibility into voice sessions. B2.1's job was to fix that: have the bidi server forward voice-conversation meta-events (transcripts, tool calls, metrics, run lifecycle) to the BFF, translated into AGUI format, so the other three views work during voice sessions without their code being touched.

**Decision.** Implement a one-way bridge inside `bidi/server.py`: every time a Strands `BidiAgent` emits a non-audio event, translate it on the fly to an AGUI event and publish it to the BFF over a WebSocket client connection to a new `/agent-events` endpoint. The BFF rebroadcasts to all connected monitors. Audio frames never travel through the BFF — they stay on the short browser↔bidi path, preserving voice latency.

**Architecture.** Two parallel channels from the bidi server's perspective. Audio path: `browser ↔ /ws on bidi ↔ Nova Sonic`, low latency, never touches the BFF. Meta-event path: `bidi server → BFF /agent-events → BFF broadcaster → monitor WS clients`. The four frontend views all subscribe to the BFF broadcaster (no change). The user view in B2.2 will additionally open its own WS to the bidi server for the audio path.

**Why this pattern (and not the alternatives).**

- *Bidi-as-producer-to-BFF, frontend-direct-to-bidi-for-audio (chosen).* Audio stays on the short path. Other views need zero code changes. BFF keeps being the broadcaster it already is.
- *BFF proxies audio too.* Rejected. Doubles the audio hop for no functional gain. AWS's own Nova Sonic reference architectures (sample-nova-sonic-websocket-agentcore, agentcore-samples) show clients connecting directly to the bidi-hosting layer, never through an audio proxy. Adding a hop is estimated +100-300ms perceived latency on a model with sub-1s S2S budget.
- *Frontend opens two WS (one to bidi, one to BFF).* Acceptable for the user view (which already needs both), but using it for all four views means rewriting all four. Rejected as default for that reason.

**Run modeling.** One AGUI run per voice session (not per turn). `RUN_STARTED` is emitted when the WebSocket session opens; `RUN_FINISHED` when it closes. User and assistant messages stream as `USER_MESSAGE` / `TEXT_MESSAGE_*` events inside that run. This differs from the Phase A text agent which emits one run per HTTP request, but matches the conversational nature of a voice call ("a customer is talking to Vera" = one run).

**Resilience.** The bridge to the BFF reconnects in the background with exponential backoff (0.5s → 5s cap). If the BFF is unavailable or restarts mid-session, the bridge drops events that occur while disconnected and reconnects when it can. The voice session is never blocked or slowed by bridge issues — translator emits are non-blocking and silently noop when not connected.

**Trade-offs accepted.**

- *Audio path bypasses the BFF.* Means the BFF cannot observe or shape the audio stream. For the demo this is the right call (audio doesn't need observation, latency does); if we later need server-side recording or moderation, that would require revisiting.
- *METRICS are emitted per Nova Sonic usage event, ~85 times per session.* Not de-duplicated yet. The frontend stores them in a single state slot (last-wins), so functionally fine, but it's bandwidth waste. Listed below.
- *AGUI events are constructed as raw JSON dicts in the translator, not via the `ag-ui-protocol` Python SDK.* The frontend already consumes raw JSON of that shape (it doesn't use any SDK either), so adding the SDK in the middle adds an abstraction with no payoff at this layer. The decision can be revisited if AGUI evolves and we need versioning support.
- *Bridge target URL `ws://localhost:8787/agent-events` is hardcoded.* OK for local dev. Becomes an env var when we deploy.

**How B2.1 was verified.** Three terminals + browser, one complete banking conversation in voice (greeting → identify customer with DNI 31234567 dictated digit-by-digit → confirm → request 20.000 → loan approved → goodbye). The monitor terminal received the full AGUI event stream including: `RUN_STARTED`, three `USER_MESSAGE`, four `TEXT_MESSAGE_START/CONTENT/END` cycles, two complete tool-call cycles (`TOOL_CALL_START/ARGS/END/RESULT` for `identificar_cliente` and `evaluar_prestamo`), many `METRICS`, and `RUN_FINISHED` at close. Tool arguments and results arrived structured correctly. The CRM-side happy path verified end-to-end through voice with all events visible to the broadcaster.

**Bugs discovered, deferred to B2.4.**

- *Assistant message splitting.* Nova Sonic emits `is_final=true` on `BidiTranscriptStreamEvent` per-sentence, not per-turn. The translator currently treats every `is_final=true` as end-of-message, so a long assistant response of N sentences generates N separate `TEXT_MESSAGE_*` bracketed groups, often with content repeated across them. The frontend will render these as N separate Vera bubbles. Needs heuristic to coalesce: probably "consider the assistant message done after K ms of silence" or "until the next tool call or user input arrives." Will be visible once B2.2 renders bubbles; easier to tune visually than blind.
- *METRICS event spam.* ~85 emissions per ~90 second session, one per Strands usage tick. The frontend's `setMetrics` accepts last-wins, so visually only the final value matters, but the bandwidth and event-log noise are wasteful. Easy fix: only emit on assistant turn end. Deferred to B2.4 because the fix interacts with the message-splitting fix above.
- *Bridge reconnection-during-session not yet exercised.* The reconnect-with-backoff logic compiled and runs at session start, but we did not actively kill and restart the BFF mid-session to verify the drop-and-resume behavior. Functional risk is low (the logic is straightforward), but the decision log notes it as not-empirically-verified. Will be exercised when B2.4's cleanup pass happens.

**Status.** B2.1 closed. Bridge + translator working end-to-end; all four frontend view types will be able to consume voice events through the same channel they already use. PatientScreen voice integration (B2.2) is next.


## 2026-05 — B2.2: PatientScreen rewritten for voice with browser audio capture

**Context.** B2.1 wired the bidi voice server to broadcast AGUI events to the BFF, so the four frontend views could in principle react to a voice conversation. But the user-facing view (PatientScreen) was still the Phase A text input — voice was only accessible through the standalone HTML at `localhost:8081/`. B2.2's job was to replace PatientScreen so that visiting `?view=user` opens a real voice session backed by Nova Sonic, while the conversation events keep flowing to the other three monitoring views through the existing AGUI broadcaster.

**Architecture.** A new custom hook `useVoiceSession({ url })` owns the audio path: `getUserMedia` → `AudioContext(16kHz)` → `ScriptProcessorNode(4096)` → Float32→Int16 PCM → base64 → WebSocket to the bidi at `:8081/ws`. Playback decodes incoming PCM16 @ 24kHz with a `playbackTime` accumulator for seamless chunk playback. PatientScreen consumes the hook for transport, the existing `AgentContext` for conversation state (messages, vera mood, tool calls), and the existing `VoiceOrb` for the visual. The conversation history is reactively populated by the AGUI events that B2.1 already routes through the BFF, so no state plumbing was added.

**Why a hook and not inline.** Audio capture/playback is testable in isolation, PatientScreen stays readable, and if a future view needs voice (e.g. an agent supervisor view), the hook is reusable. Audio plumbing in the component would have meant ~250 lines of refs, useEffect, and async lifecycle mixed with UI markup.

**Audio implementation: ScriptProcessorNode over AudioWorklet.** ScriptProcessorNode is deprecated per the Web Audio spec but works in all current browsers and is exactly what the standalone HTML uses. Choosing it meant porting working code verbatim instead of designing a new AudioWorklet processor (which requires a separate worklet file and more scaffolding). The deprecation notice is logged in the console but does not block audio. Documented as a future-work item if voice fluidity becomes an issue.

**Two hard bugs hunted and fixed during B2.2.**

1. *React StrictMode double-mount.* React 18+ in dev mode mounts → cleans up → mounts every effect. The first version of the hook treated cleanup as terminal: it set `endedRef.current = true`, which made the second mount short-circuit immediately, so the WebSocket was never opened. Confirmed by interleaved console logs showing `[voice] cleanup running` followed by no `[voice] hook starting`. Fixed by (a) resetting `endedRef.current = false` at the start of every effect run, (b) only setting `cancelled = true` on cleanup (not `endedRef`), (c) closing in-flight WebSockets cleanly when cancelled before they reach `onopen`. The hook is now safe to mount-unmount-mount within a single second.

2. *User-gesture requirement for working audio capture.* Even after `audioCtx.state === 'running'`, the `ScriptProcessorNode.onaudioprocess` produces silent samples until the page has received a user gesture. The hook initially auto-started in `useEffect`, with no gesture in scope; Nova Sonic kept receiving audio frames but they were inaudible silence, leading to `ValidationException: Timed out waiting for input events`. Verified by side-by-side comparison: the standalone HTML works on first try because its entire flow is wrapped in a button `onclick`; the React version with auto-start failed identically every time. Fixed by adding a "Tocá para hablar con Vera" full-screen overlay button that wraps the first user gesture; on tap, `setStarted(true)` triggers the hook with `autoStart: true`. The hook's `autoStart` default was flipped to `false` to make this requirement explicit at the call site.

**UX decisions, recorded.**

- *Tap-to-start overlay over auto-start.* The user originally asked for "as soon as the view loads, ask for the mic and stay listening — like a real call." The gesture requirement makes auto-start impossible without sounding like a regression. The compromise was an overlay that covers the whole screen (any tap counts as the gesture), preserving the "no specific button" feel without lying about browser constraints.
- *"Terminar llamada" button always visible while live.* No auto-detect of end-of-call. Honors the user's framing: a call ends when the human says so.
- *Text fallback always visible as a small button.* Discoverable for accessibility/mic-failure cases.
- *Conversation history persists after "terminar".* Closing the audio session does not reset the messages. The "↺ limpiar conversación" button (which surfaces only after end/error) explicitly resets.

**Honest caveats.**

- *Fluidity is marginally worse than the standalone HTML.* In side-by-side A/B testing, the standalone HTML felt more natural and Vera's responses started a beat sooner. The React version is usable but feels slightly more robotic and slightly more latent. Hypothesis: the React frontend loads TensorFlow.js, Three.js, ReactFlow, and Motion concurrently, competing with ScriptProcessorNode for main-thread time. AudioWorklet (deferred) may help by moving audio processing off the main thread. Recorded as a quality gap not a blocker — usable for sponsor demos with the caveat acknowledged.
- *Three other views (flow, logs, admin) remain mocks from Phase A.* During B2.2 verification we observed they show hardcoded data (`bedrock.session.end`, `calls_resolved=1`, `Agents online: 5`) that does not react to the AGUI events the BFF is now broadcasting. The B2.1 bridge works — events do reach the BFF — but the views don't consume them. This was a wrong assumption carried from before the project: they were always demo mocks, not reactive views. Connecting them to AGUI events is genuinely new work, not a fix. Listed below.
- *Assistant message duplication still visible.* The B2.1-documented `is_final`-per-sentence splitting bug renders Vera's longer answers as duplicated message bubbles in the user view. Confirmed visually during B2.2 testing. Deferred to B2.4 along with METRICS spam.
- *Bug pre-existing in App.jsx line 219 (now ~234).* `useState` called after a conditional return, flagged by ESLint with `react-hooks/rules-of-hooks`. Predates B2.2; left in place to avoid scope creep. Deferred to B2.4.

**Verification.** Multiple end-to-end conversations through the React UI: greeting, customer identification with DNI 31234567 (Laura Fernández) dictated digit-by-digit, loan request for 20.000 USD, approval, goodbye. Tool calls (`identificar_cliente`, `evaluar_prestamo`) fired correctly, results were spoken back to the user, conversation bubbles populated reactively from the AGUI broadcast. Privacy fix from B1.b iter-3 still holds: DNI mismatch produces "no puedo verificar tu identidad" without leaking the rightful owner. `■ terminar llamada` cleanly tears down the audio session and leaves the history visible.

**Status.** B2.2 closed. PatientScreen integrated end-to-end with voice. Three monitoring views remain mocks and are recorded as separate work (not part of B2). Next planned hito is B2.3 (banking copy rewrite) or B2.4 (cleanup + the deferred bugs above), to be decided next session.

**Deferred to later phases.**
- B2.3: rewrite the health-themed copy ("Centro de salud", "paciente", "Martín") to banking-themed copy.
- B2.4 cleanup: fix the bidi message-splitting and METRICS spam (B2.1), fix App.jsx line 234 useState-conditional, delete the standalone HTML at `bidi/index.html` (replaced by PatientScreen), mark or remove the BFF's `/chat` SSE handler if no longer used, write a README operational section documenting which venv to activate per terminal.
- B2.x (future): wire FlowScreen, LogsScreen, AdminScreen to actually consume AGUI events instead of showing mock data. This is new feature work, not cleanup.
- Reading B (post-B2): agent-as-config refactor to support multi-industry kits.
- B3: deploy to AgentCore Runtime.


## 2026-05 — B2.3 + B2.4: copy alignment and Phase B cleanup

**Context.** B2.2 closed with PatientScreen integrated end-to-end as a voice interface, but with several known caveats explicitly tracked in the decision log: health-themed copy left over from Phase A, the standalone HTML at `bidi/index.html` already superseded, a pre-existing react-hooks/rules-of-hooks violation in `App.jsx`, the AGUI translator's assistant-message-splitting + duplication bug, and the METRICS spam. This entry covers the closure of all five items as a single rebrand-and-cleanup pass.

**B2.3 — copy alignment.** The Phase A frontend was a health-clinic demo ("Centro de salud", "Vista del paciente", "Pacientes, estado y ánimo", customer labelled "Martín") but the agent it now drives is a bank. Five strings in `App.jsx` were changed to align: home subtitle to "Banco · asistente con voz", the tagline verb "Agendá" (clinical appointment vibe) to "Consultá, pedí", paciente → cliente in the screen title and admin description, and the chat bubble owner label "Martín" → "Cliente" (generic; the real customer name, when known, is announced by Vera through the AGUI stream after `identificar_cliente`).

**B2.4 — cleanup, four pieces.**

*Removed the standalone HTML* at `agent/app/vera/bidi/index.html` plus its `@app.get("/")` handler in `server.py` plus the now-unused `FileResponse` import. PatientScreen is the user-facing voice UI now; the standalone page had been kept for B1.a/B1.b debugging and was no longer reachable from the documented paths. The bidi server now only exposes `@app.websocket("/ws")`.

*Fixed the React rules-of-hooks violation* in `App.jsx`. The `useState('home')` was declared after a conditional early return for monitor-mode views (`?view=user` etc.), violating the "hooks must run in the same order on every render" rule. ESLint had been flagging this since before B2; fix was mechanical (move the `useState` above the early return). Behaviour identical, ESLint now clean.

*Updated README operations sections* to match reality. Two false claims were closed: Phase A's closing sentence ("Switch the query string to ?view=flow, ?view=logs, or ?view=admin to see the same conversation from different perspectives") was true for the original Phase A text demo but became aspirational once we discovered in B2.2 that those three views are static demo mocks that never consumed AGUI events. Phase B's section was still titled "sub-stage B1.a" and described running the just-removed standalone HTML. Both sections were rewritten with explicit caveats (mock dashboards, fluidity gap vs HTML, message-coalescing limitations) so a future contributor reading the README does not have to discover those caveats by getting confused, as we did.

*Fixed the AGUI translator's message-splitting + METRICS spam* — the more substantial change in B2.4, deserving its own explanation. The decision log entry for B2.1 described the splitting bug as "Nova Sonic emits is_final=true per-sentence, the translator treats every is_final as end-of-message, so N sentences become N bubbles." This was correct as far as it went, but capturing fresh logs before writing the fix revealed a second factor: Nova Sonic also emits each sentence TWICE, once with `is_final=False` and once with `is_final=True`, and both copies carry the FULL sentence text in `delta.text` and `text` — they are not incremental deltas. The original translator emitted both copies and reset on every True, producing each sentence twice inside its own bubble AND one bubble per sentence. The fix ignores `is_final=False`, treats each `is_final=True` as "append this sentence to whatever assistant message is currently open", and only closes the assistant message on an actual actor change (USER_MESSAGE, tool call, tool result, or session end). For METRICS, the ~100 `BidiUsageEvent` per session that were each producing a METRICS broadcast were collapsed into a snapshot held in the translator, flushed once per turn-end and at session end (~3-5 per session in practice).

**Honest lessons we wrote down for ourselves.**

- *The B2.1 decision log entry was correct in spirit but incomplete in detail.* The "per-sentence is_final" observation was right, but it missed the duplication-within-sentence factor because no one had grepped a real log of a multi-sentence turn at the time. The B2.4 fix only landed cleanly because we captured logs first and read them before coding. The original B2.1 entry now reads as a partial diagnosis that B2.4 completes; left in place for chronological honesty rather than rewritten.
- *We almost shipped a fix based on the partial diagnosis.* During B2.4.4 the first answer to "implement the fix" was "yes, based on hypotheses." We caught it ourselves before coding and chose to capture logs first. Worth recording: the cost of 15 minutes of empirical verification is small compared to the cost of a fix that introduces a worse bug.
- *Branching discipline slipped briefly.* A single `.gitignore` change was committed directly to `main` instead of on a branch. It went through a lightweight cleanup (reset + cherry-pick + interactive rebase) once the inconsistency was noticed. The repo log ends up clean; the lesson stays.

**Verification.** End-to-end voice conversation against the CRM happy path: greet, identify Laura (DNI 31234567), loan request 20.000 USD, approval with multi-sentence answer, goodbye. The approval response, previously split into 2-3 bubbles with duplicated text, now renders as a single bubble with the joined sentences and no internal duplication. BidiTranscriptStreamEvent count in the bidi log was 7 over the whole session (versus the 16-event pattern from before, when each sentence was double-counted by the translator). BidiUsageEvent count from Nova Sonic was 70; METRICS broadcasts to the BFF dropped from the previous ~85 per session to the per-turn-end cadence by construction.

**Status.** Phase B sub-stages B2.3 and B2.4 closed. The remaining B2-era backlog items now sit in clearly demarcated tracks: 1) wiring the three monitoring views to live AGUI events is its own future feature project, not Phase B cleanup; 2) the React voice-fluidity gap vs the standalone HTML is recorded as a quality observation with AudioWorklet as a hypothetical future mitigation; 3) the agent-as-config refactor (the "lectura B") is the natural next step toward the README's multi-industry kit claim. Phase B as originally scoped is complete.

**Deferred to later phases (unchanged from B2.2 with one addition).**
- Wire FlowScreen / LogsScreen / AdminScreen to consume real AGUI events (new feature, not cleanup).
- Investigate AudioWorklet to close the fluidity gap against the standalone HTML.
- Agent-as-config refactor for multi-industry reproducibility.
- B3: deploy to AgentCore Runtime (requires Docker on the dev host).
