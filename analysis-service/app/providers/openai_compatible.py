from __future__ import annotations

import asyncio
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
    if not isinstance(message, dict):
        raise StructuredPayloadError("LLM response message was not an object")
    if message.get("refusal"):
        raise StructuredLlmError("LLM refused the structured request")
    parsed = message.get("parsed")
    if isinstance(parsed, dict):
        return json.dumps(parsed, ensure_ascii=False)
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, dict):
        content = [content]
    if isinstance(content, list):
        texts: list[str] = []
        for item in content:
            if isinstance(item, str) and item.strip():
                texts.append(item)
                continue
            if not isinstance(item, dict):
                continue
            if item.get("type") == "refusal" or item.get("refusal"):
                raise StructuredLlmError("LLM refused the structured request")
            structured = item.get("parsed")
            if structured is None:
                structured = item.get("json")
            if structured is None:
                structured = item.get("arguments")
            if isinstance(structured, dict):
                texts.append(json.dumps(structured, ensure_ascii=False))
                continue
            if isinstance(structured, str) and structured.strip():
                texts.append(structured)
                continue
            text = item.get("text")
            if isinstance(text, dict):
                text = text.get("value") or text.get("content")
            if isinstance(text, str) and text.strip():
                texts.append(text)
        if any(texts):
            return "".join(texts)
    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list):
        for tool_call in tool_calls:
            if not isinstance(tool_call, dict):
                continue
            function = tool_call.get("function")
            if isinstance(function, dict):
                arguments = function.get("arguments")
                if isinstance(arguments, str) and arguments.strip():
                    return arguments
    raise StructuredPayloadError("LLM response did not contain JSON content")


