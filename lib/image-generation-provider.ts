export interface ImageGenerationConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  apiMode?: string;
}

export interface GenerateImageInput {
  kind: "hero" | "scene";
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  title?: string;
  author?: string;
  sceneId?: string;
}

export interface GeneratedImage {
  bytes: ArrayBuffer;
  mimeType: string;
  provider: string;
  model: string;
  /** Actual upstream capability that produced the image. */
  endpoint?: "images/generations" | "responses";
  width?: number;
  height?: number;
  seed?: string;
  isPlaceholder: boolean;
}

export interface ImageGenerationProvider {
  readonly provider: string;
  readonly model: string;
  readonly configured: boolean;
  generate(input: GenerateImageInput): Promise<GeneratedImage>;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

type ImageApiMode = "auto" | "images" | "responses";

export class ImageGenerationError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
    this.name = "ImageGenerationError";
  }
}

function positiveDimensions(width: number, height: number): ImageDimensions | undefined {
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { width, height }
    : undefined;
}

/** Detects the persisted content type when an upstream returns unlabelled raw base64. */
export function detectImageMimeType(bytes: ArrayBuffer): string | undefined {
  const data = new Uint8Array(bytes);
  if (
    data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 12
    && String.fromCharCode(...data.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...data.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  return undefined;
}

/** Reads dimensions from image bytes so stored metadata never trusts a planned size. */
export function detectImageDimensions(bytes: ArrayBuffer): ImageDimensions | undefined {
  const data = new Uint8Array(bytes);
  if (
    data.length >= 24
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[12] === 0x49 && data[13] === 0x48 && data[14] === 0x44 && data[15] === 0x52
  ) {
    const view = new DataView(bytes);
    return positiveDimensions(view.getUint32(16, false), view.getUint32(20, false));
  }
  if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (offset + 3 >= data.length) break;
      const length = (data[offset + 2] << 8) | data[offset + 3];
      if (length < 2 || offset + 2 + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return positiveDimensions(
          (data[offset + 7] << 8) | data[offset + 8],
          (data[offset + 5] << 8) | data[offset + 6],
        );
      }
      offset += 2 + length;
    }
  }
  if (
    data.length >= 30
    && String.fromCharCode(...data.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...data.subarray(8, 12)) === "WEBP"
  ) {
    const chunk = String.fromCharCode(...data.subarray(12, 16));
    if (chunk === "VP8X") {
      return positiveDimensions(
        1 + data[24] + (data[25] << 8) + (data[26] << 16),
        1 + data[27] + (data[28] << 8) + (data[29] << 16),
      );
    }
    if (chunk === "VP8L" && data[20] === 0x2f && data.length >= 25) {
      return positiveDimensions(
        1 + data[21] + ((data[22] & 0x3f) << 8),
        1 + ((data[22] & 0xc0) >> 6) + (data[23] << 2) + ((data[24] & 0x0f) << 10),
      );
    }
    if (
      chunk === "VP8 " && data.length >= 30
      && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a
    ) {
      return positiveDimensions(
        (data[26] | (data[27] << 8)) & 0x3fff,
        (data[28] | (data[29] << 8)) & 0x3fff,
      );
    }
  }
  return undefined;
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  }[char] ?? char));
}

class PlaceholderImageProvider implements ImageGenerationProvider {
  readonly provider = "placeholder";
  readonly model = "deterministic-svg-v1";
  readonly configured = false;

