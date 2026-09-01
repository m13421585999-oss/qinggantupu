import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleApiRequest } from "./api";

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const apiResponse = await handleApiRequest(request, env);
      if (apiResponse) return apiResponse;
      const url = new URL(request.url);
      if (url.pathname === "/_vinext/image") {
        const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
        return handleImageOptimization(request, {
          fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
            return result.response();
          },
        }, allowedWidths);
      }
      return handler.fetch(request, env, ctx);
    } catch (error) {
      console.error("worker request failed", error);
      return Response.json(
        { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "服务器发生未知错误。" } },
        { status: 500 },
      );
    }
  },
};

export default worker;
