import assert from "node:assert/strict";
import test from "node:test";

import {
  HERO_LAYOUT_CONTRACT_MARKER,
  heroAuthorDisplay,
  withHeroProductionLayout,
  withHeroProductionNegativePrompt,
} from "../lib/hero-production-prompt.ts";

test("legacy Hero specs receive the deterministic safe typography layout", () => {
  const prompt = withHeroProductionLayout(
    "东方写意海边晨光",
    "面朝大海，春暖花开",
    "海子",
  );

  assert.match(prompt, /1500×280/);
  assert.match(prompt, /x=6%–43%/);
  assert.match(prompt, /题签.*y=18%–27%/);
  assert.match(prompt, /主标题位于 y=34%–60%/);
  assert.match(prompt, /作者行位于 y=70%–82%/);
  assert.match(prompt, /整行最大宽度约 550px/);
  assert.match(prompt, /作者行必须逐字写成“作者：海子”/);
  assert.match(prompt, /x=55%–96% 的右侧/);
  assert.equal(prompt.match(new RegExp(HERO_LAYOUT_CONTRACT_MARKER, "gu"))?.length, 1);
  assert.equal(
    withHeroProductionLayout(prompt, "面朝大海，春暖花开", "海子"),
    prompt,
  );
});

test("Hero author label and production exclusions are normalized", () => {
  assert.equal(heroAuthorDisplay("海子"), "作者：海子");
  assert.equal(heroAuthorDisplay("作者: 海子"), "作者：海子");
  assert.equal(heroAuthorDisplay(""), "");
  const negativePrompt = withHeroProductionNegativePrompt("水印");
  assert.match(negativePrompt, /标题贴顶/);
  assert.match(negativePrompt, /作者缺少作者前缀/);
  assert.match(negativePrompt, /左侧复杂主体/);
});