  async generate(input: GenerateImageInput): Promise<GeneratedImage> {
    const label = input.kind === "hero"
      ? `${input.title || "未命名作品"}${input.author ? ` · ${input.author}` : ""}`
      : `场景 ${input.sceneId || ""}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}">
      <defs>
        <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f6f0e5"/><stop offset="1" stop-color="#dfd5c3"/></linearGradient>
        <radialGradient id="wash"><stop stop-color="#b45c45" stop-opacity=".22"/><stop offset="1" stop-color="#69796c" stop-opacity="0"/></radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#paper)"/>
      <circle cx="82%" cy="28%" r="34%" fill="url(#wash)"/>
      <path d="M0 ${input.height * .78} Q ${input.width * .24} ${input.height * .48}, ${input.width * .48} ${input.height * .8} T ${input.width} ${input.height * .7} V ${input.height} H0Z" fill="#708276" opacity=".16"/>
      <text x="${input.width * .07}" y="${input.height * .56}" fill="#3f3932" font-size="${Math.max(22, Math.round(input.height * .115))}" font-family="serif">${escapeXml(label)}</text>
      ${input.kind === "hero" ? `<text x="${input.width * .07}" y="${input.height * .72}" fill="#8d4437" font-size="${Math.max(18, Math.round(input.height * .065))}" font-family="serif">朗诵情感图谱 · 视觉占位</text>` : ""}
    </svg>`;
    return {
      bytes: new TextEncoder().encode(svg).buffer,
      mimeType: "image/svg+xml",
      provider: this.provider,
      model: this.model,
      width: input.width,
      height: input.height,
      isPlaceholder: true,
    };
  }
}

function decodeBase64(value: string) {
  const encoded = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function decodedBase64Image(value: string) {
  const bytes = decodeBase64(value);
  return {
    bytes,
    mimeType: mimeTypeFromDataUrl(value) ?? detectImageMimeType(bytes) ?? "image/png",
  };
}

function apiEndpoint(baseUrl: string, resource: "images/generations" | "responses") {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith(`/${resource}`)) return base;
  if (/\/v1$/u.test(base)) return `${base}/${resource}`;
  return `${base}/v1/${resource}`;
}

function standardImageSize(width: number, height: number) {
  if (width === height) return "1024x1024";
  return width > height ? "1536x1024" : "1024x1536";
}

function mimeTypeFromDataUrl(value: string) {
  return value.match(/^data:([^;,]+)[;,]/u)?.[1];
}

function imageFromResponseOutput(payload: Record<string, unknown>) {
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const direct = record.result ?? record.b64_json ?? record.image_base64;
    if (typeof direct === "string" && direct) {
      return { encoded: direct, seed: record.seed };
    }
    const content = Array.isArray(record.content) ? record.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const contentRecord = part as Record<string, unknown>;
      const encoded = contentRecord.result
        ?? contentRecord.b64_json
        ?? contentRecord.image_base64
        ?? contentRecord.data;
      if (typeof encoded === "string" && encoded) {
        return { encoded, seed: record.seed };
      }
    }
  }
  return undefined;
}

function canFallBackToResponses(status: number, detail: string) {
  if ([404, 405, 501].includes(status)) return true;
  if (![400, 422].includes(status)) return false;
  return /(unsupported|not supported|unknown endpoint|route not found|images\/generations)/iu.test(detail);
}

function safeErrorDetail(value: string, secret?: string) {
  let detail = value;
  if (secret) detail = detail.split(secret).join("[redacted]");
  return detail
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu, "$1[redacted]")
    .slice(0, 800);
}

async function downloadedImage(url: string) {
  const image = await fetch(url);
  if (!image.ok) throw new ImageGenerationError("无法下载图片生成服务返回的临时图片。", 502);
  return {
    bytes: await image.arrayBuffer(),
    mimeType: image.headers.get("content-type")?.split(";")[0] || "image/png",
  };
}

function imageDataFromPayload(payload: Record<string, unknown>) {
  const data = Array.isArray(payload.data) ? payload.data[0] as Record<string, unknown> | undefined : undefined;
  if (data) return data;
  return payload;
}

class AnalysisServiceImageProvider implements ImageGenerationProvider {
  readonly provider = "analysis-service";
  readonly model: string;
  readonly configured = true;
  private readonly config: Required<Pick<ImageGenerationConfig, "model" | "apiKey" | "baseUrl">>;

  constructor(config: Required<Pick<ImageGenerationConfig, "model" | "apiKey" | "baseUrl">>) {
    this.config = config;
    this.model = config.model;
  }

