# Vera

Reproducible demo kit for a voice-enabled conversational AI agent on AWS,
built for Solutions Architects. One engine, multiple industry configurations
(starting with FSI / banking).

## Structure

- `frontend/` — React UI (4 screens: patient view, orchestration, logs, admin)
- `agent/` — Strands / Bedrock AgentCore agent exposing AG-UI events
- `infra/` — Terraform for supporting AWS resources (CRM: Lambda + DynamoDB + API Gateway)

## Status

Work in progress. Setup instructions will be completed once the kit is feature-complete.
