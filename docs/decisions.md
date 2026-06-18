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


## 2026-06 — Phase C: multi-industry kit (banking → manifest-driven loader)

**Context.** The sponsor reproducibility goal — "a future SA can `terraform apply` this kit and adapt it to their own customer" — needs the agent to be parameterised by industry, not hardcoded to banking. Phase A and B shipped a single banking agent with the prompt, tools, and voice settings inlined across `main.py` and `bidi/server.py`. Phase C lifts those into per-industry manifests on disk and routes incoming sessions to the right one based on a query-string parameter. Banking remains the only industry that ships with a manifest; the scaffolding makes adding another one a copy-edit operation.

**Architecture decisions (made up front, not revisited mid-flight).**

1. *Multi-tenant single process.* The bidi server and text agent each run as one process and instantiate the right `BidiAgent` / `StrandsAgent` on-demand per incoming session. Not one process per industry — that would multiply the operational surface (more ports to start, more env to manage) for a demo where no two industries ever run at the same time.
2. *Industry via WebSocket / HTTP query string.* `?industry=<name>`. Default at every layer (frontend, BFF, both agents) is `banking`, so existing links and the current frontend remain functional without any caller passing the parameter.
3. *Same query-string contract for the frontend URL.* `?view=user&industry=banking`; the frontend reads it once at mount and threads it down to `useVoiceSession` and into `AgentContext`'s `/chat` POST body.
4. *Tools and prompt per industry.* Each industry is `agent/app/vera/industries/<name>/` with `tools.py` (Python module exporting `@tool` callables), `prompt.txt`, and `vera.yaml` (manifest listing tool names, voice/text model IDs, thread ID prefix). One `agent_loader.load_industry(name)` reads the yaml and returns a typed `IndustryConfig`. The loader has no cache: re-reading a small yaml plus prompt on every WebSocket session is free, and lets us iterate on `prompt.txt` without restarting the server.
5. *BFF unchanged structurally.* The BFF still proxies `/chat` to the text agent and broadcasts AGUI events from the bidi server to all monitor clients. The only changes: `/chat` reads `industry` from the request body (default `banking`) and appends `?industry=` to the URL it hits on the text agent. Thread IDs in voice sessions now carry the manifest's `thread_id_prefix` (e.g. `banking-voice-<hex>`), observable in BFF logs.
6. *Monitoring views show a placeholder for non-banking industries.* The three monitoring views (`?view=flow`, `?view=logs`, `?view=admin`) render hardcoded banking-themed mocks (Phase A). For `industry != banking` they now render a shared `<IndustryPlaceholder>` body inside the same screen chrome, so the header keeps working and the user retains context of which view they're in.

**What shipped (9 commits on `phase-c/n3-multi-industry`).**

- `cc76e73` — refactor(agent): extract banking industry into `industries/banking/`
- `c61e67e` — feat(agent): bidi resolves industry from `?industry=` via manifest loader
- `16e15b3` — feat(agent): text agent resolves industry from `?industry=` via manifest loader
- `7063d7d` — feat(bff): propagate `?industry=` from `/chat` body to the text agent
- `fa8909c` — feat(frontend): propagate `?industry=` from URL to bidi WS and BFF `/chat`
- `a319cb7` — fix(frontend): drop unused destructured var in FlowScreen
- `7425d66` — fix(frontend): text fallback blocked by voice's RUN_STARTED via isRunning
- `ff4cf43` — refactor(frontend): extract AgentContext + useAgent into useAgent.js
- `8911d83` — feat(frontend): placeholder in the 3 monitoring views when industry != banking

Operational: the README now documents the 4 processes that a full demo requires (text agent :8080, bidi voice :8081, BFF :8787, frontend :5173) with their purpose. During Phase C this was easy to forget — a missing :8080 produces no UI signal, only console logs.

**Operating rule that came out of this phase (NEW, project-wide).**

No user input is silently dropped. Every guard, debounce, swallow-catch in a code path that handles a user-initiated action (submit, click, voice/audio event, WebSocket message) must `console.warn`/`console.error`/surface visibly. The minimum is a log line; a visible UI affordance is the better long-term form. Silent early-returns are forbidden in those paths.

