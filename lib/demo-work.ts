import type {
  FocusTarget,
  RecitationSentence,
  RecitationWork,
  TimedToken,
} from "./recitation-schema";

const punctuation = new Set(["，", "。", "！", "？", "、", "；", "：", " "]);

function toneFromPinyin(pinyin: string): 0 | 1 | 2 | 3 | 4 {
  const last = Number(pinyin.at(-1));
  return last >= 1 && last <= 4 ? (last as 1 | 2 | 3 | 4) : 0;
}

function makeTokens(
  sentenceId: string,
  text: string,
  pinyin: string[],
  startMs: number,
  endMs: number,
): TimedToken[] {
  const chars = Array.from(text);
  const speakableCount = chars.filter((char) => !punctuation.has(char)).length;
  const unit = (endMs - startMs) / speakableCount;
  let spokenIndex = 0;
  let pinyinIndex = 0;

  return chars.map((char, index) => {
    const isPunctuation = punctuation.has(char);
    const tokenStart = startMs + spokenIndex * unit;
    const tokenEnd = isPunctuation ? tokenStart : tokenStart + unit;
    const tokenPinyin = isPunctuation ? undefined : pinyin[pinyinIndex++];
    if (!isPunctuation) spokenIndex += 1;

    return {
      id: `${sentenceId}-t${index + 1}`,
      char,
      pinyin: tokenPinyin?.replace(/[0-4]$/, ""),
      tone: tokenPinyin ? toneFromPinyin(tokenPinyin) : undefined,
      pronunciationSource: tokenPinyin ? "human" : undefined,
      startMs: Math.round(tokenStart),
      endMs: Math.round(tokenEnd),
      confidence: isPunctuation ? 1 : 0.94,
    };
  });
}

function tokenIdsForText(tokens: TimedToken[], target: string): string[] {
  const plain = tokens.map((token) => token.char).join("");
  const start = plain.indexOf(target);
  if (start < 0) return [];
  return tokens.slice(start, start + Array.from(target).length).map((token) => token.id);
}

function focus(
  sentenceId: string,
  tokens: TimedToken[],
  target: string,
  preferredRealization: FocusTarget["preferredRealization"],
): FocusTarget {
  return {
    id: `${sentenceId}-focus-1`,
    tokenIds: tokenIdsForText(tokens, target),
    level: "primary",
    preferredRealization,
    allowedRealizations: [preferredRealization, "combined", "slower"],
    avoid: ["shouting", "hard_break"],
  };
}

function sentence(
  input: Omit<RecitationSentence, "tokens" | "focus"> & {
    pinyin: string[];
    focusText: string;
    focusRealization: FocusTarget["preferredRealization"];
  },
): RecitationSentence {
  const tokens = makeTokens(
    input.id,
    input.text,
    input.pinyin,
    input.timeRange.startMs,
    input.timeRange.endMs,
  );

  return {
    ...input,
    tokens,
    focus: [focus(input.id, tokens, input.focusText, input.focusRealization)],
    prosody: {
      ...input.prosody,
      anchorTokenIds: tokenIdsForText(tokens, input.focusText),
    },
  };
}

