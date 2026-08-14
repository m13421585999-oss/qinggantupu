export const HERO_LAYOUT_CONTRACT_MARKER = "【Hero 成品排版硬约束 v2】";

export function heroAuthorDisplay(author: string) {
  const name = author.trim().replace(/^作者\s*[:：]\s*/u, "").trim();
  return name ? `作者：${name}` : "";
}

/**
 * Adds the final-production layout contract at the last possible point before
 * image generation. This also upgrades regeneration from previously saved
 * Hero specs without asking the user to create a new visual plan.
 */
export function withHeroProductionLayout(basePrompt: string, title: string, author: string) {
  if (basePrompt.includes(HERO_LAYOUT_CONTRACT_MARKER)) return basePrompt;
  const authorDisplay = heroAuthorDisplay(author);
  const exactLines = ["朗诵情感图谱", title, ...(authorDisplay ? [authorDisplay] : [])]
    .map((line) => `“${line}”`)
    .join("；");
  const authorRule = authorDisplay
    ? `作者行必须逐字写成“${authorDisplay}”，必须包含“作者：”前缀。`
    : "不得虚构作者行。";
  return `${basePrompt.trim()}\n\n${HERO_LAYOUT_CONTRACT_MARKER}\n`
    + "这是最终显示为 1500×280 的超宽作品封面。所有必需文字必须组成左侧文字组，完整落在 x=6%–43% 的安全区内；"
    + "左侧至少留 70px，顶部和底部至少留 32px，任何笔画、书名号都不得贴边或越界。"
    + "小题签“朗诵情感图谱”位于 y=18%–27%，主标题位于 y=34%–60%，作者行位于 y=70%–82%。"
    + `只允许逐字准确呈现这些文字：${exactLines}。`
    + "主标题使用清楚、有艺术感但可辨认的中文标题字，整行最大宽度约 550px；"
    + "字号必须自适应以保持标题单行完整，不得断行、截字或缺字。"
    + authorRule
    + "左侧保持干净、低对比和充分留白，不放房屋、人物、树枝等主体，也不要让纹理压住文字。"
    + "作品意象和高对比视觉主体集中在 x=55%–96% 的右侧，左右形成清楚的‘左文右景’构图。"
    + "禁止把标题放在画布顶部，禁止任何文字被裁切，禁止额外文字、随机汉字、按钮、徽标和水印。";
}

export function withHeroProductionNegativePrompt(basePrompt: string) {
  const productionAvoid = "标题贴顶，标题越界，文字裁切，残缺汉字，标题断行，作者缺少作者前缀，"
    + "左侧复杂主体，主体压住文字，中央主体，随机文字，按钮，徽标，水印";
  const normalized = basePrompt.trim();
  return normalized ? `${normalized}，${productionAvoid}` : productionAvoid;
}
