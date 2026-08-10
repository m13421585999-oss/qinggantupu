from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigurationError(RuntimeError):
    pass


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
    request_timeout_seconds: float

    @classmethod
    def from_environment(cls) -> "Settings":
        # A provider-neutral key takes precedence so production can use any
        # OpenAI-compatible LLM without routing through Vercel AI Gateway.
        provider_api_key = os.getenv("LLM_API_KEY", "").strip()
        gateway_api_key = os.getenv("AI_GATEWAY_API_KEY", "").strip()
        oidc_token = os.getenv("VERCEL_OIDC_TOKEN", "").strip()
        llm_api_key = provider_api_key or gateway_api_key or oidc_token
        llm_auth_source = (
            "llm_api_key"
            if provider_api_key
            else "ai_gateway_api_key"
            if gateway_api_key
            else "vercel_oidc"
            if oidc_token
            else "missing"
        )
        required = {
            "ELEVENLABS_API_KEY": os.getenv("ELEVENLABS_API_KEY", "").strip(),
            "ANALYSIS_SERVICE_TOKEN": os.getenv("ANALYSIS_SERVICE_TOKEN", "").strip(),
            "ANALYSIS_CALLBACK_TOKEN": os.getenv("ANALYSIS_CALLBACK_TOKEN", "").strip(),
            "SITES_BYPASS_TOKEN": os.getenv("SITES_BYPASS_TOKEN", "").strip(),
        }
        missing = [name for name, value in required.items() if not value]
        if not llm_api_key:
            missing.append("LLM_API_KEY, AI_GATEWAY_API_KEY, or VERCEL_OIDC_TOKEN")
        if missing:
            raise ConfigurationError(f"Missing required environment variables: {', '.join(missing)}")
        default_base_url = (
            "https://api.deepseek.com"
            if provider_api_key
            else "https://ai-gateway.vercel.sh/v1"
        )
        default_model = "deepseek-chat" if provider_api_key else "openai/gpt-5.6-sol"
        return cls(
            elevenlabs_api_key=required["ELEVENLABS_API_KEY"],
            llm_api_key=llm_api_key,
            llm_auth_source=llm_auth_source,
            analysis_service_token=required["ANALYSIS_SERVICE_TOKEN"],
            analysis_callback_token=required["ANALYSIS_CALLBACK_TOKEN"],
            sites_bypass_token=required["SITES_BYPASS_TOKEN"],
            llm_base_url=os.getenv("LLM_BASE_URL", default_base_url).rstrip("/"),
            llm_model=os.getenv("LLM_MODEL", default_model).strip(),
            request_timeout_seconds=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "180")),
        )
