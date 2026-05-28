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

**Status.** Active. Phase B (voice channel) will be built along Path 2.

