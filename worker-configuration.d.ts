declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    AUDIO_BUCKET: R2Bucket;
    ANALYSIS_SERVICE_URL?: string;
    ANALYSIS_SERVICE_TOKEN?: string;
    ANALYSIS_CALLBACK_TOKEN?: string;
    ELEVENLABS_API_KEY?: string;
    ELEVENLABS_VOICE_ID?: string;
    ELEVENLABS_TTS_MODEL?: string;
    AI_API_KEY?: string;
    AI_BASE_URL?: string;
    IMAGE_PROVIDER?: string;
    IMAGE_MODEL?: string;
    IMAGE_API_MODE?: string;
    /** Legacy rollback aliases. Prefer AI_API_KEY and AI_BASE_URL. */
    IMAGE_API_KEY?: string;
    IMAGE_BASE_URL?: string;
    IMAGE_OCR_MODEL?: string;
    IMAGES: {
      input(stream: ReadableStream): {
        transform(options: Record<string, unknown>): {
          output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
        };
      };
    };
  }
}

type Env = Cloudflare.Env;
