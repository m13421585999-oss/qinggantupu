import { heroAuthorDisplay } from "@/lib/hero-production-prompt";

export interface HeroTextValidationConfig {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  serviceUrl?: string;
  serviceToken?: string;
}

export interface HeroTextValidationResult {
  status: "matched" | "mismatch" | "not_run" | "failed";
  extractedTitle?: string;
  extractedAuthor?: string;
  message?: string;
}

function encodeBase64(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes);
  let result = "";
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    result += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  }
  return btoa(result);
}

function normalized(value: unknown) {
  return String(value ?? "").replace(/[\s《》〈〉「」『』“”'"·•:：]/gu, "").trim();
}

function apiEndpoint(baseUrl: string, resource: string) {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return /\/v1$/u.test(base) ? `${base}/${resource}` : `${base}/v1/${resource}`;
}

function safeErrorDetail(value: string, secret?: string) {
  let detail = value;
  if (secret) detail = detail.split(secret).join("[redacted]");
  return detail
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]")
    .slice(0, 300);
}

function normalizeValidationPayload(payload: Record<string, unknown>): HeroTextValidationResult {
  const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
    ? payload.result as Record<string, unknown>
    : payload;
  const status = String(result.status ?? "failed");
  return {
    status: status === "matched" || status === "mismatch" || status === "not_run"
      ? status
      : "failed",
    extractedTitle: result.extracted_title == null && result.extractedTitle == null
      ? undefined
      : String(result.extracted_title ?? result.extractedTitle),
    extractedAuthor: result.extracted_author == null && result.extractedAuthor == null
      ? undefined
      : String(result.extracted_author ?? result.extractedAuthor),
    message: result.message == null ? undefined : String(result.message),
  };
}

export async function validateHeroText(
  bytes: ArrayBuffer,
  mimeType: string,
  title: string,
  author: string,
  config: HeroTextValidationConfig,
): Promise<HeroTextValidationResult> {
  const serviceUrl = config.serviceUrl?.trim();
  const serviceToken = config.serviceToken?.trim();
  if (serviceUrl && serviceToken) {
    try {
      const response = await fetch(`${serviceUrl.replace(/\/+$/, "")}/v1/hero-text-validation`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          image_base64: encodeBase64(bytes),
          mime_type: mimeType,
          title,
          author,
          model: config.model?.trim() || undefined,
        }),
      });
      if (!response.ok) {
        return {
          status: "failed",
          message: `OCR proxy HTTP ${response.status}: ${safeErrorDetail(await response.text(), serviceToken)}`,
        };
      }
      return normalizeValidationPayload(await response.json() as Record<string, unknown>);
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!config.model?.trim() || !config.apiKey?.trim()) return { status: "not_run" };
  const baseUrl = config.baseUrl?.trim() || "https://api.openai.com";
  try {
    const response = await fetch(apiEndpoint(baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey.trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model.trim(),
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: "逐字读取图片中的作品标题和完整作者行。只返回 JSON：{\"title\":\"\",\"author\":\"\"}。author 必须保留图片中可见的“作者：”前缀；标题或作者有字被裁切、看不清时返回空字符串，不得猜测。不要把“朗诵情感图谱”识别成标题或作者。",
            },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${encodeBase64(bytes)}` },
            },
          ],
        }],
      }),
    });
    if (!response.ok) return { status: "failed", message: `OCR HTTP ${response.status}` };
    const payload = await response.json() as Record<string, unknown>;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const message = choices[0] && typeof choices[0] === "object"
      ? (choices[0] as Record<string, unknown>).message
      : undefined;
    const content = message && typeof message === "object"
      ? (message as Record<string, unknown>).content
      : undefined;
    const extracted = JSON.parse(String(content ?? "{}")) as Record<string, unknown>;
    const extractedTitle = String(extracted.title ?? "");
    const extractedAuthor = String(extracted.author ?? "");
    const expectedAuthor = heroAuthorDisplay(author);
    const matched = normalized(extractedTitle) === normalized(title)
      && (!expectedAuthor || normalized(extractedAuthor) === normalized(expectedAuthor));
    return {
      status: matched ? "matched" : "mismatch",
      extractedTitle,
      extractedAuthor,
    };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
