declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      AUDIO_BUCKET: R2Bucket;
      ANALYSIS_SERVICE_URL?: string;
      ANALYSIS_SERVICE_TOKEN?: string;
      ANALYSIS_CALLBACK_TOKEN?: string;
      ELEVENLABS_API_KEY?: string;
      ELEVENLABS_VOICE_ID?: string;
    }
  }
}

export {};
