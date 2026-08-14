import type { VisualDirectorInput, VisualDirectorOutput } from "@/lib/visual-schema";

export interface VisualDirectorConfig {
  serviceUrl?: string;
  serviceToken?: string;
}

export class VisualDirectorRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.name = "VisualDirectorRequestError";
  }
}

function safeErrorDetail(value: string, secret?: string) {
  let detail = value;
  if (secret) detail = detail.split(secret).join("[redacted]");
  return detail
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu, "$1[redacted]")
    .slice(0, 800);
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Normalizes the renamed visual-director fields while accepting saved/rolling old responses. */
export function normalizeVisualDirectorOutput(payload: Record<string, unknown>): VisualDirectorOutput {
  const rawProfile = payload.work_visual_profile && typeof payload.work_visual_profile === "object"
    ? payload.work_visual_profile as Record<string, unknown>
    : {};
  const rawHero = payload.hero_visual_spec && typeof payload.hero_visual_spec === "object"
    ? payload.hero_visual_spec as Record<string, unknown>
    : {};
  const rawScenes = Array.isArray(payload.scene_visual_specs)
    ? payload.scene_visual_specs as Array<Record<string, unknown>>
    : [];
  return {
    ...payload,
    work_visual_profile: {
      visual_style: String(rawProfile.visual_style ?? ""),
      palette: stringArray(rawProfile.palette),
      texture: String(rawProfile.texture ?? ""),
      lighting: String(rawProfile.lighting ?? ""),
      atmosphere: String(rawProfile.atmosphere ?? ""),
      composition_language: String(
        rawProfile.composition_language ?? rawProfile.composition_rule ?? "",
      ),
      human_presence: String(rawProfile.human_presence ?? ""),
      symbolic_language: stringArray(
        rawProfile.symbolic_language ?? rawProfile.symbolic_elements,
      ),
      avoid: stringArray(rawProfile.avoid),
    },
    hero_visual_spec: {
      ...rawHero,
      type: "hero",
      size: { width: 1500, height: 280 },
    } as VisualDirectorOutput["hero_visual_spec"],
    scene_visual_specs: rawScenes.map((scene) => ({
      ...scene,
      scene_meaning: String(scene.scene_meaning ?? scene.scene_summary ?? ""),
    })) as VisualDirectorOutput["scene_visual_specs"],
  };
}

export async function requestVisualDirection(
  input: VisualDirectorInput,
  config: VisualDirectorConfig,
): Promise<VisualDirectorOutput> {
  const serviceUrl = config.serviceUrl?.trim().replace(/\/$/, "");
  const serviceToken = config.serviceToken?.trim();
  if (!serviceUrl || !serviceToken) {
    throw new VisualDirectorRequestError("视觉导演服务尚未完成服务端配置。", 503);
  }
  let response: Response;
  try {
    response = await fetch(`${serviceUrl}/v1/visual-director`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new VisualDirectorRequestError(
      `无法连接视觉导演服务：${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }
  if (!response.ok) {
    const detail = safeErrorDetail(await response.text(), serviceToken);
    throw new VisualDirectorRequestError(
      `视觉导演请求失败（HTTP ${response.status}）：${detail}`,
      response.status >= 500 ? 502 : response.status,
    );
  }
  try {
    return normalizeVisualDirectorOutput(await response.json() as Record<string, unknown>);
  } catch {
    throw new VisualDirectorRequestError("视觉导演返回的方案不是有效 JSON。", 502);
  }
}
