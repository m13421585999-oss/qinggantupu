import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("compact and full both render the shared sentence rhythm label", async () => {
  const compact = await readFile(new URL("components/CompactRecitationEditor.tsx", root), "utf8");
  const full = await readFile(new URL("components/FullA4Editor.tsx", root), "utf8");
  const css = await readFile(new URL("app/globals.css", root), "utf8");
  const schema = await readFile(new URL("lib/recitation-schema.ts", root), "utf8");

  // 两个 Renderer 都读取同一个 sentence.rhythm + RHYTHM_LABELS，不重新推断
  assert.match(compact, /RHYTHM_LABELS\[block\.sentence\.rhythm\]/);
  assert.match(full, /RHYTHM_LABELS\[rhythm\]/);

  // Compact：编号区域竖排节奏（逐字竖排）
  assert.match(compact, /compact-rhythm-label/);
  assert.match(compact, /Array\.from\(RHYTHM_LABELS\[block\.sentence\.rhythm\]\)/);

  // Full：Scene Card 内节奏标签
  assert.match(full, /full-rhythm-label/);

  // 共用同一份 RHYTHM_LABELS 中文映射
  assert.match(schema, /轻快|凝重|舒缓|紧张|高亢|低沉/);

  // CSS：Compact 竖排（flex column），Full 卡片内绝对定位
  assert.match(css, /\.compact-rhythm-label\s*\{[\s\S]*?flex-direction: column/);
  assert.match(css, /\.full-rhythm-label\s*\{[\s\S]*?position: absolute/);
});