  async generate(input: GenerateImageInput): Promise<GeneratedImage> {
    let response: Response;
    try {
      response = await fetch(
        `${this.config.baseUrl.trim().replace(/\/+$/, "")}/v1/image-generation`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.model === "service-configured" ? undefined : this.model,
            kind: input.kind,
            prompt: input.prompt,
            negative_prompt: input.negativePrompt,
            width: input.width,
            height: input.height,
            title: input.title,
            author: input.author,
            scene_id: input.sceneId,
          }),
        },
      );
    } catch (error) {
      throw new ImageGenerationError(
        `无法连接图片生成代理：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new ImageGenerationError(
        `图片生成代理请求失败（HTTP ${response.status}）：${safeErrorDetail(
          await response.text(),
          this.config.apiKey,
        )}`,
        response.status >= 500 ? 502 : response.status,
      );
    }
    const contentType = response.headers.get("content-type")?.split(";")[0] || "";
    if (contentType.startsWith("image/")) {
      return {
        bytes: await response.arrayBuffer(),
        mimeType: contentType,
        provider: this.provider,
        model: this.model,
        width: input.width,
        height: input.height,
        isPlaceholder: false,
      };
    }
    const payload = await response.json() as Record<string, unknown>;
    const data = imageDataFromPayload(payload);
    const seed = data.seed == null ? undefined : String(data.seed);
    const returnedModel = String(payload.model ?? data.model ?? this.model);
    const returnedProvider = String(payload.provider ?? data.provider ?? "openai-compatible");
    const returnedEndpoint = String(payload.endpoint ?? data.endpoint ?? "").trim();
    const width = Number(payload.width ?? data.width ?? input.width);
    const height = Number(payload.height ?? data.height ?? input.height);
    const encoded = data.b64_json ?? data.image_base64 ?? data.result;
    if (typeof encoded === "string" && encoded) {
      const image = decodedBase64Image(encoded);
      return {
        ...image,
        provider: returnedProvider,
        model: returnedModel,
        endpoint: returnedEndpoint === "images/generations" || returnedEndpoint === "responses"
          ? returnedEndpoint
          : undefined,
        width: Number.isFinite(width) ? width : input.width,
        height: Number.isFinite(height) ? height : input.height,
        seed,
        isPlaceholder: false,
      };
    }
    if (typeof data.url === "string" && data.url) {
      const image = await downloadedImage(data.url);
      return {
        ...image,
        provider: returnedProvider,
        model: returnedModel,
        endpoint: returnedEndpoint === "images/generations" || returnedEndpoint === "responses"
          ? returnedEndpoint
          : undefined,
        width: Number.isFinite(width) ? width : input.width,
        height: Number.isFinite(height) ? height : input.height,
        seed,
        isPlaceholder: false,
      };
    }
    throw new ImageGenerationError("图片生成代理没有返回图片。", 502);
  }
}

class OpenAiCompatibleImageProvider implements ImageGenerationProvider {
  readonly provider: string;
  readonly model: string;
  readonly configured = true;
  private readonly config: Required<Pick<ImageGenerationConfig, "provider" | "model" | "apiKey" | "baseUrl">> & {
    apiMode: ImageApiMode;
  };

  constructor(config: Required<Pick<ImageGenerationConfig, "provider" | "model" | "apiKey" | "baseUrl">> & {
    apiMode: ImageApiMode;
  }) {
    this.config = config;
    this.provider = config.provider;
    this.model = config.model;
  }

  private async request(endpoint: string, body: Record<string, unknown>) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ImageGenerationError(
        `无法连接图片生成服务：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const detail = response.ok ? "" : safeErrorDetail(await response.text(), this.config.apiKey);
    return { response, detail };
  }

  private async generatedFromImages(prompt: string, input: GenerateImageInput) {
    const size = this.provider === "openai"
      ? standardImageSize(input.width, input.height)
      : `${input.width}x${input.height}`;
    const [generatedWidth, generatedHeight] = size.split("x").map(Number);
    const { response, detail } = await this.request(
      apiEndpoint(this.config.baseUrl, "images/generations"),
      { model: this.model, prompt, size, n: 1 },
    );
    if (!response.ok) return { status: response.status, detail } as const;
    const payload = await response.json() as Record<string, unknown>;
    const data = Array.isArray(payload.data) ? payload.data[0] as Record<string, unknown> | undefined : undefined;
    if (!data) throw new ImageGenerationError("图片生成服务没有返回图片。", 502);
    const seed = data.seed == null ? undefined : String(data.seed);
    if (typeof data.b64_json === "string" && data.b64_json) {
      const image = decodedBase64Image(data.b64_json);
      return {
        ...image,
        provider: this.provider,
        model: this.model,
        endpoint: "images/generations",
        width: generatedWidth,
        height: generatedHeight,
        seed,
        isPlaceholder: false,
      };
    }
    if (typeof data.url === "string" && data.url) {
      const image = await downloadedImage(data.url);
      return {
        ...image,
        provider: this.provider,
        model: this.model,
        endpoint: "images/generations",
        width: generatedWidth,
        height: generatedHeight,
        seed,
        isPlaceholder: false,
      };
    }
    throw new ImageGenerationError("图片生成服务响应缺少 b64_json 或 url。", 502);
  }

  private async generatedFromResponses(prompt: string, input: GenerateImageInput) {
    const { response, detail } = await this.request(
      apiEndpoint(this.config.baseUrl, "responses"),
      {
        model: this.model,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        tools: [{ type: "image_generation", size: standardImageSize(input.width, input.height) }],
        tool_choice: { type: "image_generation" },
      },
    );
    if (!response.ok) {
      throw new ImageGenerationError(
        `图片生成服务请求失败（HTTP ${response.status}）：${detail}`,
        response.status >= 500 ? 502 : response.status,
      );
    }
    const payload = await response.json() as Record<string, unknown>;
    const image = imageFromResponseOutput(payload);
    if (!image) throw new ImageGenerationError("Responses 图片生成响应中没有图片数据。", 502);
    const decoded = decodedBase64Image(image.encoded);
    return {
      ...decoded,
      provider: this.provider,
      model: this.model,
      endpoint: "responses",
      width: Number(standardImageSize(input.width, input.height).split("x")[0]),
      height: Number(standardImageSize(input.width, input.height).split("x")[1]),
      seed: image.seed == null ? undefined : String(image.seed),
      isPlaceholder: false,
    } satisfies GeneratedImage;
  }

  async generate(input: GenerateImageInput): Promise<GeneratedImage> {
    const prompt = input.negativePrompt
      ? `${input.prompt}\n\n必须避免：${input.negativePrompt}`
      : input.prompt;
    if (this.config.apiMode === "responses") {
      return this.generatedFromResponses(prompt, input);
    }
    const generated = await this.generatedFromImages(prompt, input);
    const failure = generated as { status?: number; detail?: string };
    if (typeof failure.status !== "number") return generated as GeneratedImage;
    const detail = failure.detail ?? "";
    if (this.config.apiMode === "auto" && canFallBackToResponses(failure.status, detail)) {
      return this.generatedFromResponses(prompt, input);
    }
    throw new ImageGenerationError(
      `图片生成服务请求失败（HTTP ${failure.status}）：${detail}`,
      failure.status >= 500 ? 502 : failure.status,
    );
  }
}

