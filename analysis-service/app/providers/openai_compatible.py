from __future__ import annotations

import json
import re
from copy import deepcopy
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import DEEPSEEK_PROVIDER, OPENAI_COMPATIBLE_PROVIDER


class StructuredLlmError(RuntimeError):
    """Provider failure for one structured-output LLM request."""


class StructuredPayloadError(StructuredLlmError):
    """A successful provider response that did not contain valid schema data."""


@dataclass(frozen=True)
class StructuredGenerationResult:
    data: dict[str, Any]
    endpoint: str
    output_mode: str
    request_count: int


def _endpoint(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def _openai_endpoint(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    versioned = base if base.lower().endswith("/v1") else f"{base}/v1"
    return f"{versioned}/{path.lstrip('/')}"


def _safe_detail(response: httpx.Response, api_key: str) -> str:
    detail = response.text.strip()[:800] or "empty provider response"
    if api_key:
        detail = detail.replace(api_key, "[redacted]")
    detail = re.sub(
        r"(?i)(bearer\s+)[^\s\"',}]+", r"\1[redacted]", detail
    )
    return re.sub(
        r"(?i)((?:api[_-]?key|authorization)\s*[=:]\s*)[^\s\"',}]+",
        r"\1[redacted]",
        detail,
    )


def _strict_output_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Return an OpenAI Structured Outputs compatible copy.

    Pydantic represents nullable fields with defaults as optional object
    properties. OpenAI strict mode requires every declared property to appear
    in ``required`` (nullable properties can still explicitly be ``null``).
    Keep the application Pydantic models unchanged and normalize only the
    provider-facing schema.
    """

    normalized = deepcopy(schema)

    def visit(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if not isinstance(value, dict):
            return
        value.pop("default", None)
        properties = value.get("properties")
        if isinstance(properties, dict):
            value["additionalProperties"] = False
            value["required"] = list(properties)
        for child in value.values():
            visit(child)

    visit(normalized)
    return normalized


def _response_json(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise StructuredPayloadError("LLM response body was not JSON") from exc
    if not isinstance(payload, dict):
        raise StructuredPayloadError("LLM response body was not a JSON object")
    return payload


def _chat_content(payload: dict[str, Any]) -> str:
    try:
        message = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise StructuredPayloadError("LLM response did not contain a message") from exc
    if message.get("refusal"):
        raise StructuredLlmError("LLM refused the structured request")
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, list):
        texts = [
            str(item.get("text") or "")
            for item in content
            if isinstance(item, dict)
        ]
        if any(texts):
            return "".join(texts)
    raise StructuredPayloadError("LLM response did not contain JSON content")


def _responses_content(payload: dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text

    texts: list[str] = []
    for item in payload.get("output", []):
        if not isinstance(item, dict):
            continue
        if item.get("type") == "refusal":
            raise StructuredLlmError("LLM refused the structured request")
        for content in item.get("content", []):
            if not isinstance(content, dict):
                continue
            if content.get("type") == "refusal":
                raise StructuredLlmError("LLM refused the structured request")
            text = content.get("text")
            if isinstance(text, str) and text:
                texts.append(text)
    if texts:
        return "".join(texts)
    raise StructuredPayloadError("Responses API did not contain JSON output text")


def _parse_json_object(content: str) -> dict[str, Any]:
    try:
        value = json.loads(content)
    except ValueError as exc:
        raise StructuredPayloadError("LLM returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise StructuredPayloadError("LLM structured output must be a JSON object")
    return value


def _validated_json_object(
    content: str,
    validator: Callable[[dict[str, Any]], Any] | None,
) -> dict[str, Any]:
    value = _parse_json_object(content)
    if validator is None:
        return value
    try:
        validator(value)
    except Exception as exc:
        detail = str(exc).strip().replace("\n", " ")[:600]
        raise StructuredPayloadError(
            f"LLM JSON did not satisfy the output schema: {detail or exc.__class__.__name__}"
        ) from exc
    return value


def _responses_body(
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
    schema_name: str,
    schema: dict[str, Any],
    reasoning_effort: str,
    output_mode: str = "json_schema",
    repair_content: str | None = None,
    repair_error: str | None = None,
) -> dict[str, Any]:
    prompt = user_prompt
    if repair_content is not None:
        prompt += (
            "\n\n上一份 JSON 未通过解析或 Schema 校验。请只修复这份输出，"
            "保持输入正文、标识和范围不变，仅返回一个完整合法 JSON 对象。"
            f"\n校验错误摘要：{(repair_error or 'invalid JSON')[:800]}"
            f"\n待修复输出：\n{repair_content[:20_000]}"
        )
    output_format: dict[str, Any]
    if output_mode == "json_object":
        output_format = {"type": "json_object"}
    else:
        output_format = {
            "type": "json_schema",
            "name": schema_name,
            "strict": True,
            "schema": _strict_output_schema(schema),
        }
    return {
        "model": model,
        "instructions": system_prompt,
        "input": [
            {
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}],
            }
        ],
        "text": {"format": output_format},
        "reasoning": {"effort": reasoning_effort},
    }


def _chat_body(
    *,
    provider: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    schema_name: str,
    schema: dict[str, Any],
    thinking: str,
    reasoning_effort: str,
    temperature: float,
    output_mode: str | None = None,
    repair_content: str | None = None,
    repair_error: str | None = None,
) -> dict[str, Any]:
    deepseek = provider == DEEPSEEK_PROVIDER
    resolved_mode = output_mode or ("json_object" if deepseek else "json_schema")
    messages: list[dict[str, str]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    if repair_content is not None:
        messages.extend(
            [
                {"role": "assistant", "content": repair_content[:20_000]},
                {
                    "role": "user",
                    "content": (
                        "上一份 JSON 未通过解析或 Schema 校验。请只修复这份输出，"
                        "保持输入正文、标识和范围不变，仅返回一个完整合法 JSON 对象。"
                        f"校验错误摘要：{(repair_error or 'invalid JSON')[:800]}"
                    ),
                },
            ]
        )
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "response_format": (
            {"type": "json_object"}
            if resolved_mode == "json_object"
            else {
                "type": "json_schema",
                "json_schema": {
                    "name": schema_name,
                    "strict": True,
                    "schema": _strict_output_schema(schema),
                },
            }
        ),
        "temperature": temperature,
        "reasoning_effort": reasoning_effort,
    }
    if deepseek:
        # Keep the proven DeepSeek request untouched as the explicit rollback
        # adapter when LLM_PROVIDER=deepseek.
        body["thinking"] = {"type": thinking}
    return body


def _responses_is_unavailable(response: httpx.Response) -> bool:
    if response.status_code in {404, 405, 501}:
        return True
    if response.status_code not in {400, 422}:
        return False
    detail = response.text.lower()
    return any(
        marker in detail
        for marker in (
            "responses api is not supported",
            "unsupported endpoint",
            "unknown endpoint",
            "unknown path",
            "not implemented",
        )
    )


def _strict_schema_is_unavailable(response: httpx.Response) -> bool:
    if response.status_code not in {400, 404, 405, 422, 501}:
        return False
    detail = response.text.lower()
    unsupported = any(
        marker in detail
        for marker in (
            "unsupported",
            "not supported",
            "unknown parameter",
            "unrecognized parameter",
            "invalid parameter",
            "not implemented",
        )
    )
    schema_field = any(
        marker in detail
        for marker in (
            "json_schema",
            "response_format",
            "text.format",
            "text > format",
        )
    )
    return unsupported and schema_field


def _json_mode_is_unavailable(response: httpx.Response) -> bool:
    if response.status_code not in {400, 404, 405, 422, 501}:
        return False
    detail = response.text.lower()
    unsupported = any(
        marker in detail
        for marker in (
            "unsupported",
            "not supported",
            "unknown parameter",
            "unrecognized parameter",
            "invalid parameter",
            "not implemented",
        )
    )
    json_field = any(
        marker in detail
        for marker in (
            "json_object",
            "json_schema",
            "response_format",
            "text.format",
            "text > format",
        )
    )
    return unsupported and json_field


async def _post(
    *,
    client: httpx.AsyncClient,
    url: str,
    api_key: str,
    body: dict[str, Any],
) -> httpx.Response:
    return await client.post(
        url,
        headers={
            "authorization": f"Bearer {api_key}",
            "content-type": "application/json",
        },
        json=body,
    )


async def generate_structured_result(
    *,
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    schema_name: str,
    schema: dict[str, Any],
    thinking: str,
    reasoning_effort: str,
    temperature: float,
    timeout_seconds: float,
    validator: Callable[[dict[str, Any]], Any] | None = None,
) -> StructuredGenerationResult:
    """Generate one schema-bound JSON object.

    Generic OpenAI-compatible gateways use Responses first and fall back to
    Chat Completions only when the Responses endpoint is explicitly absent.
    DeepSeek remains a separate, stable Chat Completions adapter for rollback.
    """

    if provider not in {OPENAI_COMPATIBLE_PROVIDER, DEEPSEEK_PROVIDER}:
        raise StructuredLlmError(f"Unsupported LLM provider: {provider}")

    request_count = 0
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds, connect=30)
        ) as client:
            if provider == OPENAI_COMPATIBLE_PROVIDER:
                responses_available = True
                responses_repair_content: str | None = None
                responses_repair_error: str | None = None
                request_count += 1
                response = await _post(
                    client=client,
                    url=_openai_endpoint(base_url, "responses"),
                    api_key=api_key,
                    body=_responses_body(
                        model=model,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        schema_name=schema_name,
                        schema=schema,
                        reasoning_effort=reasoning_effort,
                    ),
                )
                if 200 <= response.status_code < 300:
                    try:
                        responses_repair_content = _responses_content(
                            _response_json(response)
                        )
                        value = _validated_json_object(
                            responses_repair_content, validator
                        )
                    except StructuredPayloadError as exc:
                        responses_repair_error = str(exc)
                    else:
                        return StructuredGenerationResult(
                            data=value,
                            endpoint="responses",
                            output_mode="json_schema",
                            request_count=request_count,
                        )
                elif _responses_is_unavailable(response):
                    responses_available = False
                elif not _strict_schema_is_unavailable(response):
                    raise StructuredLlmError(
                        f"Responses API failed (HTTP {response.status_code}): "
                        f"{_safe_detail(response, api_key)}"
                    )

                # A gateway can expose /responses but only implement JSON
                # mode. Keep Responses as the preferred API and perform one
                # validation-guided repair there before trying Chat.
                if responses_available:
                    for json_attempt in range(2):
                        request_count += 1
                        response = await _post(
                            client=client,
                            url=_openai_endpoint(base_url, "responses"),
                            api_key=api_key,
                            body=_responses_body(
                                model=model,
                                system_prompt=system_prompt,
                                user_prompt=user_prompt,
                                schema_name=schema_name,
                                schema=schema,
                                reasoning_effort=reasoning_effort,
                                output_mode="json_object",
                                repair_content=responses_repair_content,
                                repair_error=responses_repair_error,
                            ),
                        )
                        if response.status_code >= 400:
                            if _responses_is_unavailable(
                                response
                            ) or _json_mode_is_unavailable(response):
                                break
                            raise StructuredLlmError(
                                "Responses JSON request failed "
                                f"(HTTP {response.status_code}): "
                                f"{_safe_detail(response, api_key)}"
                            )
                        try:
                            responses_repair_content = _responses_content(
                                _response_json(response)
                            )
                            value = _validated_json_object(
                                responses_repair_content, validator
                            )
                        except StructuredPayloadError as exc:
                            responses_repair_error = str(exc)
                            if json_attempt == 0:
                                continue
                            break
                        return StructuredGenerationResult(
                            data=value,
                            endpoint="responses",
                            output_mode=(
                                "json_object_repair"
                                if json_attempt or responses_repair_error is not None
                                else "json_object"
                            ),
                            request_count=request_count,
                        )

                request_count += 1
                response = await _post(
                    client=client,
                    url=_openai_endpoint(base_url, "chat/completions"),
                    api_key=api_key,
                    body=_chat_body(
                        provider=provider,
                        model=model,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        schema_name=schema_name,
                        schema=schema,
                        thinking=thinking,
                        reasoning_effort=reasoning_effort,
                        temperature=temperature,
                        output_mode="json_schema",
                    ),
                )
                if 200 <= response.status_code < 300:
                    try:
                        value = _validated_json_object(
                            _chat_content(_response_json(response)), validator
                        )
                    except StructuredPayloadError:
                        pass
                    else:
                        return StructuredGenerationResult(
                            data=value,
                            endpoint="chat/completions",
                            output_mode="json_schema",
                            request_count=request_count,
                        )
                elif not _strict_schema_is_unavailable(response):
                    raise StructuredLlmError(
                        f"Chat structured request failed (HTTP {response.status_code}): "
                        f"{_safe_detail(response, api_key)}"
                    )

            chat_url = (
                _endpoint(base_url, "chat/completions")
                if provider == DEEPSEEK_PROVIDER
                else _openai_endpoint(base_url, "chat/completions")
            )
            repair_content: str | None = None
            repair_error: str | None = None
            for repair_attempt in range(2):
                request_count += 1
                response = await _post(
                    client=client,
                    url=chat_url,
                    api_key=api_key,
                    body=_chat_body(
                        provider=provider,
                        model=model,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        schema_name=schema_name,
                        schema=schema,
                        thinking=thinking,
                        reasoning_effort=reasoning_effort,
                        temperature=temperature,
                        output_mode="json_object",
                        repair_content=repair_content,
                        repair_error=repair_error,
                    ),
                )
                if response.status_code >= 400:
                    raise StructuredLlmError(
                        f"LLM JSON request failed (HTTP {response.status_code}): "
                        f"{_safe_detail(response, api_key)}"
                    )
                try:
                    repair_content = _chat_content(_response_json(response))
                    value = _validated_json_object(repair_content, validator)
                except StructuredPayloadError as exc:
                    repair_error = str(exc)
                    if repair_attempt == 0:
                        continue
                    raise StructuredLlmError(
                        f"LLM JSON repair failed validation: {repair_error}"
                    ) from exc
                return StructuredGenerationResult(
                    data=value,
                    endpoint="chat/completions",
                    output_mode=(
                        "json_object_repair" if repair_attempt else "json_object"
                    ),
                    request_count=request_count,
                )
    except httpx.TimeoutException as exc:
        raise StructuredLlmError("LLM structured request timed out") from exc
    except httpx.HTTPError as exc:
        raise StructuredLlmError("Unable to call the LLM service") from exc
    raise StructuredLlmError("LLM structured request did not produce a result")


async def generate_structured_json(
    *,
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    schema_name: str,
    schema: dict[str, Any],
    thinking: str,
    reasoning_effort: str,
    temperature: float,
    timeout_seconds: float,
    validator: Callable[[dict[str, Any]], Any] | None = None,
) -> dict[str, Any]:
    """Compatibility wrapper for callers that only need the JSON object."""

    result = await generate_structured_result(
        provider=provider,
        api_key=api_key,
        base_url=base_url,
        model=model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        schema_name=schema_name,
        schema=schema,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
        temperature=temperature,
        timeout_seconds=timeout_seconds,
        validator=validator,
    )
    return result.data
