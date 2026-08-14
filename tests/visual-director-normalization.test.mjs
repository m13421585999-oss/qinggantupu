import assert from "node:assert/strict";
import test from "node:test";

import { normalizeVisualDirectorOutput } from "../lib/visual-director.ts";

const hero = {
  type: "hero",
  size: { width: 1500, height: 420 },
  required_text: ["标题", "作者", "朗诵情感图谱"],
  text_layout: "左文右景",
  visual_subject: "海面",
  composition: "留白",
  lighting: "晨光",
  palette: ["雾蓝"],
  image_prompt: "prompt",
  negative_prompt: "watermark",
};

test("rolling old visual-director fields normalize to the current contract", () => {
  const result = normalizeVisualDirectorOutput({
    work_visual_profile: {
      visual_style: "东方写意",
      palette: ["雾蓝"],
      texture: "宣纸",
      lighting: "晨光",
      atmosphere: "开阔",
      composition_rule: "大面积留白",
      human_presence: "弱人物",
      symbolic_elements: ["海", "花"],
      avoid: ["水印"],
    },
    hero_visual_spec: hero,
    scene_visual_specs: [{ scene_id: "scene-1", scene_summary: "面向新生活" }],
  });

  assert.equal(result.work_visual_profile.composition_language, "大面积留白");
  assert.deepEqual(result.work_visual_profile.symbolic_language, ["海", "花"]);
  assert.equal(result.scene_visual_specs[0].scene_meaning, "面向新生活");
  assert.deepEqual(result.hero_visual_spec.size, { width: 1500, height: 280 });
});

test("current fields take precedence over deprecated aliases", () => {
  const result = normalizeVisualDirectorOutput({
    work_visual_profile: {
      composition_language: "新构图语言",
      composition_rule: "旧构图规则",
      symbolic_language: ["新象征"],
      symbolic_elements: ["旧象征"],
    },
    hero_visual_spec: hero,
    scene_visual_specs: [{
      scene_id: "scene-1",
      scene_meaning: "新场景含义",
      scene_summary: "旧场景摘要",
    }],
  });

  assert.equal(result.work_visual_profile.composition_language, "新构图语言");
  assert.deepEqual(result.work_visual_profile.symbolic_language, ["新象征"]);
  assert.equal(result.scene_visual_specs[0].scene_meaning, "新场景含义");
});
