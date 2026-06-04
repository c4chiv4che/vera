"""
Industry manifest loader (Phase C commit 2).

Reads industries/{industry}/vera.yaml and returns a typed config the
voice agent (bidi/server.py) and text agent (main.py — wired in commit 3)
use to instantiate themselves.

The loader has no cache: each call rereads the yaml and the prompt file.
That keeps prompt iteration fast during local dev (no server restart
needed) and is cheap (small files, called once per session). If this
matters when we move to AgentCore Runtime (B3), cache there.
"""
from __future__ import annotations

import importlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import yaml

_INDUSTRIES_DIR = Path(__file__).parent / "industries"


@dataclass(frozen=True)
class IndustryConfig:
    name: str
    industry: str
    prompt: str
    tools: list[Callable[..., Any]]
    voice: dict[str, Any]
    text_model_id: str
    thread_id_prefix: str


def available_industries() -> list[str]:
    """Names of industries that have a vera.yaml manifest on disk."""
    if not _INDUSTRIES_DIR.is_dir():
        return []
    return sorted(
        p.name for p in _INDUSTRIES_DIR.iterdir()
        if p.is_dir() and not p.name.startswith("_") and (p / "vera.yaml").is_file()
    )


def load_industry(industry: str) -> IndustryConfig:
    """Resolve an industry name to a typed IndustryConfig.

    Raises ValueError with an actionable message on:
      - unknown industry (directory missing)
      - missing vera.yaml
      - missing prompt_file
      - declared tool name not exported by industries.{industry}.tools
    """
    industry_dir = _INDUSTRIES_DIR / industry
    if not industry_dir.is_dir():
        raise ValueError(
            f"Unknown industry '{industry}'. Available: {available_industries()}"
        )

    manifest_path = industry_dir / "vera.yaml"
    if not manifest_path.is_file():
        raise ValueError(f"Industry '{industry}' has no vera.yaml manifest")

    manifest = yaml.safe_load(manifest_path.read_text())

    prompt_file = manifest.get("prompt_file")
    if not prompt_file:
        raise ValueError(f"Industry '{industry}' manifest is missing 'prompt_file'")
    prompt_path = industry_dir / prompt_file
    if not prompt_path.is_file():
        raise ValueError(
            f"Prompt file '{prompt_file}' not found for industry '{industry}' "
            f"(looked at {prompt_path})"
        )
    prompt = prompt_path.read_text()

    tools_module = importlib.import_module(f"industries.{industry}.tools")
    tool_names = manifest.get("tools") or []
    tools: list[Callable[..., Any]] = []
    for tool_name in tool_names:
        if not hasattr(tools_module, tool_name):
            raise ValueError(
                f"Industry '{industry}' declares tool '{tool_name}' but it is "
                f"not exported by industries.{industry}.tools"
            )
        tools.append(getattr(tools_module, tool_name))

    voice = manifest.get("voice") or {}
    text = manifest.get("text") or {}

    return IndustryConfig(
        name=manifest.get("name", industry),
        industry=manifest.get("industry", industry),
        prompt=prompt,
        tools=tools,
        voice=voice,
        text_model_id=text.get("model_id", ""),
        thread_id_prefix=manifest.get("thread_id_prefix", industry),
    )
