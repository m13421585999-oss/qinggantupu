import assert from "node:assert/strict";
import test from "node:test";

import {
  createImageGenerationProvider,
  detectImageDimensions,
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

test("analysis_service proxy returns underlying provider metadata and dimensions", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), body: JSON.parse(String(init.body)) };
    return Response.json({
      b64_json: "BwgJ",
      provider: "openai_compatible",
      model: "image2.0",
      width: 1536,
      height: 1024,
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
    assert.equal(request.url, "https://analysis.example/v1/image-generation");
    assert.equal(request.body.width, 1500);
    assert.equal(request.body.height, 280);
    assert.equal(generated.provider, "openai_compatible");
    assert.equal(generated.model, "image2.0");
    assert.equal(generated.width, 1536);
    assert.equal(generated.height, 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