export function createImageGenerationProvider(config: ImageGenerationConfig): ImageGenerationProvider {
  const provider = config.provider?.trim().toLowerCase().replace(/_/gu, "-") || "placeholder";
  if (provider === "placeholder" || !config.apiKey?.trim()) return new PlaceholderImageProvider();
  if (provider === "analysis-service") {
    if (!config.baseUrl?.trim()) return new PlaceholderImageProvider();
    return new AnalysisServiceImageProvider({
      model: config.model?.trim() || "service-configured",
      apiKey: config.apiKey.trim(),
      baseUrl: config.baseUrl.trim(),
    });
  }
  if (provider !== "openai" && provider !== "openai-compatible") {
    throw new ImageGenerationError(`不支持的图片生成供应商：${provider}`, 503);
  }
  const requestedMode = config.apiMode?.trim().toLowerCase().replace(/_/gu, "-") || "auto";
  const apiMode: ImageApiMode = requestedMode === "images" || requestedMode === "responses"
    ? requestedMode
    : "auto";
  return new OpenAiCompatibleImageProvider({
    provider,
    model: config.model?.trim() || "gpt-image-1",
    apiKey: config.apiKey.trim(),
    baseUrl: config.baseUrl?.trim() || "https://api.openai.com",
    apiMode,
  });
}
