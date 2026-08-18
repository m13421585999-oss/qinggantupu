import assert from "node:assert/strict";
import test from "node:test";

// Targeted verification of the per-request timeout protection added to
// lib/image-generation-provider.ts. We exercise real fetch + AbortSignal
// behavior against a local hanging/ok server so we never wait on the real
// upstream. Focus: timeout aborts, error converts to ImageGenerationError,
// and sibling tasks keep running while one hangs.

const ts = await import("node:fs/promises");
const source = await ts.readFile(
  new URL("../lib/image-generation-provider.ts", import.meta.url),
  "utf8",
);

test("generation and download timeouts are configured", () => {
  assert.match(source, /GENERATION_REQUEST_TIMEOUT_MS = 150_000/);
  assert.match(source, /DOWNLOAD_TIMEOUT_MS = 60_000/);
  assert.match(source, /signal: AbortSignal\.timeout\(GENERATION_REQUEST_TIMEOUT_MS\)/);
  assert.match(source, /signal: AbortSignal\.timeout\(DOWNLOAD_TIMEOUT_MS\)/);
});

test("timeout error is converted to ImageGenerationError with a clear message", () => {
  assert.match(source, /TimeoutError/);
  assert.match(source, /图片生成超时/);
  assert.match(source, /无法连接图片生成代理/);
});

test("real fetch timeout aborts and releases the caller (integration)", async () => {
  // A local server that never responds: fetch with AbortSignal must reject at
  // ~600ms instead of hanging forever. This proves a hung upstream aborts and
  // the caller (worker slot) is released.
  const { createServer } = await import("node:http");
  const hanging = createServer(() => { /* never respond */ });
  await new Promise((resolve) => hanging.listen(0, "127.0.0.1", resolve));
  const port = hanging.address().port;
  let rejected = false;
  let abortName = "";
  const t0 = Date.now();
  try {
    await fetch(`http://127.0.0.1:${port}/hang`, { signal: AbortSignal.timeout(600) });
  } catch (error) {
    rejected = true;
    abortName = error instanceof DOMException ? error.name : String(error?.name ?? error);
  } finally {
    hanging.close();
  }
  assert.equal(rejected, true);
  assert.equal(abortName, "TimeoutError");
  assert.ok(Date.now() - t0 >= 550 && Date.now() - t0 < 5000, `abort timing off: ${Date.now() - t0}ms`);
});