Trigger: `7425d66` fixed a `sendMessage` early-return that silently dropped text submissions during voice sessions (the guard `if (... || isRunning) return;` was firing because voice's `RUN_STARTED` set `isRunning=true` and never reset until the user clicked "terminar llamada"). Total cost: ~1-2 hours within a single session, two false hypotheses chased (HMR stale browser, HMR stale dev server) before the right diagnosis landed. A single `console.warn` in the guard would have closed the diagnostic in minutes — the symptom was indistinguishable from "nothing happened."

**Deferred / known limitations (Phase C explicitly does NOT fix).**

Backend / agents:
- `AGUIBridge.emit` in `bidi/server.py` silently drops events if its WS to the BFF isn't connected yet (the `await asyncio.sleep(0.3)` race before `emit_run_started()`). Same silent-drop pattern as the fixed `sendMessage`; lower priority because no user-facing input is affected, but worth eliminating per the new rule.
- `DEMO_THREAD_ID = "vera-demo"` is shared across industries; the text agent's `/metrics/{thread_id}` does cross-industry lookup, so two industries hitting the BFF simultaneously would mix their token/latency counts. Single-user demo assumption inherited from Phase B, not worsened by Phase C.

Frontend UX:
- Invalid industry (`?industry=xxx`) closes the voice WS with code 4404 and a JSON error frame — the hook's `onmessage` only processes `type: "audio"` and drops the rest, then `onclose` flips state to `"ended"`; user sees "llamada finalizada" without explanation. Text equivalent: BFF returns 502, AgentContext logs ERROR silently. Same UI feedback gap.
- Text-fallback "message dropped: send in flight" now logs (per the rule), but doesn't visually disable the submit button or echo the dropped attempt. The visible UX is the proper follow-up.
- Agent-down (ECONNREFUSED on :8080) is logged on the BFF side (`broadcast({type: "ERROR", detail: ...})`) and on the browser console (AgentContext's ERROR handler), but no visible UI state changes. Originally observed as "BFF silent fail" — re-verified during Phase C: not silent, but invisible to the user.

Conversation model:
- Voice and text are separate conversations with separate memory (different thread IDs, different agent instances on the text-agent side, no shared state on the bidi side). Cross-channel continuity is future work.

Monitoring views:
- `flow/logs/admin` remain Phase A mocks. Commit `8911d83` only adds an "industry mismatch" placeholder for non-banking; it does NOT make them consume real AGUI events. Wiring them to the live broadcast is its own feature project, not Phase C cleanup.

Operational:
- Text agent (:8080) is required even for a voice-only demo because the text-fallback button is always present in `?view=user` and hits `/chat`. Documented in the README's operational table; a future cleanup could hide the button when :8080 is unreachable.

Process discipline:
- Two debugging detours in this phase, both on the same bug: chased HMR-stale-browser (false), then HMR-stale-dev-server (false), before identifying the `isRunning` guard. Both detours were ruled out by user-driven experiments rather than code analysis — the bug was in user-visible behaviour that no headless reproduction surfaced without a real browser. Wrote the silent-drop rule afterwards so the next instance of this pattern fails loud.

**Status.** Phase C closed. Branch `phase-c/n3-multi-industry` ready to merge to `main`. The original "Phase C — Telephony" (Amazon Connect integration over the existing voice agent) loses its phase number and moves to unscheduled future work; the Phase C label belongs to the multi-industry kit now.


## 2026-06 — Errata: the three monitoring views were never mocks (verified live)

**Context.** Repeated entries in this log (B2.2 verification, B2.3 +
B2.4 operational rewrite, Phase C deferred-items list) and the README's
operations sections have stated since 2026-05 that `?view=flow`,
`?view=logs`, and `?view=admin` are Phase A demo mocks that do not
consume AGUI events. "Wire the three views to live AGUI events"
appeared as a deferred backlog item in every phase since then. A live
re-verification today proves the claim is wrong; this entry exists to
record the truth and the genesis of the error. Earlier entries are
left intact for chronological honesty.

**What is actually true (re-verified 2026-06-05 in a live voice
session: DNI 31234567 → Laura Fernández → 20.000 → aprobado).**

- *FlowScreen.* Subscribes to `useAgent()`. Real tool calls light the
  `identificar` / `perfil` / `evaluar` nodes via `TOOL_BY_NODE`; the
  `bedrock` node tracks `isRunning`; edges animate when downstream
  status is `running`; node overlays render real tool result data
  (customer name from `identificar_cliente`, decision + DTI from
  `evaluar_prestamo`). The `voz` / `transcribir` / `responder` nodes
  are intentional disabled placeholders for the future Connect stage,
  not mocks. Wired during Phase A (commit `695ca1c`, 2026-05-28).

- *LogsScreen.* Subscribes to `useAgent()`. `buildLines()` walks the
  real AGUI event stream — `RUN_STARTED`, `TOOL_CALL_START`,
  `TOOL_CALL_RESULT`, `TEXT_MESSAGE_START`, `RUN_FINISHED`, `METRICS`
  — and renders structured log lines with real tool result data
  (`decision=aprobado dti=X% score=Y`). The only static element is the
  cosmetic `session a3f9c1 · region us-east-1` header label. Wired
  during Phase A (commit `d2a7ab9`, 2026-05-28; metrics rendering
  added the same day in `b0bbf4b`).

- *AdminScreen.* Hybrid by deliberate design. `useConnectMetrics()`
  builds a `real-current` contact from the live AGUI stream: customer
  name from `identificar_cliente.nombre`; state cycling
  `identifying` → `consulting` → `evaluating` → `resolved` /
  `escalated` based on the running tool and conversation lifecycle;
  channel `VOICE`. Vera appears as an agent with status driven by
  `isRunning` (`ON_CONTACT` → `AFTER_CONTACT_WORK` → `AVAILABLE`).
  The real card carries `isReal: true` and renders with a cyan border
  + "live" badge. `MOCK_HUMAN_AGENTS` and `MOCK_CONTACTS` (all
  `isReal: false`) sit around it as wallboard scenography — they make
  the view look like a populated Connect instance rather than a
  single-tile dashboard. KPI counts mix real and mock; sparklines and
  the "Resolved without human" ring are hardcoded illustrative
  numbers. Wired during Phase A (commit `c163b0d`, 2026-05-28); the
  hybrid embed pattern is the Phase A design.

**Genesis of the error.** During B2.2 verification we observed the
three views displaying static-looking content while a voice session
was open. The same B2.2 session had the audio path broken upstream —
Nova Sonic received silent samples until the user-gesture overlay was
added — so no AGUI events of consequence were flowing. The same B2.2
notes record both "three other views remain mocks from Phase A" and,
elsewhere, that the three views were not actually exercised in that
session. The "mocks" conclusion was drawn from a single observation
made during an upstream failure, reinforced by an assumption inherited
from before this project (the B2.2 entry itself calls it "a wrong
assumption carried from before the project"). The belief fossilised:
B2.4 wrote it into the README, Phase C repeated it as a deferred
item. The plumbing bugs that B2.4 fixed (translator sentence-splitting
+ METRICS spam) silently restored event flow to views that had been
wired all along; nobody re-checked.

**The backlog item is mostly already built.** "Wire FlowScreen,
LogsScreen, AdminScreen to consume real AGUI events" — listed under
deferred work in the B2.2, B2.3 + B2.4 and Phase C entries — was not
new feature work. The wiring landed in Phase A and survived every
refactor since. What remains is genuine *enhancement*, not initial
build: a visible distinction in AdminScreen between the real card and
the mock scenography (so a sponsor can tell which contact is the
live one), a useful render of the METRICS snapshot in LogsScreen,
similar polish judgment calls. Those are tracked separately, not by
this entry.

**Lesson.** Two failure modes intersected here:

1. An observation made *during* an upstream failure is not a
   verification. If the path that should feed a view is silent, the
   view will look the same whether it is wired or not. The B2.2
   conclusion should have been "view behaviour cannot be assessed
   without audio working" — instead it was promoted to a fact.

2. Beliefs inherited from one's own prior decision log are not
   self-validating. The B2.4 README rewrite and the Phase C
   deferred-items list both quoted the B2.2 conclusion without
   re-running the test. Rule going forward: before any new entry
   re-publishes a behavioural claim from an earlier entry,
   re-verify it against the current code with a real session.

The review of this very errata produced a third instance of the
pattern: a correction asserted from memory (that the AGUI translator
"doesn't emit `TOOL_CALL_RESULT`") was itself refuted by reading the
code (`agent/app/vera/bidi/server.py` line 294 emits exactly that).
The rule applies in real time to anything that touches the decision
log, including its own corrections.

**Status.** Errata recorded. README updated in the same commit to drop
the false claims and describe what the views actually do. The
deferred "wire three views" line in the B2.2 / B2.3 + B2.4 / Phase C
entries is *not* edited — the chronology is preserved, and this entry
is the authoritative correction.


## 2026-06 — Trace view: live agentic-loop graph in vista 02 (toggle next to the architecture map)

**Context.** The Phase A map in `?view=flow` is an architecture diagram
with fixed topology: identificar → bedrock → perfil/evaluar →
responder. Nodes light up as the live conversation touches them and
the tool-result overlays show real CRM data, but the shape never
changes. What it cannot show is what only exists at runtime: the
agentic loop unrolled — Bedrock appearing once per iteration, with
each Bedrock output being either a tool call or the final text
response, in the order they actually happened during this specific
call. The map answers "what services are wired"; the trace answers
"what did the model decide, step by step, this turn".

**Decision.** Add a "Mapa | Trace" pill toggle inside FlowScreen
(vista 02). Map view stays unchanged as the architecture reference.
Trace view is a ReactFlow horizontal graph built live from a new
`traceLog` array in `AgentContext`, with one node per loop step
(`Usuario → Bedrock razona → Tool → Resultado → Bedrock razona →
Respuesta`). Banking-only for now; non-banking still shows the
multi-industry placeholder and the toggle is hidden.

**Specific design choices within this decision.**

- *traceLog inside AgentContext, not a new WS subscription from the
  Trace view itself.* The AgentProvider mounts at the React root
  (`main.jsx`) and listens to the BFF WebSocket since page-load. The
  WS broadcaster has no replay — a fresh WS opened on Trace mount
  would arrive empty if the user navigates into Trace mid-call (the
  real demo case). Putting `traceLog` in AgentContext accumulates
  from the first event regardless of which view is visible. This
  also avoids a duplicated WS per session. The B alternative (Trace
  opens its own WS) was rejected for both reasons.

- *Coalesce streaming deltas into the open entry, no cap.* A naive
  raw log would push one entry per `TEXT_MESSAGE_CONTENT` delta
  (decades per assistant turn). The graph renders one node per
  message regardless of delta count, so storing each delta is
  wasted memory plus wasted recomputation in `useMemo`. The
  alternative — raw with FIFO cap — silently drops the *head* of
  the log first, which is exactly the most demo-valuable section
  (the first "Usuario pregunta → Bedrock razona"). Silent drops
  also violate the project-wide rule from Phase C (no silent
  loss of user-attributable state). Coalescing keeps growth tied
  to the unit that matters — iterations — and matches the existing
  pattern in `setMessages` for the same deltas.

- *STATE_SNAPSHOT and MESSAGES_SNAPSHOT get explicit no-op cases.*
  The text agent emits both per turn for late-joining WS clients.
  Letting them fall through to the `default` case would add two
  `'unknown'` entries to `traceLog` every text turn. An explicit
  `case STATE_SNAPSHOT: case MESSAGES_SNAPSHOT: logEvent(...)` keeps
  `events[]` byte-equivalent to pre-change (the legacy `logEvent`
  call is preserved) while skipping `pushTrace`. Documented inline
  in `AgentContext.jsx` so future readers don't conclude it was an
  oversight.

- *Run semantics differ between voice and text; the trace anchors
  on USER_MESSAGE, not RUN_STARTED.* Text emits one AGUI run per
  HTTP turn; voice emits one AGUI run per WebSocket session (many
  turns). Labeling visual blocks "Turn N" would always show "1" in
  voice and grow per POST in text — inconsistent. The session chip
  uses the first `run_started`'s threadId to label "sesión voz" vs
  "sesión texto" (text is the BFF constant `"vera-demo"`, voice is
  `banking-voice-<hex>` per the bidi manifest's `thread_id_prefix`).
  Inside the trace, the natural turn boundary is each new
  `user_message`, not `run_started`.

- *Tool nodes carry an architecture sublabel ("Lambda · DynamoDB")
  duplicated from the map's `NODES[].svc`.* The real source of
  truth for "what infrastructure each tool runs on" is the per-
  industry agent manifest in `agent/app/vera/industries/<name>/`,
  not the frontend. Surfacing that to the frontend is a separate
  decision (probably part of the agent-as-config follow-up). Three
  lines of duplication today is cheaper than premature
  centralisation; if/when the mapping is exposed by the manifest,
  the duplicated map in `traceGraphBuild.js` is replaced by a read,
  not refactored.

- *Message nodes are bare (just `Usuario` / `Respuesta`), tool and
  result nodes keep their data.* The trace is meant to be visual
  proof that the agent ran, not a transcript: the words live in the
  Conversación view. The demo value of the trace is the
  *parameters Bedrock extracted* (args JSON in the tool node) and
  the *decision the CRM returned* (decision + DTI in the result
  node) — those stay.

- *Horizontal flow, no zoom.* Vertical was the first cut and felt
  cramped given each iteration produces 2-3 stacked nodes; horizontal
  reads as "the loop unfolds left to right" and the chip stays
  legibly centered at top. ReactFlow zoom is locked at 1 (per the
  original scope "SIN zoom elaborado") and the auto-pan moves the
  viewport in X to keep the last node visible (~70% across).

**The 0-height bug we fixed mid-implementation (and the lesson).**

First runtime test of the Trace view rendered the session chip
correctly but zero nodes on the canvas. Console flooded with
"The React Flow parent container needs a width and a height to
render the graph" (223 times in one session). Root cause: the Trace
wrapper used `flex-1 relative` inside the page-root's
`min-h-screen flex flex-col`. With short sibling content (header +
reset button), the column had no surplus to distribute, so `flex-1`
resolved to 0px. ReactFlow's mount-time measurement saw a 0-height
parent and refused to render anything inside it. The chip was
visible because it's absolutely positioned with `z-10` over the
collapsed wrapper. Fix: `relative h-[74vh]`, mirroring the SVG
map's existing 74vh visual rhythm. Explicit > computed for any
child of a `min-h-screen` column with short content.

Lesson recorded: *"flex-1" only distributes when there's surplus
to distribute.* The map worked because its SVG had its own 74vh
max-height that imposed dimension regardless of flex math; the
trace's ReactFlow wrapper had no such anchor. Verification went
from "chip visible, canvas empty" to "chip visible, 11 nodes
visible, wrapper clientHeight 616px (74vh on 832px viewport),
zero React Flow height warnings" once the wrapper got an explicit
height. The bug class is the same as the original Phase C silent-
drop rule: a problem that looked silent (no nodes) was actually
loud (223 console errors that nobody had checked yet). User-side
behavioural evidence (chip visible, canvas blank) → console
inspection → root cause in two iterations.

**Open question, intentionally deferred.**

Whether the Mapa and Trace should eventually merge into a single
*combined* view — a fixed architecture strip on top showing which
tools/services are wired, with the live trace flowing below — is
recorded here as a documented candidate for the future but not
committed to. The decision to evaluate is conditional on real
demo experience: if a sponsor reading the trace also wants the
architectural context in the same glance, the combined view earns
its complexity; if they consistently want one OR the other, the
toggle stays. Today both views live side by side in vista 02
behind a toggle, both consume the same `useAgent()` context, both
are stable; no premature merge.

**Verified.** Cross-cutting verification covered both the data
path and the layout path:

- Node-side fixture test of `buildGraph` (extracted to
  `traceGraphBuild.js` so `TraceGraph.jsx` exports only React
  components, mirroring the `useAgent.js` ↔ `AgentContext.jsx`
  split): 14/14 assertions on a synthetic 6-entry traceLog (xs
  monotonic, ys constant at `NODE_Y = 200`, message subtitles
  empty, tool args + arch preserved, result DTI preserved, col
  step = 320, x_start = 40).
- Playwright against the live dev server seeded with the same
  synthetic traceLog through a `?trace-seed=demo` URL flag (stripped
  before commit per the explicit grep + diff check requirement):
  wrapper clientHeight = 616px, 11 ReactFlow nodes rendered, four
  "Bedrock razona" instances, "Resultado · derivado" present, zero
  React-Flow height warnings.
- Manual end-to-end against the real CRM (voice session with DNI
  31234567 → Laura Fernández; tested at 5.000.000 USD → derivar_a_humano
  and 20.000.000 USD → fuera_de_parametros): Mapa shows
  the same lit-node sequence as before (regression cero), Trace
  shows the unrolled loop in horizontal order, session chip reads
  "sesión voz · banking-voice-<hex>", auto-pan keeps the latest
  node visible as the conversation progresses.

**Trade-offs accepted.**

- *Horizontal row with same y for all nodes leaves a "ragged"
  bottom edge*: nodes with subtitle (tool, result) are visibly
  taller than bare nodes (Usuario, Bedrock, Respuesta). Smoothstep
  edges absorb the misalignment cleanly. Accepted for v1; if a
  real demo viewer flags it, the fix is measuring each node's
  height post-mount and snapping to a shared vertical center — not
  a layout overhaul.
- *Mapa stays alongside Trace pending demo evidence*: see the
  open question above. Operational cost is a second render path in
  vista 02 that needs to stay healthy.
- *Architecture sublabel mapping duplicated in
  `traceGraphBuild.js`*: see the design-choices entry above.
- *No persistence of traceLog across page reloads*: the log lives
  in React state; refreshing during a demo loses the history of
  that session. Same property as `messages` and `toolCalls` —
  acceptable per the original scope ("trace de la sesión actual en
  vivo. SIN persistencia, SIN export").
- *No retroactive view of pre-mount events*: a fresh page-load
  during an in-flight call sees only events from the moment
  AgentContext mounted forward — same WS-no-replay constraint that
  killed the alternative architecture. The risk is acknowledged;
  in the demo path the page is open before any call begins.

**Branch.** `feature/trace-view`, four commits:

- `2235981` — feat(frontend): traceLog in AgentContext for ordered
  agentic loop reconstruction
- `802752f` — feat(frontend): Trace toggle in FlowScreen — live
  agentic-loop graph
- `823b5e2` — fix(frontend): give TraceGraph wrapper an explicit
  height so ReactFlow renders
- `36fbb9c` — feat(frontend): polish trace — horizontal flow, bare
  messages, tool arch sublabel

**Status.** Closed. Merged to `main`.


## 2026-06 — Salud: second industry as a memory-mock, validating the Phase C kit pattern

**Context.** Phase C closed with banking as the only industry that
shipped with a manifest. The claim was that the multi-industry kit
made adding a new vertical "a copy-edit operation" — but with N=1
there was no way to know for sure. This entry covers the addition of
`salud` (healthcare) as the second vertical and what that exercise
revealed about the kit.

**Decision.** Salud ships as a memory-mock industry: three seeded
patients live in a module-level dict inside
`industries/salud/tools.py`, and `agendar_turno` appends appointments
to an in-process list that is lost on agent restart. No Terraform, no
second DynamoDB, no second API Gateway. The point of this commit was
to test the kit pattern itself, not to build a second production CRM.

**Why memory-mock over Terraform-second-CRM.**

- *Validates exactly what's being claimed.* Phase C promised the kit
  was a copy-edit operation. Standing up a second CRM would test that
  the entire stack scales to two industries, which is a different (and
  weaker) claim — the kit's value proposition would still be unproven
  if we'd also done a lot of non-kit work along the way. Memory-mock
  forces every required change to be inside `industries/salud/` or it
  shows up as a kit bug.
- *Reproducibility for the next SA.* The README and decision log
  promise the kit is adaptable to other industries. A reader copying
  banking/ as a template needs to see what the minimum viable shape
  is — a memory-mock answers "what's the smallest thing that works"
  better than another full deployment.
- *Cost and operational drag.* A second CRM doubles the Terraform
  surface, the AWS bills (small but not zero), and the steps in any
  future contributor's setup. Not worth it for a pattern test.

**The kit pattern held: no non-industry files touched.**

The salud vertical needed exactly four files, all under
`agent/app/vera/industries/salud/`: `__init__.py`, `vera.yaml`,
`prompt.txt`, `tools.py`. Zero changes to `agent_loader.py`,
`main.py`, `bidi/server.py`, the BFF, the frontend, or anywhere else.
Verified before commit by running `load_industry('salud')` and
`load_industry('banking')` back-to-back from the same Python process
— both resolve cleanly, the `_agents_by_industry` cache in `main.py`
now holds two entries (the first time this code path was exercised
in practice).

**Privacy: conscious inheritance, not duplication.**

The salud prompt explicitly names banking iter-3 as the source of
its privacy rule and reinforces it for medical data sensitivity:
"Los datos médicos son aún más sensibles que los financieros.
Aplicá el mismo patrón que en banking iter-3, reforzado por el
dominio." This is deliberate — a future reader should see this as a
considered decision (the same rule applies because the threat model
is the same: a caller claiming an identity, a tool returning data
for a real owner, the gap in between is where leaks happen). Not a
copy-paste of words but an inheritance of pattern.

**Phase C debts that become observable now that N=2.**

The Phase C decision log listed several "deferred / known
limitations" that were invisible while banking was the only
industry. Adding salud turned some of them into things a demo viewer
can see:

- *Text agent `DEMO_THREAD_ID = "vera-demo"` is shared across
  industries.* `/metrics/{thread_id}` does cross-industry lookup,
  and the conversation history threaded into the agent is keyed by
  the same string for both. **Expected, now observable:** if a user
  switches from `?industry=banking` to `?industry=salud` in the
  same text session, the salud Vera sees the banking conversation
  history. This is the Phase C debt manifesting, not a salud bug.
  Recorded here so the next session that flags it doesn't mistake
  it for new breakage.
- *PatientScreen copy is banking-themed.* "Banco · asistente con
  voz" and "Cliente" labels render for `?view=user&industry=salud`
  too. Visible mismatch with the salud agent identity. Tracked as
  copy-per-industry debt; not fixed today because the scope of
  this commit is validating the agent-side kit pattern, and the
  frontend copy-per-industry refactor is a distinct piece.
- *The three monitoring views show their non-banking placeholder.*
  This was already the expected behaviour by Phase C decision 6;
  worth restating here so the placeholder is read as
  intentional-by-design, not a salud regression. The Trace toggle
  in vista 02 is gated to banking by the same rule.

**Kit isolation, verified.**

The seeded DNI set in `industries/salud/tools.py` does not overlap
banking's (`30111222`, `25333444`, `28555666` vs banking's
`31234567`, `20111222`, etc.). Calling `identificar_paciente` with
the banking Laura DNI (`31234567`) returns "No encuentro un paciente
con ese DNI" — no leakage in either direction. Verified pre-commit
with a Python smoke against the tools.

**Trade-offs accepted.**

- `agendar_turno` appointments are lost on agent restart. Documented
  in the module docstring and the README. A real demo flow either
  starts fresh per session (which the demo does anyway) or accepts
  that follow-up "did the turno I asked for last week still exist"
  questions don't work.
- No concurrency control on `_TURNOS`. Single-user demo assumption,
  same as banking's `DEMO_THREAD_ID`. If the demo ever became
  multi-tenant, both would need work.
- `agendar_turno` doesn't model availability — it confirms the
  requested date verbatim. Realistic enough for a voice demo where
  the agent says "te confirmo el turno para el 20 de junio" without
  the conversation getting bogged down in scheduling logic.

**Branch.** `feature/industry-salud`, two commits:

- `c11b27f` — feat(agent): salud industry — memory-mock tools +
  privacy-inheriting prompt
- this commit — docs: salud industry — README + decision log entry

**Status.** Active until the manual end-to-end verification passes
(voice flow against the salud vertical, banking regression cero,
the cross-isolation probe with Laura's DNI in salud). Will be
closed after merge.


## 2026-06 — Phase D (M0): Connect telephony bridge — architecture spike

**Context.** Business mandate (exclusive priority): callers dial the
Connect PSTN number (+54, in Secrets/env — never committed) and talk
to OUR existing custom agent. A separate team is exploring Connect's
NATIVE Nova Sonic path (Lex + AMAZON.QinConnectIntent + Q in Connect);
we deliberately take the OTHER path — bridge Connect to our own agent —
to preserve the Strands/industries/AGUI/trace work from Phases A–C.

**Verified (desk research, official AWS sources).**
- Mechanism: Connect External Voice Transfer Connector transfers the
  call to a SIP URI; our SIP/RTP app server bridges audio to Nova Sonic
  over the Bedrock bidirectional API. Human escalation returns via SIP
  REFER to a Connect entry point.
- Ruled out: Connect customer media streaming (Kinesis Video Streams)
  is one-way (customer audio capture for analysis); cannot inject the
  agent's voice back into the live call.
- Deploy target: ECS (host networking) or EC2 — UDP SIP 5060 + RTP
  10000-20000 + IAM for Bedrock. NOT AgentCore. This corrects the
  earlier "B3 = deploy to AgentCore" backlog assumption.
- Official samples exist in Java (mjSIP) and JS (SIP.js), both of which
  assume the SIP gateway OWNS the Nova Sonic session.

**Open decision (D2) — the fork that determines reuse.**
Our brain is Python (Strands BidiAgent + industries + tools + AGUI).
The samples are Java/JS and own Nova Sonic. Options:
  (a) gateway owns Nova Sonic → rebuild brain in Java/JS, lose reuse.
      REJECTED unless priorities change (defeats the point of this path).
  (b1) Python SIP/RTP gateway driving Strands in-process → max reuse,
       no official sample (highest SIP/RTP risk).
  (b2) Java/JS gateway piping PCM to the Python bidi over an internal
       transport → leans on the sample, adds a cross-process audio hop.
  Leaning b1 if Python SIP/RTP proves tractable, else b2. To be
  resolved with a small code spike in M1.

**AGUI / trace preservation.** The phone-call trace and monitoring
views survive ONLY if the Python brain stays in the audio loop (ties
to D2: option (a) would require re-implementing the AGUI translator in
Java/JS). Another reason to favor b1/b2.

**Unknowns to validate hands-on (not closable by desk research).**
- Codec conversion: PSTN/Connect G.711 μ-law 8kHz vs Nova Sonic PCM
  16kHz — confirm and decide where conversion happens.
- Whether External Voice Transfer Connector is enabled/configurable
  in the account (us-east-1) against a self-hosted SIP URI.
- +54 number constraints for this transfer path.
- End-to-end latency budget.

**Cost (to estimate before standing anything up).** Recurring:
Connect number (daily) + Connect/transfer per-minute + Nova Sonic
per-minute audio + ECS running 24/7. Build-but-don't-deploy / on-demand
options to be offered before any always-on resource is created.

**Status.** M0 closed (architecture understood, path chosen at the
high level, D2 pending a code spike). No infra, no cost incurred.
Next: resolve D2 via M1 spike. Telephony bridge = Phase D.

## 2026-06 — Phase D (M1): D2 resolved toward b1 — Python lane viable, output vocalization deferred to M2

**Context.** M0 left D2 open: rebuild the brain in Java/JS to follow
the official AWS samples (a), build a Python SIP/RTP gateway driving
Strands in-process (b1, maximum reuse), or split into Java/JS gateway
+ Python brain over an internal hop (b2). M1 was a code spike on the
`spike/phase-d-sip-python` branch designed to settle D2 with evidence,
not desk research.

**D2 resolved → b1, with the precise reading below.** "b1 viable
architecturally": Python (pjsua2 + Strands BidiAgent + Nova Sonic +
industries + AGUI) handles the full SIP/RTP stack in one process. The
spike found no Python-side or wiring-side blocker that would force
b2. **This is NOT "b1 confirmed end-to-end with voice"** — no SIP
client heard Vera speak in any M1 run. Output vocalization on the SIP
leg is verified by code-level parity with the production WebSocket
path, not by frames flowing through this harness; that exercise
belongs to M2 with Connect as the SIP peer (the harness cannot
supply the user-turn-end signal a real SIP peer would). What IS
confirmed: the architecture is the right one to bet M2 on.

**Exercised end-to-end (artifacts in `docs/phase-d-m1-verdict.md`).**
- `pjsua2` + Strands `bidi` coexist in one Python 3.12 venv. b2
  trigger "pjsua2 install fight >2 h with no path forward" cleared.
  Install recipe is build-from-source — known engineering shape.
- Headless RTP: `setNullDev()` before `libStart()`, conference bridge
  runs against a null clock. This is a production requirement for
  ECS, not a WSL2 workaround.
- SIP signaling on loopback inside WSL2: INVITE → 100 → 200 OK → ACK
  → CONFIRMED (M1.1).
- RTP through `SipMediaPort` / `SipBridge`: 400 frames in, 400 out,
  Pearson 0.96 against input, ~67 ms round-trip lag (M1.2a clean
  artifact). Validates the in-memory buffer model that ECS will
  require.
- Input chain end-to-end: SIP/RTP → Nova Sonic STT (Spanish) →
  Strands → banking industry tools loaded → assistant response
  materialized as transcript text (M1.2b first run).

**Verified by code-level inspection, NOT exercised by frames.**
- Output vocalization path `SipAudioOutput.queue_outbound_pcm` →
  `_outbound` → `onFrameRequested` → RTP. Structurally identical to
  `WebSocketAudioOutput.__call__` (`server.py:374-389`), which works
  end-to-end in production on the browser leg. M1.2b never reached
  `frames_out > 0` because a unidirectional WAV harness cannot
  deliver an end-of-turn signal a real SIP peer would.

**Pending M2 (production-fidelity verification).**
- Exercise output vocalization against Amazon Connect as the SIP
  peer. Real caller VAD closes user turns naturally. Only if Connect
  ALSO fails to elicit vocalization, invest in an explicit
  end-of-turn workaround (Strands-level API or RTP-level VAD on the
  gateway). Do not preemptively build either workaround on
  harness-side evidence.
- Speech-input quality with a non-synthetic voice. espeak proved
  too robotic for digit transcription against Nova STT; switch to
  piper-tts or real-caller voice before drawing any conclusion
  about Nova STT quality.
- RTP behaviour on ECS host-networking. WSL2 is not a proxy for
  production network conditions.
- Industry switching at runtime: `load_industry()` verified industry-agnostic by inspection in M1.2b; M1.2c deferred to M2 as integration.

**Findings carried into M2 planning.**
- M1.0 install recipe is non-trivial: PyPI sdist broken, apt absent
  on Ubuntu Noble, only path is build-from-source. M2 Dockerfile is
  a multi-stage build (builder stage compiles pjproject + SWIG
  bindings, runtime stage gets the wheel) with a pinned pjproject
  version (not HEAD — the M1 build was against `2.17-dev`, a moving
  target).
- M1.1 WSL2 NAT blocker is a dev-machine artifact, not an ECS shape
  issue. ECS host networking does not have the WSL2 NAT in front of
  the container.

**Spike branch.** `spike/phase-d-sip-python` stays in place as
evidence + reference — **NOT merged into main**. The code under
`agent/app/vera/bidi/sip_*.py` plus harnesses (`compare_echo_wav.py`,
`synth_speech_wav.py`) is throwaway by design. M2 will re-derive
production gateway code against Connect-side requirements (codec
selection, NAT/STUN, observability, FD/memory ceilings, container
shape).

**Status.** D2 closed → b1. M1 closed. M2 planning starts with the
scope above. No infra, no cost incurred (the spike ran entirely on
the dev machine).

## 2026-06 — Phase D (M2 plan): Production telephony stack — infrastructure base provisioned, gateway image and stable endpoint deferred

**Context.** M1 closed with D2 resolved toward b1 (Python pjsua2 +
Strands in-process) and explicit M2 scope: exercise output
vocalization against Connect as the real SIP peer, replace the WSL2
spike code with a production gateway, and stand up the AWS
infrastructure to host it. M2 also inherited the operational blocker
identified mid-M1: the "External voice transfer connectors per
account" quota (code `L-2BE4D75F`) is at 0 in the shared account/
region. The other team's open case requests 1; a quota of ≥2 is
required so both teams can create their connectors. Coordination
to raise the desired value is in progress.

**Architecture decided (not yet exercised against a real caller).**
- Deploy target: ECS Fargate from day one. No EC2 stepping stone,
  no temporary tunnel from the dev machine. The reasoning: the
  M1.0 install recipe is non-trivial (build pjproject + SWIG from
  source); Fargate forces us to confront the production container
  shape early, instead of building twice.
- Networking: dedicated VPC (10.0.0.0/16), two public subnets in
  two AZs, Internet Gateway, no NAT Gateway. Tasks receive public
  IPs directly. The default VPC stays untouched.
- Filtering: dedicated security group for the gateway, UDP 5060
  (SIP signaling) and UDP 10000-20000 (RTP media) open from
  `var.allowed_sip_cidrs`, defaulting to `0.0.0.0/0` during
  iteration. A code-level TODO pins migration to the documented
  Chime/Connect CIDR ranges before production traffic.
- Identity: two IAM roles, both assumed by `ecs-tasks.amazonaws.com`.
  Task execution role attaches the AWS-managed
  `AmazonECSTaskExecutionRolePolicy` (ECR pull + CloudWatch logs).
  Task role carries a single inline statement:
  `bedrock:InvokeModel` scoped to the Nova Sonic model ARN
  specifically — not `*`. Verified against the AWS Bedrock
  documentation; `InvokeModelWithBidirectionalStream` requires
  this exact IAM action.
- Image registry: ECR repository with `scan_on_push=true` and a
  lifecycle policy keeping the 10 most recent images. `MUTABLE`
  during POC; production will flip to `IMMUTABLE`.
- Observability: CloudWatch log group with 7-day retention,
  wired to the task definition via the `awslogs` driver.
- State management: Terraform with S3 remote backend
  (`vera-tf-state-<account>`), native S3 lockfile
  (`use_lockfile=true`). The bootstrap (bucket + dynamo table)
  is out-of-band; everything else is IaC.

**Exercised end-to-end against AWS.**
- Full Terraform cycle on the ECS stack: init → plan → apply →
  destroy, all clean, no orphaned resources, no manual cleanup
  needed.
- A Fargate task with a placeholder image (`public.ecr.aws/nginx/
  nginx:latest`) reached `LastStatus=RUNNING` on first apply,
  received a public IP from a public subnet, and streamed its
  startup banner to CloudWatch via the `awslogs` driver. This
  proves the lifecycle ECS → ECR pull → container start → log
  group is fully wired. The placeholder is not a SIP service;
  the proof is the lifecycle, not the protocol.
- Two-stack separation under live destroy: tearing down `infra/m2/`
  left the older `infra/crm/` stack (Lambda + API Gateway +
  DynamoDB from a prior phase) untouched. Validates that the
  per-stack state isolation works.

**Verified by code-level inspection, NOT exercised yet.**
- Container image for the real gateway. Multi-stage Dockerfile
  (builder compiles pjproject + SWIG against a PINNED tag — M1's
  `2.17-dev` was a moving target, not acceptable in production)
  is designed but not built. The task definition references a
  variable `gateway_image_placeholder` precisely so the swap is
  a one-line change.
- Stable endpoint for Connect. The Fargate task's public IP
  changes on every redeploy; Connect needs a fixed target. A
  Network Load Balancer in front of the service is the planned
  shape (~$16/month idle); deferred to the next M2 commit.

**Pending M2 (production-fidelity verification).**
- Exercise output vocalization against Connect as the SIP peer
  (inherited from M1). Until the quota is raised and the
  External Voice Transfer Connector is created, this cannot
  start.
- Replace `espeak` with `piper-tts` in the gateway runtime. The
  piper validation already happened on the spike branch
  (`ece51fe` on `spike/m1.2b-piper-followup`); production
  integration is the M2 carry-over, not new research.
- RTP behavior on ECS host-networking with real PSTN traffic.

**Cost posture.** The Terraform stack incurs zero recurring cost
when destroyed (only the out-of-band S3 + DynamoDB remain, both
pennies/month). Standing it up adds: Fargate task 512 CPU/1024 MB
≈ $9/month at 24/7, NLB ≈ $16/month idle once added, Bedrock
Nova Sonic per-minute on inference, CloudWatch logs at retention.
The pattern adopted for this phase: apply → validate → destroy
within a session if there's no continuous caller traffic, so the
meter only runs during active testing.

**Blocker for protocol-level progress.** Quota `L-2BE4D75F` at 0
in the shared account. Coordination with the other team to raise
the desired value to ≥2 is the critical path. No amount of
infrastructure work moves the SIP leg forward until the connector
exists.

**Status.** Infrastructure base committed and destroy-validated
on branch `feat/m2-infra` (7 local commits, not pushed). The
stack rebuilds from `terraform apply` in ~2 minutes. NLB,
production image, and Connect-side connector remain. M2 stays
open.


## 2026-06-18 — Phase D / M2.1: gateway image lifecycle validated on Fargate

**Context.** The M2 plan above (commit `9d14983`) had the gateway
image listed under "Verified by code-level inspection, NOT exercised
yet" — the Dockerfile was designed but not built, and the task
definition pointed at the nginx placeholder. M2.1's narrow scope was
to close that gap: build the image, push it to ECR, deploy a real
gateway task on Fargate, and confirm CloudWatch sees what the local
test sees. Everything else in the M2 plan (NLB, Connect-side
connector, vocalization against a real caller, piper-tts) stays open.

**Exercised end-to-end against AWS.**
- `docker build` of the multi-stage Dockerfile against pjproject 2.17
  (pinned release, not 2.17-dev). Six iterations were needed before
  the image was valid; each iteration found a concrete root cause and
  a minimal fix, all recorded in the commit `infra/m2: fix Dockerfile`
  on this branch. The final image is 611 MB on disk / 150 MB content
  size. Reproducible from `agent/Dockerfile` + `agent/app/vera/`.
- The image runs `agent/app/vera/bidi/gateway_stub.py` — a canary
  module written for M2.1 that does the minimum to prove image
  validity: import pjsua2 (loud error + sys.exit if it fails), init
  an Endpoint with the M1-learned order (`libCreate` → `libInit` →
  `setNullDev` → `libStart` → `transportCreate`), open UDP 5060, and
  emit a heartbeat every 30s. It does NOT accept INVITEs, process
  SDP, or touch Nova Sonic. That is the next milestone, not this one.
- Local validation in Docker on WSL2: stub came up clean, pjsua2
  imported, transport created, heartbeat loop entered, SIGTERM
  handled cleanly on `docker stop`.
- ECR push: image tag `dev` pushed to the M2 repository in 1m38s.
  Verified visible in ECR with `aws ecr describe-images`.
- Task definition refactored to reference the image by Terraform
  resource (`"${aws_ecr_repository.gateway.repository_url}:${var.gateway_image_tag}"`)
  instead of a hardcoded URI. The account ID never enters the source
  tree — the placeholder variable was renamed `gateway_image_tag` and
  the URI is built at plan time from the ECR resource. Same
  disciplinary stance as `backend.hcl.local`: no AWS account
  identifiers in code or commits.
- Rolling deploy: `terraform apply` swapped the task definition from
  revision `:2` (nginx) to `:3` (the real image). ECS drained the old
  task and reached steady state in ~3 minutes. CloudWatch captured
  the gateway stub logs:

  ```
13:37:39.500 INFO [stub] vera-m2-gateway stub starting

13:37:39.789 INFO [stub] pjsua2 imported successfully

13:37:39.799 INFO [stub] pjsua2 Endpoint started (libVersion=2.17)

13:37:39.800 INFO [stub] UDP transport created on port 5060 (id=0)

13:37:39.800 INFO [stub] stub ready; entering heartbeat loop

13:38:09.800 INFO [stub] alive

13:38:39.800 INFO [stub] alive

(heartbeats continued stable for 7+ minutes until terraform destroy)
  ```

- Full lifecycle: image present in ECR → ECS pull → container start →
  pjsua2 OK → UDP 5060 listener → CloudWatch log stream → SIGTERM at
  destroy → clean shutdown. Each step is what M2.1 had to prove.

**Findings worth recording from the six build iterations.**
- `setuptools` is not bundled with `python:3.12-bookworm`; `distutils`
  is gone in 3.12. The SWIG `setup.py` needs setuptools explicitly.
- `uv sync` on the vera package requires the full source tree (not
  only `pyproject.toml` + `uv.lock`) — hatchling validates the
  `readme` field at build-editable time.
- `pyaudio` ships no Linux wheels, only sdist. The `bidi-io` extra
  on `strands-agents` pulls it as a transitive dep, so the gateway
  image carries `portaudio19-dev` (builder) + `libportaudio2`
  (runtime) even though the gateway does not use pyaudio for audio.
  This is the cost of reusing the single `vera/pyproject.toml`
  across the FastAPI agent and the gateway. Pyaudio's footprint
  in the image is small enough not to justify a separate
  pyproject — anotated as deferred.
- SWIG installs the Python C extension as `_pjsua2.cpython-312-x86_64-linux-gnu.so`
  (underscore prefix is SWIG convention). A `COPY *pjsua2*` glob in
  the runtime stage picks up the wrapper, the extension, and the
  egg-info metadata directory together.
- The uv-managed venv has an isolated `sys.path` that does NOT
  include `/usr/local/lib/python3.12/site-packages`. The C extension
  has to land inside `/app/.venv/lib/python3.12/site-packages/` to be
  importable by `python -m bidi.gateway_stub`. Order matters: the
  `COPY --from=builder /app/.venv` MUST come before the
  `COPY *pjsua2*` to the same venv path, otherwise the venv copy
  overwrites pjsua2.
- `_pjsua2.so` dynamically links six pjproject third-party libs
  (`libsrtp`, `libspeex`, `libresample`, `libwebrtc`, `libgsmcodec`,
  `libilbccodec`) that don't match the `libpj*` glob. Broadening
  the COPY to `/usr/local/lib/*.so*` captures everything pjproject
  installs without re-discovering the codec list every time
  pjproject adds one.

**NOT exercised in M2.1 (carries over to M2.2+).**
- No SIP INVITE was answered. The stub binds UDP 5060 but has no
  account and no call handler; any INVITE would get auto-404. That
  is intentional for the canary; the production gateway handler
  comes later.
- No NLB. The Fargate task's public IP is ephemeral, so the current
  setup cannot be addressed by Connect (which needs a stable
  endpoint). NLB shape is documented in the M2 plan and remains the
  next architectural piece.
- No vocalization against a real SIP caller. Still blocked on quota
  `L-2BE4D75F` plus the Connect connector creation that quota
  unlocks.
- No piper-tts in the gateway runtime. `espeak`-vs-piper is
  unchanged from the M2 plan.

**Cost posture.** Active session cost: ~0.05 USD (Fargate task at
512 CPU / 1024 MB running roughly 25 minutes across two deploys,
plus a single `docker push` data transfer). Post-destroy steady
state: zero recurring cost — the ECR repo was deleted with
`force_delete=true` (the `dev` image is gone with it; reproducible
from source in ~4 minutes with a warm cache). Out-of-band S3 +
DynamoDB for Terraform state remain at pennies/month.

**Status.** M2.1 closed. The gateway image and the lifecycle around
it now move from "Verified by inspection" to "Exercised end-to-end."
The rest of the M2 plan above stays open exactly as written; M2.1
narrows the surface area for the next milestone but does not
collapse it.
