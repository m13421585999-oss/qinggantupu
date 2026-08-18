import assert from "node:assert/strict";
import test from "node:test";

import {
  createImageGenerationProvider,
  detectImageDimensions,
  detectImageMimeType,
  ImageGenerationError,
} from "../lib/image-generation-provider.ts";

const input = {
  kind: "hero",
  prompt: "东方写意海面",
  negativePrompt: "水印",
  width: 1500,
  height: 280,
  title: "面朝大海，春暖花开",
  author: "海子",
};

test("actual PNG, JPEG and WebP bytes determine persisted image dimensions", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(png.buffer).setUint32(16, 1500, false);
  new DataView(png.buffer).setUint32(20, 280, false);
  assert.deepEqual(detectImageDimensions(png.buffer), { width: 1500, height: 280 });

  const jpeg = new Uint8Array(21);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x40, 0x03, 0x00], 0);
  assert.deepEqual(detectImageDimensions(jpeg.buffer), { width: 768, height: 576 });

  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode("RIFF"), 0);
  webp.set(new TextEncoder().encode("WEBP"), 8);
  webp.set(new TextEncoder().encode("VP8X"), 12);
  const widthMinusOne = 767;
  const heightMinusOne = 575;
  webp.set([widthMinusOne & 0xff, (widthMinusOne >> 8) & 0xff, 0], 24);
  webp.set([heightMinusOne & 0xff, (heightMinusOne >> 8) & 0xff, 0], 27);
  assert.deepEqual(detectImageDimensions(webp.buffer), { width: 768, height: 576 });
});

test("raw image signatures determine PNG, JPEG and WebP content types", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const webp = new Uint8Array(12);
  webp.set(new TextEncoder().encode("RIFF"), 0);
  webp.set(new TextEncoder().encode("WEBP"), 8);
  assert.equal(detectImageMimeType(png.buffer), "image/png");
  assert.equal(detectImageMimeType(jpeg.buffer), "image/jpeg");
  assert.equal(detectImageMimeType(webp.buffer), "image/webp");
  assert.equal(detectImageMimeType(Uint8Array.from([1, 2, 3]).buffer), undefined);
});

test("openai_compatible uses the normalized /v1 images endpoint and decodes b64 output", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ data: [{ b64_json: "AQID", seed: 7 }] });
  };
  try {
    const provider = createImageGenerationProvider({
      provider: "openai_compatible",
      model: "image2.0",
      apiKey: "test-secret",
      baseUrl: "https://img.example/v1",
      apiMode: "images",
    });
    const generated = await provider.generate(input);
    assert.equal(provider.provider, "openai-compatible");
    assert.deepEqual([...new Uint8Array(generated.bytes)], [1, 2, 3]);
    assert.equal(calls[0].url, "https://img.example/v1/images/generations");
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, "image2.0");
    assert.equal(body.size, "1500x280");
    assert.match(body.prompt, /必须避免：水印/);
    assert.equal(generated.endpoint, "images/generations");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("auto mode falls back to Responses only for endpoint capability errors", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response("route not found", { status: 404 });
    return Response.json({ output: [{ type: "image_generation_call", result: "BAUG" }] });
  };
  try {
    const provider = createImageGenerationProvider({
      provider: "openai-compatible",
      model: "image2.0",
      apiKey: "test-secret",
      baseUrl: "https://img.example",
      apiMode: "auto",
    });
    const generated = await provider.generate(input);
    assert.deepEqual(calls, [
      "https://img.example/v1/images/generations",
      "https://img.example/v1/responses",
    ]);
    assert.deepEqual([...new Uint8Array(generated.bytes)], [4, 5, 6]);
    assert.equal(generated.endpoint, "responses");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authorization failures never fall back and redact credentials", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("Authorization: Bearer top-secret", { status: 401 });
  };
  try {
    const provider = createImageGenerationProvider({
      provider: "openai-compatible",
      model: "image2.0",
      apiKey: "top-secret",
      baseUrl: "https://img.example",
    });
    await assert.rejects(
      () => provider.generate(input),
      (error) => error instanceof ImageGenerationError
        && error.status === 401
        && !error.message.includes("top-secret"),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analysis_service proxy submits an image task and polls to completion", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  // base64 of bytes [4,5,6] (atob-compatible)
  const b64 = Buffer.from([4, 5, 6]).toString("base64");
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    calls.push(href);
    if (init && init.method === "POST") {
      return Response.json({
        image_task_id: "image_task_test_1",
        scene_request_key: "key-1",
        work_id: "work-1",
        scene_id: "scene-1",
        status: "queued",
        created: true,
        attempt_count: 0,
      });
    }
    // GET poll -> completed with asset
    return Response.json({
      image_task_id: "image_task_test_1",
      status: "completed",
      asset: { b64_json: b64, width: 1536, height: 1024, seed: "s1" },
    });
  };
  try {
    const provider = createImageGenerationProvider({
      provider: "analysis_service",
      model: "service-configured",
      apiKey: "service-token",
      baseUrl: "https://analysis.example",
    });
    const generated = await provider.generate(input);
    assert.equal(calls[0], "https://analysis.example/v1/image-tasks");
    assert.equal(calls[1], "https://analysis.example/v1/image-tasks/image_task_test_1");
    assert.equal(generated.provider, "analysis-service");
    assert.equal(generated.model, "service-configured");
    assert.deepEqual([...new Uint8Array(generated.bytes)], [4, 5, 6]);
    assert.equal(generated.width, 1536);
    assert.equal(generated.height, 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analysis_service proxy idempotent submit reuses an existing completed task", async () => {
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url, init) => {
    if (init && init.method === "POST") {
      posts += 1;
      return Response.json({
        image_task_id: "image_task_existing",
        status: "completed",
        created: false,
        asset: { b64_json: Buffer.from([9, 8, 7]).toString("base64") },
      });
    }
    return Response.json({ image_task_id: "image_task_existing", status: "completed" });
  };
  try {
    const provider = createImageGenerationProvider({
      provider: "analysis_service",
      model: "service-configured",
      apiKey: "service-token",
      baseUrl: "https://analysis.example",
    });
    const generated = await provider.generate(input);
    assert.equal(posts, 1);
    assert.deepEqual([...new Uint8Array(generated.bytes)], [9, 8, 7]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
