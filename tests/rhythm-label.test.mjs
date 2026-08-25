import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isRhythm, rhythmLabel } from "../lib/recitation-schema.ts";

const root = new URL("../", import.meta.url);

test("compact and full both render the shared sentence rhythm label defensively", async () => {
  const compact = await readFile(new URL("components/CompactRecitationEditor.tsx", root), "utf8");
  const full = await readFile(new URL("components/FullA4Editor.tsx", root), "utf8");
  const css = await readFile(new URL("app/globals.css", root), "utf8");
  const schema = await readFile(new URL("lib/recitation-schema.ts", root), "utf8");

  // 两个 Renderer 都通过 rhythmLabel 读取 rhythm，不再直接索引 RHYTHM_LABELS
  assert.match(compact, /rhythm=\{sentence\.rhythm\}/);
  assert.match(compact, /rhythmLabel\(rhythm\)/);
  assert.match(full, /rhythmLabel\(rhythm\)/);

  // Compact：编号区域竖排节奏（逐字竖排），未知节奏显示「未标」
  assert.match(compact, /compact-rhythm-label/);
  assert.match(compact, /Array\.from\(label \?\? "未标"\)/);
  assert.match(compact, /"未标"/);
  assert.match(compact, /COMPACT_RHYTHM_OPTIONS/);
  assert.match(compact, /aria-label="六种节奏"/);
  assert.match(compact, /onSelectRhythm/);
  assert.match(compact, /onSentenceChange\(\{ \.\.\.selectedRhythmSentence, rhythm \}\)/);

  // Full：Scene Card 内节奏标签，未知节奏显示「未标」
  assert.match(full, /full-rhythm-label/);
  assert.match(full, /"未标"/);

  // 共用同一份 RHYTHM_LABELS 中文映射
  assert.match(schema, /轻快|凝重|舒缓|紧张|高亢|低沉/);

  // CSS：Compact 竖排（flex column），Full 卡片内绝对定位
  assert.match(css, /\.compact-rhythm-label\s*\{[\s\S]*?flex-direction: column/);
  assert.match(css, /\.compact-rhythm-label\s*\{[\s\S]*?cursor: pointer/);
  assert.match(css, /\.compact-rhythm-option-grid\s*\{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.full-rhythm-label\s*\{[\s\S]*?position: absolute/);
});

test("rhythmLabel resolves the six legal rhythms and rejects unknown shapes", () => {
  assert.equal(rhythmLabel("light"), "轻快");
  assert.equal(rhythmLabel("solemn"), "凝重");
  assert.equal(rhythmLabel("relaxed"), "舒缓");
  assert.equal(rhythmLabel("tense"), "紧张");
  assert.equal(rhythmLabel("soaring"), "高亢");
  assert.equal(rhythmLabel("low"), "低沉");

  // Legacy nested object, Chinese label, missing and empty must not resolve.
  assert.equal(rhythmLabel({ type: "relaxed" }), undefined);
  assert.equal(rhythmLabel("舒缓"), undefined);
  assert.equal(rhythmLabel(undefined), undefined);
  assert.equal(rhythmLabel(null), undefined);
  assert.equal(rhythmLabel(""), undefined);
  assert.equal(rhythmLabel("not-a-rhythm"), undefined);

  assert.equal(isRhythm("relaxed"), true);
  assert.equal(isRhythm("舒缓"), false);
  assert.equal(isRhythm({ type: "relaxed" }), false);
});
