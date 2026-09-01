import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { list, put } from "@vercel/blob";
import sharp from "sharp";

const root = process.cwd();
const r2StateRoot = path.resolve(root, ".wrangler/state/v3/r2");
const metadataDb = path.join(
  r2StateRoot,
  "miniflare-R2BucketObject/49e6826fd41b4990fd0dd7b3ba19a3021a358ffb618ea1ab8f4454a592996ae7.sqlite",
);
const blobRoot = path.join(r2StateRoot, "site-creator-r2/blobs");
const concurrency = Math.max(1, Math.min(8, Number(process.env.MIGRATION_CONCURRENCY || 4)));

if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
  throw new Error("BLOB_READ_WRITE_TOKEN is required");
}
if (!metadataDb.startsWith(`${r2StateRoot}${path.sep}`) || !blobRoot.startsWith(`${r2StateRoot}${path.sep}`)) {
  throw new Error("Refusing to read R2 data outside the local Wrangler state directory");
}

async function existingPathnames() {
  const pathnames = new Set();
  let cursor;
  do {
    const page = await list({ limit: 1000, cursor });
    for (const blob of page.blobs) pathnames.add(blob.pathname);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return pathnames;
}

const database = new DatabaseSync(metadataDb, { readOnly: true });
const objects = database.prepare(`
  SELECT key, blob_id, size, http_metadata
    FROM _mf_objects
   ORDER BY key
`).all();
database.close();

const existing = await existingPathnames();
const pending = objects.filter((entry) => !existing.has(String(entry.key)));
let migrated = 0;
let failed = 0;
let skipped = objects.length - pending.length;
let uploadedBytes = 0;
let cursor = 0;
let fatalError;

console.log(JSON.stringify({ total: objects.length, existing: existing.size, pending: pending.length, concurrency }));

async function worker() {
  while (true) {
    if (fatalError) return;
    const index = cursor;
    cursor += 1;
    if (index >= pending.length) return;
    const entry = pending[index];
    const blobId = String(entry.blob_id);
    const source = path.resolve(blobRoot, blobId);
    if (!source.startsWith(`${blobRoot}${path.sep}`)) {
      throw new Error(`Invalid local blob id: ${blobId}`);
    }
    try {
      const bytes = await readFile(source);
      if (bytes.byteLength !== Number(entry.size)) {
        throw new Error(`size mismatch: expected ${entry.size}, got ${bytes.byteLength}`);
      }
      // Scene cards are photographic raster images. WebP keeps the original
      // dimensions while reducing the 2.29 GB local PNG library enough to fit
      // the Vercel Hobby Blob quota. The logical storage key stays unchanged;
      // the runtime serves the Blob content type rather than trusting the old
      // D1 metadata.
      const optimized = await sharp(bytes)
        .webp({ quality: 82, effort: 4, smartSubsample: true })
        .toBuffer();
      await put(String(entry.key), optimized, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "image/webp",
        multipart: false,
      });
      migrated += 1;
      uploadedBytes += optimized.byteLength;
      if (migrated % 50 === 0 || migrated === pending.length) {
        console.log(JSON.stringify({ migrated, skipped, failed, uploadedBytes }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Blob listing can be briefly stale after another migration attempt.
      // A conflicting pathname means the object is already present, so a
      // resumed run should count it as skipped rather than fail the batch.
      if (/blob already exists/iu.test(message)) {
        skipped += 1;
        continue;
      }
      failed += 1;
      console.error(JSON.stringify({ key: entry.key, error: message }));
      if (/quota exceeded/iu.test(message)) fatalError = error;
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, pending.length || 1) }, () => worker()));

if (failed) {
  throw fatalError ?? new Error(`Migration completed with ${failed} failed object(s)`);
}
console.log(JSON.stringify({ ok: true, total: objects.length, migrated, skipped, uploadedBytes }));
