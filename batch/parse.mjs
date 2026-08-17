// batch:parse — parse batch-input.txt and report stats WITHOUT calling GPT or
// generating images. Validates every non-empty line has <= 10 han chars.
import { readBatchInput, parseBatchInput } from "./parser.mjs";

const IMAGE_COST_YUAN = 0.04;

const works = parseBatchInput(readBatchInput());
const totalSentences = works.reduce((sum, w) => sum + w.sentenceCount, 0);
const estimatedImages = totalSentences;
const estimatedCost = estimatedImages * IMAGE_COST_YUAN;

console.log("作品总数:", works.length);
console.log("总 Sentence 数(非空正文行):", totalSentences);
console.log("预计图片数:", estimatedImages);
console.log(`预计图片费用(按 ${IMAGE_COST_YUAN} 元/张): ¥${estimatedCost.toFixed(2)}`);
console.log("");
console.log("逐篇明细:");
for (const w of works) {
  console.log(
    `  ${String(w.index).padStart(3)}. 《${w.title}》${w.author ? "——" + w.author : ""} | 非空行 ${w.sentenceCount} | 第${w.index}篇hash ${w.sourceHash}`,
  );
}

// Over-length check: any line with more than 10 han chars.
const tooLong = [];
for (const w of works) {
  w.nonEmptyLines.forEach((line, i) => {
    const han = (line.match(/[\u3400-\u9fff]/gu) || []).length;
    if (han > 10) tooLong.push({ index: w.index, title: w.title, line: i + 1, han, text: line });
  });
}

console.log("");
if (tooLong.length) {
  console.log(`发现 ${tooLong.length} 行超过 10 个汉字（只报告，不修改）：`);
  for (const t of tooLong) {
    console.log(`  [${t.index}] 《${t.title}》 第${t.line}行 汉字数${t.han}: ${t.text.slice(0, 40)}`);
  }
  process.exit(1);
} else {
  console.log("所有非空行汉字数 <= 10，校验通过。");
  console.log("READY FOR BATCH");
}
