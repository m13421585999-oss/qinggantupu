// batch/rerun-1-4.mjs
// 返工 Work 1-4：只重新跑 Text Recitation 分析（当前 sparse focus 规则），
// 不重新生成任何图片；校验 Sentence 数/文本不变；统计新旧 focus 密度。
// 用法: node batch/rerun-1-4.mjs
import { createTextRecitation, getWork } from "./api.mjs";
import { loadState, saveState } from "./state.mjs";

const WORKS = [
  { index: 1, title: "定风波·莫听穿林打叶声" },
  { index: 2, title: "念奴娇·赤壁怀古（节选）" },
  { index: 3, title: "水调歌头·明月几时有（节选）" },
  { index: 4, title: "春江花月夜（节选）" },
];

function countFocus(spec) {
  const sentences = spec?.sentences ?? [];
  const withFocus = sentences.filter((s) => (s.focus ?? []).length > 0).length;
  const spans = sentences.reduce((n, s) => n + (s.focus ?? []).length, 0);
  return { sentences: sentences.length, withFocus, spans };
}

function sentenceFingerprint(spec) {
  return (spec?.sentences ?? []).map((s) => s.text).join("|");
}

async function main() {
  const state = loadState();
  for (const work of WORKS) {
    const entry = state[work.index];
    const workId = entry.workId;
    console.log(`\n========== [${work.index}] 《${work.title}》==========`);
    console.log(`workId: ${workId}`);

    // 1. 旧版 focus 统计
    const before = await getWork(workId);
    const oldSpec = before.work?.controlSpec;
    const oldFocus = countFocus(oldSpec);
    console.log(`old: ${oldFocus.sentences} sentences / ${oldFocus.withFocus} focus sentences / ${oldFocus.spans} focus spans`);

    // 2. 重新分析（POST 同步，可能 5 分钟）
    console.log("重新分析 Text Recitation…");
    const done = await createTextRecitation(workId);
    const newSpec = done.work?.controlSpec;
    if (!newSpec) throw new Error(`[${work.index}] 重新分析后无 control_spec`);

    // 3. 校验 Sentence 完全不变
    const oldFp = sentenceFingerprint(oldSpec);
    const newFp = sentenceFingerprint(newSpec);
    if (oldFp !== newFp) {
      throw new Error(`[${work.index}] Sentence 文本/顺序发生变化！禁止返回工`);
    }
    if ((newSpec.sentences ?? []).length !== oldFocus.sentences) {
      throw new Error(`[${work.index}] Sentence 数变化: ${oldFocus.sentences} -> ${newSpec.sentences.length}`);
    }

    // 4. 新版 focus 统计
    const newFocus = countFocus(newSpec);
    console.log(`new: ${newFocus.sentences} sentences / ${newFocus.withFocus} focus sentences / ${newFocus.spans} focus spans`);
    console.log(`校验通过: Sentence 100% 不变, focus 密度 ${newFocus.spans <= oldFocus.spans ? "降低/持平" : "异常升高"}`);

    // 5. 更新 state（分析已就绪，保持 visualJobId/场景不变）
    entry.analysisReady = true;
    entry.sentenceCount = newFocus.sentences;
    entry.status = entry.status === "completed" ? "completed" : entry.status;
    saveState(state);
  }
  console.log("\nWork 1-4 返工分析完成。");
}

main().catch((err) => {
  console.error("返工失败:", err.message);
  process.exit(1);
});
