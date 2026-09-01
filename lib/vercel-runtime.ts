import { createTursoD1 } from "@/lib/turso-d1";
import { handleApiRequest } from "@/worker/api";

function runtimeEnv(): Env {
  return {
    DB: createTursoD1(),
    AUDIO_BUCKET: undefined,
    ASSETS: undefined,
    IMAGES: undefined,
    ANALYSIS_SERVICE_URL: process.env.ANALYSIS_SERVICE_URL,
    ANALYSIS_SERVICE_TOKEN: process.env.ANALYSIS_SERVICE_TOKEN,
    ANALYSIS_CALLBACK_TOKEN: process.env.ANALYSIS_CALLBACK_TOKEN,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
    ELEVENLABS_TTS_MODEL: process.env.ELEVENLABS_TTS_MODEL,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
    IMAGE_PROVIDER: process.env.IMAGE_PROVIDER,
    IMAGE_MODEL: process.env.IMAGE_MODEL,
    IMAGE_API_MODE: process.env.IMAGE_API_MODE,
    IMAGE_API_KEY: process.env.IMAGE_API_KEY,
    IMAGE_BASE_URL: process.env.IMAGE_BASE_URL,
    IMAGE_OCR_MODEL: process.env.IMAGE_OCR_MODEL,
  } as unknown as Env;
}

export async function handleVercelApi(request: Request) {
  const response = await handleApiRequest(request, runtimeEnv());
  return response ?? Response.json(
    { error: { code: "API_NOT_FOUND", message: "找不到接口。" } },
    { status: 404 },
  );
}
