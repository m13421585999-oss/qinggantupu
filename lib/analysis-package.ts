import type { RecitationAnalysisPackage } from "./recitation-schema";

export function buildChatGptAnalysisPrompt(analysis: RecitationAnalysisPackage): string {
  return `你是一名专业朗诵指导。请根据下面的真人参考朗诵声音事实，生成可人工编辑的朗诵控制谱 JSON。

必须遵守：
1. 不得修改、增删或改写正文；tokens 必须原样保留 index 与 char。
2. 重音是表达焦点，不等于单纯增大音量；结合语义、时值、音高、能量和前后反差判断。
3. 停顿分 short（/）与 long（///），实际声音和意群优先，标点仅作参考。
4. 拖音用 prolongations，依据 local_duration_ratio 的局部相对延长判断。
5. 语势只允许 peak / valley / rising / falling。每项包含 active_span、core_zone、strength（1/2/3）和 confidence；允许前平、局部变化、后平，不要把普通话单字声调误判为句级语势。
6. 句尾语调只允许 rising / falling / level，且与语势独立。
7. 节奏只允许 light / solemn / relaxed / tense / soaring / low。
8. 目标是约 80% 感知可信的初稿，不确定时降低 confidence，不要编造声音事实。

只返回一个 JSON 对象，不要解释，不要 Markdown。格式：
{
  "tokens": [{"index": 0, "char": "原字", "machine_pinyin": "...", "display_pinyin": "...", "start_ms": 0, "end_ms": 0}],
  "sentences": [{
    "text": "必须与分析包句子完全一致",
    "focus": [{"token_indexes": [0], "level": "primary"}],
    "pauses": [{"after_index": 0, "type": "short"}],
    "prolongations": [{"token_index": 0, "degree": 1}],
    "prosody": [{"type": "peak", "active_span": {"start": 0, "end": 0}, "core_zone": {"start": 0, "end": 0}, "strength": 2, "confidence": 0.8}],
    "ending_intonation": {"type": "falling", "strength": 1},
    "rhythm": {"type": "relaxed"},
    "confidence": 0.8
  }]
}

朗诵分析包：
${JSON.stringify(analysis, null, 2)}`;
}
