import type { VisualDirectorInput, VisualDirectorOutput } from "@/lib/visual-schema";

export interface VisualDirectorConfig {
  serviceUrl?: string;
  serviceToken?: string;
}

export class VisualDirectorRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "VisualDirectorRequestError";
  }
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
    const detail = (await response.text()).slice(0, 800);
    throw new VisualDirectorRequestError(
      `视觉导演请求失败（HTTP ${response.status}）：${detail}`,
      response.status >= 500 ? 502 : response.status,
    );
  }
  try {
    return await response.json() as VisualDirectorOutput;
  } catch {
    throw new VisualDirectorRequestError("视觉导演返回的方案不是有效 JSON。", 502);
  }
}
