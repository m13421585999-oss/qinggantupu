import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  findSceneAssetForSentence,
  findSceneSpecForSentence,
  mapSceneAssetsToSentences,
} from "../lib/visual-assets.ts";

function scene(overrides = {}) {
  return {
    sceneId: "scene-1",
    sourceSentenceIds: [],
    sourceText: "从明天起，做一个幸福的人。",
    narrativeFunction: "opening",
    visualType: "environment",
    sceneSummary: "晨光中的新生活",
    mainSubject: "晨光",
    environment: "海边",
    emotion: ["明亮"],
    symbolism: ["新生"],
    composition: "left blank",
    cameraDistance: "wide",
    lighting: "morning",
    palette: ["blue"],
    imagePrompt: "prompt",
    negativePrompt: "text",
    ...overrides,
  };
}

function asset(overrides = {}) {
  return {
    id: "asset-1",
    workId: "work-1",
    kind: "scene",
    sceneId: "scene-1",
    url: "/api/assets/asset-1",
    provider: "openai_compatible",
    model: "gpt-image-2",
    status: "ready",
    isVisible: true,
    isActive: true,
    version: 1,
    width: 768,
    height: 576,
    createdAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

test("scene generated before analysis attaches by authoritative source text", () => {
  const spec = scene();
  const sentence = { id: "sentence-17", text: "从明天起，做一个幸福的人。" };

  assert.equal(findSceneSpecForSentence([spec], sentence), spec);
  assert.equal(findSceneAssetForSentence({
    sceneSpecs: [spec],
    assets: [asset()],
    sceneAssets: [asset()],
  }, sentence)?.id, "asset-1");
});

test("one Scene image attaches to every control sentence contained in that Scene", () => {
  const spec = scene({ sourceText: "从明天起，做一个幸福的人。喂马、劈柴，周游世界。" });
  const visuals = { sceneSpecs: [spec], assets: [asset()], sceneAssets: [asset()] };

  assert.equal(findSceneAssetForSentence(
    visuals,
    { id: "sentence-a", text: "从明天起，做一个幸福的人。" },
  )?.sceneId, "scene-1");
  assert.equal(findSceneAssetForSentence(
    visuals,
    { id: "sentence-b", text: "喂马、劈柴，周游世界。" },
  )?.sceneId, "scene-1");
});

test("repeated source text attaches to Scenes in order instead of reusing the first image", () => {
  const repeatedText = "抬眼已是半生。";
  const sceneOne = scene({ sceneId: "scene-1", sourceText: repeatedText });
  const sceneTwo = scene({ sceneId: "scene-2", sourceText: repeatedText });
  const assetOne = asset({ id: "asset-1", sceneId: "scene-1" });
  const assetTwo = asset({ id: "asset-2", sceneId: "scene-2" });
  const mapping = mapSceneAssetsToSentences({
    sceneSpecs: [sceneOne, sceneTwo],
    assets: [assetOne, assetTwo],
    sceneAssets: [assetOne, assetTwo],
  }, [
    { id: "sentence-1", text: repeatedText },
    { id: "sentence-2", text: repeatedText },
  ]);

  assert.equal(mapping.get("sentence-1")?.id, "asset-1");
  assert.equal(mapping.get("sentence-2")?.id, "asset-2");
});

test("explicit sentence ids still take precedence and hidden or failed assets stay detached", () => {
  const explicit = scene({
    sceneId: "scene-explicit",
    sourceSentenceIds: ["sentence-2"],
    sourceText: "另一段文字。",
  });
  assert.equal(
    findSceneSpecForSentence([scene(), explicit], { id: "sentence-2", text: "不匹配的文本" }),
    explicit,
  );

  const visuals = {
    sceneSpecs: [explicit],
    assets: [],
    sceneAssets: [
      asset({ id: "failed", sceneId: "scene-explicit", status: "failed", version: 3 }),
      asset({ id: "hidden", sceneId: "scene-explicit", isVisible: false, version: 2 }),
    ],
  };
  assert.equal(findSceneAssetForSentence(visuals, { id: "sentence-2", text: "不匹配的文本" }), undefined);
});

test("fresh visuals loaded by the editor sheet are propagated back to the manuscript", async () => {
  const panel = await readFile(
    new URL("../components/WorkVisualPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(panel, /onVisualsChangeRef\.current\?\.\(bundle\)/);
});