def _responses_content(payload: dict[str, Any]) -> str:
    """Extract structured text from common raw Responses API envelopes.

    OpenAI-compatible gateways are not fully consistent here: some expose the
    canonical ``output[].content[].text`` shape, some synthesize top-level
    ``output_text``, and a few return Chat-shaped ``choices`` even on the
    Responses endpoint.  Keep the accepted shapes explicit so we do not
    recursively mistake reasoning summaries or request metadata for output.
    """

    error = payload.get("error")
    if error:
        raise StructuredLlmError("Responses API returned an error payload")
    if payload.get("refusal"):
        raise StructuredLlmError("LLM refused the structured request")

    candidates: list[str] = []

    def append_candidate(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                append_candidate(item)
            return
        if isinstance(value, str):
            if value.strip():
                candidates.append(value)
            return
        if isinstance(value, dict):
            # Structured-output proxies sometimes return the parsed object
            # directly rather than serializing it into a text content part.
            candidates.append(json.dumps(value, ensure_ascii=False))

    append_candidate(payload.get("output_text"))
    append_candidate(payload.get("parsed"))

    output = payload.get("output", [])
    if isinstance(output, dict):
        output = [output]
    elif isinstance(output, str):
        append_candidate(output)
        output = []
    if not isinstance(output, list):
        output = []

    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "refusal" or item.get("refusal"):
            raise StructuredLlmError("LLM refused the structured request")
        item_type = str(item.get("type") or "").lower()
        if "reasoning" in item_type or "summary" in item_type:
            continue
        append_candidate(item.get("output_text"))
        append_candidate(item.get("parsed"))
        append_candidate(item.get("arguments"))

        content = item.get("content", [])
        if isinstance(content, (str, dict)):
            content = [content]
        if not isinstance(content, list):
            continue
        content_parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                if part.strip():
                    content_parts.append(part)
                continue
            if not isinstance(part, dict):
                continue
            if part.get("type") == "refusal" or part.get("refusal"):
                raise StructuredLlmError("LLM refused the structured request")
            structured = part.get("parsed")
            if structured is None:
                structured = part.get("json")
            if structured is None:
                structured = part.get("arguments")
            if isinstance(structured, dict):
                content_parts.append(json.dumps(structured, ensure_ascii=False))
                continue
            if isinstance(structured, str) and structured.strip():
                content_parts.append(structured)
                continue
            text = part.get("text")
            if isinstance(text, dict):
                text = text.get("value") or text.get("content")
            if isinstance(text, str) and text.strip():
                # Do not consume explicit reasoning/summary parts as the JSON
                # result. Unknown text types remain accepted for proxy
                # compatibility, provided they are not marked as reasoning.
                part_type = str(part.get("type") or "").lower()
                if "reasoning" not in part_type and "summary" not in part_type:
                    content_parts.append(text)
        if content_parts:
            candidates.append("".join(content_parts))

    if not candidates and isinstance(payload.get("choices"), list):
        # A minority of compatible gateways return a Chat Completions envelope
        # from /responses. Reuse the deliberately narrow Chat extractor.
        candidates.append(_chat_content(payload))

    for nested_key in ("response", "data"):
        nested = payload.get(nested_key)
        if not candidates and isinstance(nested, dict) and nested is not payload:
            try:
                candidates.append(_responses_content(nested))
            except StructuredPayloadError:
                pass

    if not candidates:
        status = str(payload.get("status") or "").lower()
        if status in {"failed", "cancelled", "incomplete"}:
            raise StructuredPayloadError(
                f"Responses API ended with status {status} and no JSON output text"
            )
        raise StructuredPayloadError("Responses API did not contain JSON output text")

    # Prefer a candidate that is already a complete JSON object. If a proxy
    # splits output_text across adjacent parts, try their concatenation next.
    for candidate in candidates:
        try:
            _parse_json_object(candidate)
        except StructuredPayloadError:
            continue
        return candidate
    combined = "".join(candidates)
    if combined.strip():
        return combined
    raise StructuredPayloadError("Responses API did not contain JSON output text")


def _parse_json_object(content: str) -> dict[str, Any]:
    if not isinstance(content, str):
        raise StructuredPayloadError("LLM returned non-text structured output")

    normalized = content.lstrip("\ufeff").strip()
    fenced = re.fullmatch(
        r"```(?:json)?\s*(.*?)\s*```",
        normalized,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if fenced:
        normalized = fenced.group(1).strip()

    def load(candidate: str) -> Any:
        value = json.loads(candidate)
        # Some proxies JSON-encode the model's JSON text one extra time.
        if isinstance(value, str):
            value = json.loads(value)
        return value

    try:
        value = load(normalized)
    except ValueError as direct_error:
        # JSON mode providers occasionally add one short explanatory prefix or
        # suffix despite the prompt. Extract exactly one balanced top-level
        # object; never use a greedy regex that can merge unrelated objects.
        start = normalized.find("{")
        value = None
        if start >= 0:
            depth = 0
            in_string = False
            escaped = False
            for index in range(start, len(normalized)):
                char = normalized[index]
                if in_string:
                    if escaped:
                        escaped = False
                    elif char == "\\":
                        escaped = True
                    elif char == '"':
                        in_string = False
                    continue
                if char == '"':
                    in_string = True
                elif char == "{":
                    depth += 1
                elif char == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            value = load(normalized[start : index + 1])
                        except ValueError:
                            value = None
                        break
        if value is None:
            raise StructuredPayloadError("LLM returned invalid JSON") from direct_error
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


def _is_transient_provider_failure(response: httpx.Response) -> bool:
    """Return whether another compatible endpoint may succeed immediately.

    408/429 are request-level transient failures. 5xx responses, including
    Cloudflare's 520-524 range, indicate gateway/upstream availability rather
    than a bad prompt or credential. Authentication and ordinary parameter
    errors deliberately remain outside this set and fail fast.
    """

    return response.status_code in {408, 429} or 500 <= response.status_code < 600


def _transient_failure_message(
    response: httpx.Response,
    *,
    request_count: int,
) -> str:
    """Return a short, user-safe description for exhausted transient errors.

    Cloudflare error pages can be hundreds of lines long and do not add any
    actionable provider detail. Keep only the status and bounded attempt count
    once every compatible request shape has failed.
    """

    return (
        "LLM provider is temporarily unavailable after "
        f"{request_count} attempts (last HTTP {response.status_code})"
    )


def _timeout_fallback_reasoning_effort(reasoning_effort: str) -> str:
    """Reduce expensive reasoning after a gateway 5xx without ever raising it."""

    if reasoning_effort in {"high", "xhigh", "max"}:
        return "medium"
    return reasoning_effort


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
    prefer_chat_json: bool = False,
) -> StructuredGenerationResult:
    """Generate one schema-bound JSON object.

    Generic OpenAI-compatible gateways normally use Responses first and fall
    back to Chat Completions. Latency-sensitive callers may start directly in
    Chat JSON mode; local validation still enforces the exact schema. DeepSeek
    remains a separate Chat adapter for rollback.
    """

    if provider not in {OPENAI_COMPATIBLE_PROVIDER, DEEPSEEK_PROVIDER}:
        raise StructuredLlmError(f"Unsupported LLM provider: {provider}")

    request_count = 0
    request_limit = 3 if provider == OPENAI_COMPATIBLE_PROVIDER else 2
    chat_fallback_reasoning_effort = reasoning_effort

    async def post_with_budget(
        client: httpx.AsyncClient,
        url: str,
        body: dict[str, Any],
    ) -> httpx.Response:
        nonlocal request_count
        if request_count >= request_limit:
            raise StructuredLlmError(
                f"LLM structured request exhausted its {request_limit}-request limit"
            )
        request_count += 1
        return await _post(
            client=client,
            url=url,
            api_key=api_key,
            body=body,
        )

    try:
        # ``timeout_seconds`` is a total provider budget, not a fresh timeout
        # for every fallback. This prevents multiple individually slow repair
        # calls from outliving the serverless request that owns them.
        async with asyncio.timeout(timeout_seconds), httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds, connect=min(30, timeout_seconds))
        ) as client:
            chat_repair_content: str | None = None
            chat_repair_error: str | None = None
            if provider == OPENAI_COMPATIBLE_PROVIDER and not prefer_chat_json:
                responses_available = True
                responses_json_unavailable = False
                responses_transient_failure = False
                responses_repair_content: str | None = None
                responses_repair_error: str | None = None
                response = await post_with_budget(
                    client,
                    _openai_endpoint(base_url, "responses"),
                    _responses_body(
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
                elif (
                    _responses_is_unavailable(response)
                    or _is_transient_provider_failure(response)
                ):
                    responses_transient_failure = _is_transient_provider_failure(
                        response
                    )
                    if response.status_code >= 500:
                        chat_fallback_reasoning_effort = (
                            _timeout_fallback_reasoning_effort(
                                chat_fallback_reasoning_effort
                            )
                        )
                    responses_available = False
                elif not _strict_schema_is_unavailable(response):
                    raise StructuredLlmError(
                        f"Responses API failed (HTTP {response.status_code}): "
                        f"{_safe_detail(response, api_key)}"
                    )

                # A gateway can expose /responses but only implement JSON
                # mode. Use the remaining bounded attempts for JSON mode and
                # at most one validation-guided repair. Once /responses has
                # returned a usable 2xx envelope, do not replay the same long
                # prompt through Chat Completions as a third strategy.
                if responses_available:
                    while request_count < request_limit:
                        was_repair = (
                            responses_repair_content is not None
                            or responses_repair_error is not None
                        )
                        response = await post_with_budget(
                            client,
                            _openai_endpoint(base_url, "responses"),
                            _responses_body(
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
                            if (
                                _responses_is_unavailable(response)
                                or _json_mode_is_unavailable(response)
                                or _is_transient_provider_failure(response)
                            ):
                                responses_transient_failure = (
                                    _is_transient_provider_failure(response)
                                )
                                if response.status_code >= 500:
                                    chat_fallback_reasoning_effort = (
                                        _timeout_fallback_reasoning_effort(
                                            chat_fallback_reasoning_effort
                                        )
                                    )
                                responses_json_unavailable = True
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
                            continue
                        return StructuredGenerationResult(
                            data=value,
                            endpoint="responses",
                            output_mode=(
                                "json_object_repair" if was_repair else "json_object"
                            ),
                            request_count=request_count,
                        )
                    if not responses_json_unavailable:
                        raise StructuredLlmError(
                            "Responses API did not return valid schema data within "
                            f"the {request_limit}-request limit: "
                            f"{responses_repair_error or 'missing JSON output'}"
                        )

                # A gateway timeout on /responses is an availability signal,
                # not evidence that strict schema is unsupported. Replaying
                # the same large strict schema through Chat often hits the
                # same Cloudflare deadline. JSON Object mode is smaller and
                # remains fully guarded by the caller's Pydantic validator.
                initial_chat_output_mode = (
                    "json_object"
                    if responses_transient_failure
                    else "json_schema"
                )
                response = await post_with_budget(
                    client,
                    _openai_endpoint(base_url, "chat/completions"),
                    _chat_body(
                        provider=provider,
                        model=model,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        schema_name=schema_name,
                        schema=schema,
                        thinking=thinking,
                        reasoning_effort=chat_fallback_reasoning_effort,
                        temperature=temperature,
                        output_mode=initial_chat_output_mode,
                    ),
                )
                if 200 <= response.status_code < 300:
                    try:
                        chat_repair_content = _chat_content(_response_json(response))
                        value = _validated_json_object(
                            chat_repair_content, validator
                        )
                    except StructuredPayloadError as exc:
                        chat_repair_error = str(exc)
                    else:
                        return StructuredGenerationResult(
                            data=value,
                            endpoint="chat/completions",
                            output_mode=initial_chat_output_mode,
                            request_count=request_count,
                        )
                elif _is_transient_provider_failure(response):
                    chat_repair_error = (
                        f"temporary upstream failure (HTTP {response.status_code})"
                    )
                    if response.status_code >= 500:
                        chat_fallback_reasoning_effort = (
                            _timeout_fallback_reasoning_effort(
                                chat_fallback_reasoning_effort
                            )
                        )
                    if request_count >= request_limit:
                        raise StructuredLlmError(
                            _transient_failure_message(
                                response,
                                request_count=request_count,
                            )
                        )
                elif (
                    initial_chat_output_mode == "json_schema"
                    and _strict_schema_is_unavailable(response)
                ):
                    pass
                else:
                    request_kind = (
                        "structured"
                        if initial_chat_output_mode == "json_schema"
                        else "JSON"
                    )
                    raise StructuredLlmError(
                        f"Chat {request_kind} request failed "
                        f"(HTTP {response.status_code}): "
                        f"{_safe_detail(response, api_key)}"
                    )

            chat_url = (
                _endpoint(base_url, "chat/completions")
                if provider == DEEPSEEK_PROVIDER
                else _openai_endpoint(base_url, "chat/completions")
            )
            repair_content = (
                chat_repair_content
                if provider == OPENAI_COMPATIBLE_PROVIDER
                else None
            )
            repair_error = (
                chat_repair_error
                if provider == OPENAI_COMPATIBLE_PROVIDER
                else None
            )
            while request_count < request_limit:
                was_repair = repair_content is not None
                response = await post_with_budget(
                    client,
                    chat_url,
                    _chat_body(
                        provider=provider,
                        model=model,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        schema_name=schema_name,
                        schema=schema,
                        thinking=thinking,
                        reasoning_effort=chat_fallback_reasoning_effort,
                        temperature=temperature,
                        output_mode="json_object",
                        repair_content=repair_content,
                        repair_error=repair_error,
                    ),
                )
                if response.status_code >= 400:
                    if _is_transient_provider_failure(response):
                        repair_error = (
                            f"temporary upstream failure (HTTP {response.status_code})"
                        )
                        if (
                            provider == OPENAI_COMPATIBLE_PROVIDER
                            and response.status_code >= 500
                        ):
                            chat_fallback_reasoning_effort = (
                                _timeout_fallback_reasoning_effort(
                                    chat_fallback_reasoning_effort
                                )
                            )
                        if request_count < request_limit:
                            continue
                        raise StructuredLlmError(
                            _transient_failure_message(
                                response,
                                request_count=request_count,
                            )
                        )
                    raise StructuredLlmError(
                        f"LLM JSON request failed (HTTP {response.status_code}): "
                        f"{_safe_detail(response, api_key)}"
                    )
                try:
                    repair_content = _chat_content(_response_json(response))
                    value = _validated_json_object(repair_content, validator)
                except StructuredPayloadError as exc:
                    repair_error = str(exc)
                    continue
                return StructuredGenerationResult(
                    data=value,
                    endpoint="chat/completions",
                    output_mode=(
                        "json_object_repair" if was_repair else "json_object"
                    ),
                    request_count=request_count,
                )
            raise StructuredLlmError(
                "LLM JSON output did not validate within "
                f"the {request_limit}-request limit: "
                f"{repair_error or 'missing JSON output'}"
            )
    except (TimeoutError, httpx.TimeoutException) as exc:
        raise StructuredLlmError(
            f"LLM structured request exceeded its {timeout_seconds:g}s total timeout"
        ) from exc
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
    prefer_chat_json: bool = False,
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
        prefer_chat_json=prefer_chat_json,
    )
    return result.data
