export interface HeroTextValidationConfig {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
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
  return String(value ?? "").replace(/[\s《》〈〉「」『』“”'"·•]/gu, "").trim();
}

export async function validateHeroText(
  bytes: ArrayBuffer,
  mimeType: string,
  title: string,
  author: string,
  config: HeroTextValidationConfig,
): Promise<HeroTextValidationResult> {
  if (!config.model?.trim() || !config.apiKey?.trim()) return { status: "not_run" };
  const baseUrl = config.baseUrl?.trim().replace(/\/$/, "") || "https://api.openai.com/v1";
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
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
              text: "读取图片中作为作品标题和作者的中文。只返回 JSON：{\"title\":\"\",\"author\":\"\"}。不要把“朗诵情感图谱”识别成标题或作者。",
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
    const matched = normalized(extractedTitle) === normalized(title)
      && (!author || normalized(extractedAuthor) === normalized(author));
    return {
      status: matched ? "matched" : "mismatch",
      extractedTitle,
      extractedAuthor,
    };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
