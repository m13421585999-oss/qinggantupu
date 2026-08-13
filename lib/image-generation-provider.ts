export interface ImageGenerationConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
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
  seed?: string;
  isPlaceholder: boolean;
}

export interface ImageGenerationProvider {
  readonly provider: string;
  readonly model: string;
  readonly configured: boolean;
  generate(input: GenerateImageInput): Promise<GeneratedImage>;
}

export class ImageGenerationError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "ImageGenerationError";
  }
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
      isPlaceholder: true,
    };
  }
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

class OpenAiCompatibleImageProvider implements ImageGenerationProvider {
  readonly provider: string;
  readonly model: string;
  readonly configured = true;

  constructor(private readonly config: Required<Pick<ImageGenerationConfig, "provider" | "model" | "apiKey" | "baseUrl">>) {
    this.provider = config.provider;
    this.model = config.model;
  }

  async generate(input: GenerateImageInput): Promise<GeneratedImage> {
    const prompt = input.negativePrompt
      ? `${input.prompt}\n\n必须避免：${input.negativePrompt}`
      : input.prompt;
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/images/generations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          size: `${input.width}x${input.height}`,
          response_format: "b64_json",
          n: 1,
        }),
      });
    } catch (error) {
      throw new ImageGenerationError(
        `无法连接图片生成服务：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new ImageGenerationError(
        `图片生成服务请求失败（HTTP ${response.status}）：${(await response.text()).slice(0, 800)}`,
        response.status >= 500 ? 502 : response.status,
      );
    }
    const payload = await response.json() as Record<string, unknown>;
    const data = Array.isArray(payload.data) ? payload.data[0] as Record<string, unknown> | undefined : undefined;
    if (!data) throw new ImageGenerationError("图片生成服务没有返回图片。", 502);
    const seed = data.seed == null ? undefined : String(data.seed);
    if (typeof data.b64_json === "string" && data.b64_json) {
      return {
        bytes: decodeBase64(data.b64_json),
        mimeType: "image/png",
        provider: this.provider,
        model: this.model,
        seed,
        isPlaceholder: false,
      };
    }
    if (typeof data.url === "string" && data.url) {
      const image = await fetch(data.url);
      if (!image.ok) throw new ImageGenerationError("无法下载图片生成服务返回的临时图片。", 502);
      return {
        bytes: await image.arrayBuffer(),
        mimeType: image.headers.get("content-type")?.split(";")[0] || "image/png",
        provider: this.provider,
        model: this.model,
        seed,
        isPlaceholder: false,
      };
    }
    throw new ImageGenerationError("图片生成服务响应缺少 b64_json 或 url。", 502);
  }
}

export function createImageGenerationProvider(config: ImageGenerationConfig): ImageGenerationProvider {
  const provider = config.provider?.trim().toLowerCase() || "placeholder";
  if (provider === "placeholder" || !config.apiKey?.trim()) return new PlaceholderImageProvider();
  if (provider !== "openai" && provider !== "openai-compatible") {
    throw new ImageGenerationError(`不支持的图片生成供应商：${provider}`, 503);
  }
  return new OpenAiCompatibleImageProvider({
    provider,
    model: config.model?.trim() || "gpt-image-1",
    apiKey: config.apiKey.trim(),
    baseUrl: config.baseUrl?.trim() || "https://api.openai.com/v1",
  });
}
