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

**Status.** Active. B1 begins next. All Phase B work happens on the `phase-b/nova-sonic` branch; `main` stays at the verified end of Phase A until Phase B is verified and ready to merge.


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
