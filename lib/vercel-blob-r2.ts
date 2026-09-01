import { del, get, head, put } from "@vercel/blob";

type GetOptions = {
  range?: {
    offset: number;
    length: number;
  };
};

type PutOptions = {
  httpMetadata?: {
    contentType?: string;
  };
};

class VercelBlobObjectBody {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly httpMetadata: { contentType?: string };

  constructor(
    stream: ReadableStream<Uint8Array>,
    size: number,
    contentType: string | null | undefined,
  ) {
    this.body = stream;
    this.size = size;
    this.httpMetadata = { contentType: contentType || undefined };
  }

  arrayBuffer() {
    return new Response(this.body).arrayBuffer();
  }
}

/**
 * Exposes Vercel Blob through the subset of the Cloudflare R2 API used by the
 * shared worker. Keeping the storage key unchanged means migrated Turso asset
 * rows and both runtimes continue to address the same logical object.
 */
export function createVercelBlobBucket(): R2Bucket | undefined {
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) return undefined;

  return {
    async head(key: string) {
      try {
        const result = await head(key);
        return {
          size: result.size,
          httpMetadata: { contentType: result.contentType || undefined },
        };
      } catch (error) {
        if (error instanceof Error && /not found/iu.test(error.message)) return null;
        throw error;
      }
    },

    async get(key: string, options?: GetOptions) {
      const headers = new Headers();
      if (options?.range) {
        const start = options.range.offset;
        const end = start + options.range.length - 1;
        headers.set("range", `bytes=${start}-${end}`);
      }
      const result = await get(key, {
        access: "public",
        headers,
      });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      return new VercelBlobObjectBody(
        result.stream,
        result.blob.size,
        result.blob.contentType,
      );
    },

    async put(key: string, value: ArrayBuffer | ArrayBufferView | Blob | string, options?: PutOptions) {
      const body = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer
        : value;
      return put(key, body, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: options?.httpMetadata?.contentType,
      });
    },

    async delete(keys: string | string[]) {
      await del(keys);
    },
  } as unknown as R2Bucket;
}
