# Vera

**V**oice-**E**nabled **R**eceptionist **A**ssistant.

A reproducible reference implementation of a generative-AI conversational
agent on AWS, designed as a customer-service receptionist. The project
is built in incremental phases: text channel first, voice channel next,
telephony last — each phase end-to-end and verifiable on its own.

The first vertical implemented is consumer banking (personal loan
intake). The same scaffolding is intended to be adaptable to other
industries (healthcare, education) by replacing the CRM tools and the
system prompt.

## Project status

Phase A — Text channel. Complete. A Strands agent with three live tools
calling a real CRM (DynamoDB + Lambda + API Gateway, deployed via
Terraform). A Node BFF that broadcasts agent events to a React frontend
with four synchronized live views (user chat, flow visualization,
structured logs, Connect-style admin wallboard). End-to-end token usage,
latency, and tool-call traces are surfaced in the UI.

Phase B — Voice channel. In progress. Currently on sub-stage B1.a:
real-time voice conversation between the browser and Amazon Nova Sonic
(via Strands' experimental `BidiAgent`), over a WebSocket. Audio is
captured in the browser using the Web Audio API and streamed as 16 kHz
PCM16 to a FastAPI server that holds a bidirectional streaming session
with Nova Sonic. The CRM tools from Phase A are not yet wired to the
voice agent — that is B1.b onwards.

Phase C — Telephony. Planned. Integration with Amazon Connect to expose
Vera over a real phone number.

Architecture decisions, considered trade-offs and discarded approaches
are recorded in [`docs/decisions.md`](docs/decisions.md). That file is
the canonical reference for *why* each choice was made.

## Phase A behavior

Vera handles personal-loan intake calls. The flow:

1. The customer states their request (e.g. identifying themselves by
   DNI and requesting an amount).
2. Vera calls `identificar_cliente` to validate identity against the CRM.
3. Vera calls `consultar_perfil_crediticio` to retrieve credit score
   and current debt-to-income ratio.
4. Vera calls `evaluar_prestamo`, which applies real industry criteria
   (DTI ≤ 36%, credit score ≥ 670) and returns one of three decisions:
   `aprobado`, `derivar_a_humano`, or `fuera_de_parametros`.
5. Vera communicates the decision in Rioplatense Spanish with tone
   appropriate to the outcome.

The agent never computes financial logic itself — it relies entirely on
the tools. All three tools are real `@tool`-decorated functions backed
by live HTTP calls to API Gateway.

## Architecture

Phase A (text channel) is a three-tier stack:

~~~
Browser (React + Vite)
        │
        │ HTTP / SSE
        ▼
BFF (Node + Express)  ◀── broadcasts agent events to all connected views
        │
        │ AG-UI protocol
        ▼
Agent (Python + Strands)
        │
        │ @tool calls via HTTPS (API-key auth)
        ▼
CRM (API Gateway → Lambda → DynamoDB)
        │
        └── deployed via Terraform
~~~

The BFF exists so that multiple UI views (user, flow, logs, admin) can
observe the same conversation in real time. The agent emits events
through the AG-UI protocol, the BFF fans them out, and each view
subscribes to the slice it needs.

Phase B (voice channel) replaces the front-end chat path with a
WebSocket carrying audio:

~~~
Browser (Web Audio API: mic capture + playback)
        │
        │ WebSocket (PCM16 base64, 16 kHz in / 24 kHz out)
        ▼
Bidi server (FastAPI)
        │
        │ Strands BidiAgent (experimental)
        ▼
Nova Sonic v1 on Amazon Bedrock
        │
        │ (planned, B1.b+: same @tool calls as Phase A)
        ▼
CRM (unchanged)
~~~

The Phase B server runs locally for now. Deploying it to Bedrock
AgentCore Runtime is a later sub-stage.

## Components

- `frontend/` — React + Vite + Tailwind v4. Four views (`?view=user`,
  `?view=flow`, `?view=logs`, `?view=admin`) sharing a live event stream
  from the BFF. The admin view mirrors the shape of Amazon Connect's
  real-time metrics API.

- `bff/` — Node + Express. Receives AG-UI events from the agent and
  broadcasts them to subscribed front-end clients. No business logic,
  pure fan-out.

- `agent/app/vera/` — Python + Strands. The text-channel agent (Phase A,
  `main.py`) and the voice-channel server (Phase B, `bidi/server.py`).
  Three tools: `identificar_cliente`, `consultar_perfil_crediticio`,
  `evaluar_prestamo`. All read CRM data via authenticated HTTPS calls
  to API Gateway.

- `infra/` — Terraform for the CRM. DynamoDB table seeded with three
  demo clients, Lambda handler in Python, REST API Gateway with API-key
  auth, least-privilege IAM. Single command to apply, single command to
  destroy.

- `docs/decisions.md` — Decision log. Each entry records what was
  decided, why, what trade-offs were considered, and what was rejected.
  This is the file to read first if you want to understand the project's
  reasoning rather than its code.

## Stack

| Layer            | Technology                                                       |
|------------------|------------------------------------------------------------------|
| Frontend         | React 18, Vite, Tailwind v4                                      |
| BFF              | Node.js, Express, AG-UI protocol                                 |
| Text agent       | Python 3.12, Strands Agents SDK, Anthropic Claude (via Bedrock)  |
| Voice agent      | Python 3.12, Strands BidiAgent (experimental), Amazon Nova Sonic |
| CRM              | AWS Lambda (Python), API Gateway (REST), DynamoDB                |
| Infrastructure   | Terraform 1.15+                                                  |
| AWS region       | `us-east-1`                                                      |

## Prerequisites

Local development:

- Node.js 20+ and npm
- Python 3.12+ and [`uv`](https://docs.astral.sh/uv/)
- Terraform 1.15+
- AWS CLI v2, configured with a named profile that has permissions to
  deploy Lambda, API Gateway, DynamoDB, IAM, and to invoke Bedrock
  (`bedrock:InvokeModelWithBidirectionalStream` is required for Phase B)
- For Phase B on Linux: `apt install portaudio19-dev` before
  `uv sync`, otherwise PyAudio fails to compile

Bedrock model access (one-time, free):

- `amazon.nova-sonic-v1:0` enabled in Bedrock → Model access (Phase B)
- The Claude model used by Phase A enabled likewise

## Running Phase A

Phase A consists of three processes running locally, plus the CRM
deployed in your AWS account.

Deploy the CRM:

~~~
cd infra
terraform init
terraform apply -var="aws_profile=YOUR_PROFILE"
~~~

Terraform prints the API endpoint and the API key. Copy them into
`agent/app/vera/.env`:

~~~
CRM_ENDPOINT=<output from terraform>
CRM_API_KEY=<output from terraform>
AWS_PROFILE=YOUR_PROFILE
~~~

Run the agent, BFF, and frontend in three terminals:

~~~
# Terminal 1 — agent
cd agent/app/vera
uv sync
uv run main.py

# Terminal 2 — BFF
cd bff
npm install
npm start

# Terminal 3 — frontend
cd frontend
npm install
npm run dev
~~~

Open `http://localhost:5173/vera-pitch/?view=user` to talk to Vera.
Switch the query string to `?view=flow`, `?view=logs`, or `?view=admin`
to see the same conversation from different perspectives.

## Running Phase B (sub-stage B1.a)

Phase B reuses the same Python environment as Phase A. Make sure
`portaudio19-dev` is installed on the host before `uv sync` (Linux).

~~~
cd agent/app/vera
uv sync
cd bidi
python server.py
~~~

Open `http://localhost:8081` in a browser. Use headphones to avoid
echo. Click "iniciar conversación" and speak to Vera. The agent has
no CRM tools wired in B1.a — it acknowledges that it is in test mode
when asked about banking operations. Tool wiring lands in B1.b.

## Cost estimate

Running the demo end-to-end in `us-east-1` with the default Terraform
configuration costs only a few cents per session in raw AWS usage
(Lambda invocations, DynamoDB on-demand reads, API Gateway requests,
Bedrock tokens, Nova Sonic streaming). The fixed monthly cost while
the CRM is deployed but idle is negligible — DynamoDB on-demand bills
per request, Lambda bills per invocation, API Gateway bills per
request. There are no always-on resources.

To stop billing entirely, destroy the stack:

~~~
cd infra
terraform destroy -var="aws_profile=YOUR_PROFILE"
~~~

Bedrock and Nova Sonic billing stops as soon as you stop invoking the
models — there is no provisioned capacity.

## Repository layout

~~~
vera/
├── README.md           — this file
├── LICENSE             — MIT
├── docs/
│   └── decisions.md    — architecture decision log
├── frontend/           — React + Vite frontend (Phase A)
├── bff/                — Node BFF (Phase A)
├── agent/app/vera/     — Python agent
│   ├── main.py         — text-channel agent (Phase A)
│   └── bidi/           — voice-channel server (Phase B)
└── infra/              — Terraform for the CRM
~~~

## License

MIT. See [`LICENSE`](LICENSE).
