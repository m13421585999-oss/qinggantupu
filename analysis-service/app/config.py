from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigurationError(RuntimeError):
    pass


DEEPSEEK_PROVIDER = "deepseek"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-pro"
DEEPSEEK_THINKING = "enabled"
OPENAI_COMPATIBLE_PROVIDER = "openai_compatible"
OPENAI_COMPATIBLE_BASE_URL = "https://api2.65535.space"
OPENAI_COMPATIBLE_DEFAULT_MODEL = "gpt-5.6-sol"
DEFAULT_LLM_PROVIDER = OPENAI_COMPATIBLE_PROVIDER
SUPPORTED_LLM_PROVIDERS = frozenset(
    {DEEPSEEK_PROVIDER, OPENAI_COMPATIBLE_PROVIDER}
)
LLM_REASONING_EFFORTS = frozenset(
    {"minimal", "low", "medium", "high", "xhigh", "max"}
)
# Compatibility alias for callers/tests written before the generic provider.
DEEPSEEK_REASONING_EFFORTS = LLM_REASONING_EFFORTS
DEFAULT_IMAGE_PROVIDER = OPENAI_COMPATIBLE_PROVIDER
DEFAULT_IMAGE_MODEL = "image2.0"
SUPPORTED_IMAGE_PROVIDERS = frozenset({OPENAI_COMPATIBLE_PROVIDER})


def configured_provider() -> str:
    provider = os.getenv("LLM_PROVIDER", DEFAULT_LLM_PROVIDER).strip().lower()
    provider = provider.replace("-", "_")
    if provider not in SUPPORTED_LLM_PROVIDERS:
        allowed = ", ".join(sorted(SUPPORTED_LLM_PROVIDERS))
        raise ConfigurationError(f"LLM_PROVIDER must be one of: {allowed}")
    return provider


def configured_base_url(provider: str | None = None) -> str:
    provider = provider or configured_provider()
    # AI_BASE_URL / AI_API_KEY are the canonical cross-provider names. The
    # legacy LLM_* names remain accepted so the DeepSeek rollback needs only an
    # environment switch, not a code deployment.
    configured = (
        os.getenv("AI_BASE_URL", "").strip()
        or os.getenv("LLM_BASE_URL", "").strip()
    )
    if configured:
        return configured.rstrip("/")
    if provider == DEEPSEEK_PROVIDER:
        return DEEPSEEK_BASE_URL
    return OPENAI_COMPATIBLE_BASE_URL


def configured_model(provider: str | None = None) -> str:
    resolved_provider = provider or configured_provider()
    model = os.getenv("LLM_MODEL", "").strip()
    if model:
        # Production previously pinned the DeepSeek default in LLM_MODEL. Once
        # the provider has been migrated, do not let that stale cross-provider
        # value silently route the OpenAI-compatible adapter back to DeepSeek.
        # Explicit DeepSeek rollback remains available through
        # LLM_PROVIDER=deepseek, where the same model value is preserved.
        if (
            resolved_provider == OPENAI_COMPATIBLE_PROVIDER
            and model == DEEPSEEK_DEFAULT_MODEL
        ):
            return OPENAI_COMPATIBLE_DEFAULT_MODEL
        return model
    if resolved_provider == DEEPSEEK_PROVIDER:
        return DEEPSEEK_DEFAULT_MODEL
    return OPENAI_COMPATIBLE_DEFAULT_MODEL


def configured_visual_model() -> str:
    # Both interpretation flows use the same deployed model. Their prompts and
    # schemas stay independent in their respective modules.
    return configured_model()


def configured_reasoning_effort() -> str:
    effort = os.getenv("LLM_REASONING_EFFORT", "high").strip().lower()
    if effort not in LLM_REASONING_EFFORTS:
        allowed = ", ".join(sorted(LLM_REASONING_EFFORTS))
        raise ConfigurationError(
            f"LLM_REASONING_EFFORT must be one of: {allowed}"
        )
    return effort


def configured_image_provider() -> str:
    provider = os.getenv("IMAGE_PROVIDER", DEFAULT_IMAGE_PROVIDER).strip().lower()
    provider = provider.replace("-", "_")
    if provider not in SUPPORTED_IMAGE_PROVIDERS:
        allowed = ", ".join(sorted(SUPPORTED_IMAGE_PROVIDERS))
        raise ConfigurationError(f"IMAGE_PROVIDER must be one of: {allowed}")
    return provider


def configured_image_model() -> str:
    return os.getenv("IMAGE_MODEL", DEFAULT_IMAGE_MODEL).strip() or DEFAULT_IMAGE_MODEL


def configured_image_ocr_model(provider: str | None = None) -> str:
    return os.getenv("IMAGE_OCR_MODEL", "").strip() or configured_model(provider)


@dataclass(frozen=True)
class Settings:
    elevenlabs_api_key: str
    llm_api_key: str
    llm_auth_source: str
    llm_provider: str
    analysis_service_token: str
    analysis_callback_token: str
    sites_bypass_token: str
    llm_base_url: str
    llm_model: str
    llm_thinking: str
    llm_reasoning_effort: str
    request_timeout_seconds: float
    image_provider: str = DEFAULT_IMAGE_PROVIDER
    image_model: str = DEFAULT_IMAGE_MODEL
    image_ocr_model: str = ""

    @classmethod
    def from_environment(cls) -> "Settings":
        ai_api_key = os.getenv("AI_API_KEY", "").strip()
        legacy_llm_api_key = os.getenv("LLM_API_KEY", "").strip()
        llm_api_key = ai_api_key or legacy_llm_api_key
        required = {
            "ELEVENLABS_API_KEY": os.getenv("ELEVENLABS_API_KEY", "").strip(),
            "ANALYSIS_SERVICE_TOKEN": os.getenv("ANALYSIS_SERVICE_TOKEN", "").strip(),
            "ANALYSIS_CALLBACK_TOKEN": os.getenv("ANALYSIS_CALLBACK_TOKEN", "").strip(),
            "SITES_BYPASS_TOKEN": os.getenv("SITES_BYPASS_TOKEN", "").strip(),
        }
        missing = [name for name, value in required.items() if not value]
        if not llm_api_key:
            missing.append("AI_API_KEY (or legacy LLM_API_KEY)")
        if missing:
            raise ConfigurationError(f"Missing required environment variables: {', '.join(missing)}")
        provider = configured_provider()
        return cls(
            elevenlabs_api_key=required["ELEVENLABS_API_KEY"],
            llm_api_key=llm_api_key,
            llm_auth_source="ai_api_key" if ai_api_key else "llm_api_key_legacy",
            llm_provider=provider,
            analysis_service_token=required["ANALYSIS_SERVICE_TOKEN"],
            analysis_callback_token=required["ANALYSIS_CALLBACK_TOKEN"],
            sites_bypass_token=required["SITES_BYPASS_TOKEN"],
            llm_base_url=configured_base_url(provider),
            llm_model=configured_model(provider),
            llm_thinking=DEEPSEEK_THINKING,
            llm_reasoning_effort=configured_reasoning_effort(),
            request_timeout_seconds=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "180")),
            image_provider=configured_image_provider(),
            image_model=configured_image_model(),
            image_ocr_model=configured_image_ocr_model(provider),
        )
