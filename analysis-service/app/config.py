from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigurationError(RuntimeError):
    pass


DEEPSEEK_PROVIDER = "deepseek"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-pro"
DEEPSEEK_THINKING = "enabled"
DEEPSEEK_REASONING_EFFORTS = frozenset({"low", "high", "max"})


def configured_model() -> str:
    return os.getenv("LLM_MODEL", DEEPSEEK_DEFAULT_MODEL).strip() or DEEPSEEK_DEFAULT_MODEL


def configured_reasoning_effort() -> str:
    effort = os.getenv("LLM_REASONING_EFFORT", "high").strip().lower()
    if effort not in DEEPSEEK_REASONING_EFFORTS:
        allowed = ", ".join(sorted(DEEPSEEK_REASONING_EFFORTS))
        raise ConfigurationError(
            f"LLM_REASONING_EFFORT must be one of: {allowed}"
        )
    return effort


@dataclass(frozen=True)
class Settings:
    elevenlabs_api_key: str
    llm_api_key: str
    llm_auth_source: str
    analysis_service_token: str
    analysis_callback_token: str
    sites_bypass_token: str
    llm_base_url: str
    llm_model: str
    llm_thinking: str
    llm_reasoning_effort: str
    request_timeout_seconds: float

    @classmethod
    def from_environment(cls) -> "Settings":
        required = {
            "ELEVENLABS_API_KEY": os.getenv("ELEVENLABS_API_KEY", "").strip(),
            "LLM_API_KEY": os.getenv("LLM_API_KEY", "").strip(),
            "ANALYSIS_SERVICE_TOKEN": os.getenv("ANALYSIS_SERVICE_TOKEN", "").strip(),
            "ANALYSIS_CALLBACK_TOKEN": os.getenv("ANALYSIS_CALLBACK_TOKEN", "").strip(),
            "SITES_BYPASS_TOKEN": os.getenv("SITES_BYPASS_TOKEN", "").strip(),
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise ConfigurationError(f"Missing required environment variables: {', '.join(missing)}")
        return cls(
            elevenlabs_api_key=required["ELEVENLABS_API_KEY"],
            llm_api_key=required["LLM_API_KEY"],
            llm_auth_source="llm_api_key",
            analysis_service_token=required["ANALYSIS_SERVICE_TOKEN"],
            analysis_callback_token=required["ANALYSIS_CALLBACK_TOKEN"],
            sites_bypass_token=required["SITES_BYPASS_TOKEN"],
            llm_base_url=DEEPSEEK_BASE_URL,
            llm_model=configured_model(),
            llm_thinking=DEEPSEEK_THINKING,
            llm_reasoning_effort=configured_reasoning_effort(),
            request_timeout_seconds=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "180")),
        )
