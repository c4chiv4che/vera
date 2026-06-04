from strands.models.bedrock import BedrockModel

_DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-5-20250929-v1:0"


def load_model(model_id: str | None = None) -> BedrockModel:
    """Get Bedrock model client using IAM credentials.

    `model_id` defaults to the canonical Sonnet 4.5 model used by the
    banking text agent. Pass an explicit id to use a per-industry choice
    (driven by industries/{industry}/vera.yaml's `text.model_id`).
    """
    return BedrockModel(model_id=model_id or _DEFAULT_MODEL_ID)