const sentences: RecitationSentence[] = [
  sentence({
    id: "s001",
    order: 1,
    text: "我一直想为，月光下的中国，写一首诗。",
    pinyin: [
      "wo3",
      "yi4",
      "zhi2",
      "xiang3",
      "wei4",
      "yue4",
      "guang1",
      "xia4",
      "de0",
      "zhong1",
      "guo2",
      "xie3",
      "yi4",
      "shou3",
      "shi1",
    ],
    function: "入境与点题",
    rhythm: "relaxed",
    continuity: "connected",
    prosody: { type: "crest", strength: 2, anchorTokenIds: [] },
    endingTone: { type: "fall", strength: 1 },
    voiceQuality: { start: "breathy", transition: "mixed", end: "mixed" },
    pauses: [],
    prolongs: [],
    teachingCue: "从低位、克制地进入，在“月光下的中国”展开成波峰，最后轻轻落到“诗”。",
    avoid: ["不要把三个分句切断", "不要在波峰处喊叫"],
    confidence: 0.91,
    timeRange: { startMs: 0, endMs: 4250 },
    focusText: "月光下的中国",
    focusRealization: "combined",
  }),
  sentence({
    id: "s002",
    order: 2,
    text: "我喜欢她，宁静的样子。",
    pinyin: [
      "wo3",
      "xi3",
      "huan1",
      "ta1",
      "ning2",
      "jing4",
      "de0",
      "yang4",
      "zi0",
    ],
    function: "建立宁静意象",
    rhythm: "relaxed",
    continuity: "connected",
    prosody: { type: "falling", strength: 1, anchorTokenIds: [] },
    endingTone: { type: "fall", strength: 1 },
    voiceQuality: { start: "breathy", end: "breathy" },
    pauses: [],
    prolongs: [],
    teachingCue: "“宁静”用轻读形成焦点：声音收小、速度略慢，让听众主动靠近去听。",
    avoid: ["不要把轻读理解为含混", "不要突然停顿"],
    confidence: 0.88,
    timeRange: { startMs: 4250, endMs: 6710 },
    focusText: "宁静",
    focusRealization: "soft_emphasis",
  }),
  sentence({
    id: "s003",
    order: 3,
    text: "喜欢她温柔中的，强大力量。",
    pinyin: [
      "xi3",
      "huan1",
      "ta1",
      "wen1",
      "rou2",
      "zhong1",
      "de0",
      "qiang2",
      "da4",
      "li4",
      "liang4",
    ],
    function: "情感推进",
    rhythm: "relaxed",
    continuity: "connected",
    prosody: { type: "rising", strength: 2, anchorTokenIds: [] },
    endingTone: { type: "fall", strength: 1 },
    voiceQuality: {
      start: "breathy",
      transition: "breathy_to_mixed",
      end: "mixed",
    },
    pauses: [],
    prolongs: [],
    teachingCue: "前半句保留柔和气息，向“强大力量”增加支撑和重量，但不要突然变成硬实声。",
    avoid: ["不要直接砸重音", "不要从气声突然切成喊声"],
    confidence: 0.9,
    timeRange: { startMs: 6710, endMs: 9710 },
    focusText: "强大力量",
    focusRealization: "lower_weighted",
  }),
  sentence({
    id: "s004",
    order: 4,
    text: "在夜色里，她，银装素裹。",
    pinyin: [
      "zai4",
      "ye4",
      "se4",
      "li3",
      "ta1",
      "yin2",
      "zhuang1",
      "su4",
      "guo3",
    ],
    function: "画面展开与收束",
    rhythm: "relaxed",
    continuity: "balanced",
    prosody: { type: "falling", strength: 2, anchorTokenIds: [] },
    endingTone: { type: "fall", strength: 2 },
    voiceQuality: { start: "mixed", transition: "breathy", end: "breathy" },
    pauses: [],
    prolongs: [
      {
        id: "s004-prolong-1",
        tokenId: "s004-t11",
        degree: 1,
        purpose: "留下画面余韵",
      },
    ],
    teachingCue: "拉开夜色的空间感，“银装素裹”放慢、收小，句尾留下余韵。",
    avoid: ["不要读得过满", "句尾不要突然截断"],
    confidence: 0.86,
    timeRange: { startMs: 9710, endMs: 12438 },
    focusText: "银装素裹",
    focusRealization: "slower",
  }),
];

export const DEMO_WORK: RecitationWork = {
  id: "work-moonlight-demo",
  slug: "moonlight-china-sample",
  title: "月光下的中国",
  author: "演示片段",
  genre: "modern_poetry",
  language: "zh-CN",
  sourceText: sentences.map((item) => item.text).join("\n"),
  status: "review",
  currentSpecVersionId: "spec-moonlight-v1",
  audio: {
    id: "audio-demo-v1",
    url: "/demo-recitation.m4a",
    durationMs: 12438,
    provider: "demo",
    label: "本机中文声音 · 开发占位",
  },
  controlSpec: {
    schemaVersion: "1.0",
    id: "spec-moonlight-v1",
    workId: "work-moonlight-demo",
    version: 1,
    source: "hybrid",
    documentProfile: {
      deliveryMode: "lyrical_recitation",
      recitationDegree: 2,
      baseRhythm: "relaxed",
      emotionalTone: ["宁静", "温暖", "克制"],
      energy: "low_to_medium",
      control: "high",
      interactionDistance: "intimate",
      voiceQuality: "breathy_to_mixed",
      globalArc: ["入境", "展开", "增强", "收束"],
    },
    sentences,
    analysisProvenance: {
      referenceAudioAssetId: "asset-reference-demo",
      knowledgeAssetIds: ["asset-knowledge-demo"],
      pipelineVersion: "vertical-slice-0.1",
      alignmentModel: "demo-timeline",
      acousticModel: "demo-features",
      languageModel: "human-reviewed-example",
      generatedAt: "2026-08-09T08:00:00.000Z",
    },
    validation: {
      state: "valid",
      issues: [],
    },
    createdAt: "2026-08-09T08:00:00.000Z",
  },
  createdAt: "2026-08-09T08:00:00.000Z",
  updatedAt: "2026-08-09T08:00:00.000Z",
};

export function cloneDemoWork(): RecitationWork {
  return structuredClone(DEMO_WORK);
}
