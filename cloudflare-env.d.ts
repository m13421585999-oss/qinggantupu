declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      AUDIO_BUCKET: R2Bucket;
      ELEVENLABS_API_KEY?: string;
      ELEVENLABS_VOICE_ID?: string;
    }
  }
}

export {};
