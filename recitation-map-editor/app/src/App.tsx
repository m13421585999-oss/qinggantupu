import React, { useMemo, useState } from 'react';
import { pinyin } from 'pinyin-pro';

type VoiceLevel = 'low' | 'mid_low' | 'mid' | 'mid_high' | 'high';
type EmphasisMethod = 'strong' | 'light' | 'extend';
type EditorTab = 'text' | 'pinyin' | 'prosody';

type Token = {
  id: string;
  text: string;
  pinyin: string;
  punctAfter: string;
  pauseAfter: '' | '/' | '//' | '///';
  breathAfter: boolean;
  isEmphasis: boolean;
  methods: EmphasisMethod[];
  group: string;
};

type ProsodyPoint = {
  id: string;
  level: VoiceLevel;
  tokenIndex: number;
};

type Segment = {
  id: string;
  theme: string;
  rhythm: string;
  prosodyType: string;
  tone: string;
  tokens: Token[];
  prosody: ProsodyPoint[];
};

type Line = {
  segmentId: string;
  segmentTheme: string;
  rhythm: string;
  prosodyType: string;
  tone: string;
  lineIndex: number;
  lineNo: number;
  startIndex: number;
  endIndex: number;
  tokens: Token[];
  prosody: ProsodyPoint[];
};

type PageDensity = 'expanded' | 'standard' | 'compact';

type PageLayoutMetrics = {
  density: PageDensity;
  label: string;
  lineMinHeightMm: number;
  pinyinRowMm: number;
  textRowMm: number;
  prosodyRowMm: number;
  pinyinSizePt: number;
  hanziSizePt: number;
  prosodySvgMm: number;
  cardGapMm: number;
};

type ActiveSelection = {
  segmentId: string;
  tokenId?: string;
  tokenIndex?: number;
  prosodyIndex?: number;
  tab: EditorTab;
  x: number;
  y: number;
};

const PUNCTUATION = new Set(['，', '。', '、', '；', '：', '！', '？', ',', '.', ';', ':', '!', '?']);
const AUTO_PUNCTUATION_TO_PAUSE = true;
const CHARS_PER_LINE_TARGET = 18;
const MAX_LINES_PER_PAGE = 8;
const TOKEN_BODY_MM = 7.8;
const TOKEN_GAP_MM = 1.25;
const MAX_PROSODY_WIDTH_MM = 156;

type ProsodyDisplayPoint = {
  id: string;
  level: VoiceLevel;
  tokenIndex: number;
  globalIndex: number;
  displayValue: number;
  isVirtual?: boolean;
};

function estimateTokenWidthMm(token: Token): number {
  let width = TOKEN_BODY_MM;
  if (token.methods.includes('extend')) width += 5.8;
  if (token.breathAfter) width += 2.2;
  if (token.punctAfter) width += Math.min(5, token.punctAfter.length * 2.2);
  if (token.pauseAfter) width += token.pauseAfter.length * 1.7;
  return width;
}

function estimateLineWidthMm(tokens: Token[]): number {
  if (!tokens.length) return 30;
  const tokenWidths = tokens.reduce((sum, token) => sum + estimateTokenWidthMm(token), 0);
  const gapWidths = Math.max(0, tokens.length - 1) * TOKEN_GAP_MM;
  return Math.min(MAX_PROSODY_WIDTH_MM, Math.max(24, tokenWidths + gapWidths));
}

const levelY: Record<VoiceLevel, number> = {
  high: 0.08,
  mid_high: 0.25,
  mid: 0.45,
  mid_low: 0.65,
  low: 0.84,
};

const levelValue: Record<VoiceLevel, number> = {
  low: 1,
  mid_low: 2,
  mid: 3,
  mid_high: 4,
  high: 5,
};

const levelLabel: Record<VoiceLevel, string> = {
  high: '高',
  mid_high: '中高',
  mid: '中',
  mid_low: '中低',
  low: '低',
};

const levelOrder: VoiceLevel[] = ['low', 'mid_low', 'mid', 'mid_high', 'high'];

function extractTitleAndBody(raw: string): { title: string; body: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { title: '', body: '' };
  const lines = trimmed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? '';
  const bracketTitle = firstLine.match(/^《([^》]{1,40})》\s*$/) || firstLine.match(/^《([^》]{1,40})》/);
  if (bracketTitle) {
    const bodyLines = firstLine.replace(/^《[^》]{1,40}》\s*/, '').trim()
      ? [firstLine.replace(/^《[^》]{1,40}》\s*/, '').trim(), ...lines.slice(1)]
      : lines.slice(1);
    return { title: bracketTitle[1], body: bodyLines.join('\n') };
  }
  return { title: '', body: trimmed };
}

function splitSegments(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];

  // A4 打印版改回“手动换行优先”。
  // 用户在输入框中主动换行时，每一行就是一个优先保留的图谱行/片段；
  // 系统不再为了提高行宽利用率，把多行强行拼成一行。
  const blankSplit = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (blankSplit.length > 1) return blankSplit;

  const lineSplit = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lineSplit.length > 1) return lineSplit;

  // 没有手动换行时，恢复之前的自动句读切分方式，先按句子生成初始片段。
  const sentenceSplit = text.match(/[^。！？!?]+[。！？!?]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  return sentenceSplit.length ? sentenceSplit : [text];
}

function getTheme(text: string): string {
  if (/北国|冰封|雪飘|长城|大河|山舞|银蛇|蜡象|天公|红装素裹/.test(text)) return '北国壮景';
  if (/江山|英雄|秦皇|汉武|唐宗|宋祖|成吉思汗|风流人物|今朝/.test(text)) return '英雄评说';
  if (/喂马|劈柴|周游/.test(text)) return '自由生活';
  if (/粮食|蔬菜|关心/.test(text)) return '日常踏实';
  if (/幸福|明天|开始/.test(text)) return '温暖开始';
  if (/祖国|山河|人民|中华/.test(text)) return '家国深情';
  const clean = text.replace(/[，。、；：！？!?\s]/g, '');
  return clean.slice(0, 4) || '朗诵片段';
}

function guessRhythm(text: string): string {
  if (/弯弓|大雕|竞折腰|试比高|风流人物|今朝/.test(text)) return '昂扬推进';
  if (/北国|千里|万里|长城|大河|山舞|原驰/.test(text)) return '稳健铺陈';
  if (/惜|略输|稍逊|只识/.test(text)) return '沉稳转折';
  if (/须晴日|红装素裹|分外妖娆/.test(text)) return '舒展放缓';
  if (/喂马|劈柴|周游|奔跑|快乐/.test(text)) return '轻快';
  if (/安静|温暖|幸福|春暖|关心/.test(text)) return '舒缓';
  return text.length > 25 ? '平稳推进' : '平稳';
}

function guessTone(text: string): string {
  if (/北国|千里|万里|长城|大河|山舞|原驰|天公|比高/.test(text)) return '庄重有力';
  if (/红装素裹|分外妖娆/.test(text)) return '赞叹舒展';
  if (/江山|多娇|英雄|竞折腰/.test(text)) return '开阔豪迈';
  if (/惜|略输|稍逊|只识/.test(text)) return '评说惋惜';
  if (/俱往矣|风流人物|今朝/.test(text)) return '自信坚定';
  if (/幸福|温暖|春暖/.test(text)) return '温和明朗';
  return '自然表达';
}

function guessProsody(text: string): { type: string; points: VoiceLevel[] } {
  if (/俱往矣|风流人物|今朝/.test(text)) return { type: '起潮型', points: ['low', 'mid_low', 'mid_high', 'high'] };
  if (/江山|英雄|竞折腰/.test(text)) return { type: '推进型', points: ['low', 'mid', 'mid_high', 'high'] };
  if (/一代天骄|成吉思汗|大雕/.test(text)) return { type: '波峰型', points: ['mid_low', 'mid_high', 'high', 'mid'] };
  if (/惜|略输|稍逊|只识/.test(text)) return { type: '评说型', points: ['mid_low', 'mid', 'mid_low', 'mid'] };
  if (/须晴日|红装素裹|分外妖娆/.test(text)) return { type: '舒展型', points: ['low', 'mid', 'mid_high', 'mid_high'] };
  if (/山舞|银蛇|原驰|蜡象|天公|比高/.test(text)) return { type: '昂扬型', points: ['mid_low', 'mid', 'mid_high', 'high'] };
  if (/大河上下|顿失滔滔/.test(text)) return { type: '波峰型', points: ['low', 'mid', 'high', 'mid_high'] };
  if (/望长城|惟余莽莽/.test(text)) return { type: '起潮型', points: ['low', 'mid_low', 'mid_high', 'mid_high'] };
  if (/北国|千里|万里|冰封|雪飘/.test(text)) return { type: '起潮型', points: ['low', 'mid_low', 'mid_high', 'high'] };
  if (/低|收|落|沉|远去|结束/.test(text)) return { type: '落潮型', points: ['high', 'mid_high', 'mid', 'low'] };
  if (/高|起|上|豪|壮|希望/.test(text)) return { type: '起潮型', points: ['low', 'mid_low', 'mid_high', 'high'] };
  if (/幸福|温暖|春暖|面朝/.test(text)) return { type: '波峰型', points: ['low', 'mid', 'high', 'mid_low'] };
  return { type: '平稳型', points: ['mid_low', 'mid', 'mid', 'mid_low'] };
}

function makeProsodyPoints(levels: VoiceLevel[], tokenCount: number, segmentId: string): ProsodyPoint[] {
  const maxTokenIndex = Math.max(0, tokenCount - 1);
  return levels.map((level, i) => {
    const ratio = levels.length <= 1 ? 0.5 : i / (levels.length - 1);
    return {
      id: `${segmentId}-p${i + 1}`,
      level,
      tokenIndex: Math.round(ratio * maxTokenIndex),
    };
  });
}

function sortProsody(points: ProsodyPoint[]): ProsodyPoint[] {
  return [...points].sort((a, b) => a.tokenIndex - b.tokenIndex);
}

function tokenize(text: string, segId: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  for (const ch of text.replace(/\s/g, '')) {
    if (PUNCTUATION.has(ch)) {
      const prev = tokens[tokens.length - 1];
      if (prev) {
        // A4 打印版规则：标准标点不再作为可见字符显示，而是统一转成停顿“/”。
        // 这样文稿行更干净，也避免标点、拼音和技法符号产生错位。
        if (AUTO_PUNCTUATION_TO_PAUSE) {
          prev.punctAfter = '';
          prev.pauseAfter = '/';
        } else {
          prev.punctAfter += ch;
          prev.pauseAfter = '/';
        }
      }
      continue;
    }
    const py = pinyin(ch, { toneType: 'symbol', type: 'array' })[0] || '';
    tokens.push({
      id: `${segId}-${index}`,
      text: ch,
      pinyin: py,
      punctAfter: '',
      pauseAfter: '',
      breathAfter: false,
      isEmphasis: false,
      methods: [],
      group: ch,
    });
    index += 1;
  }
  // Basic emphasis and breath heuristics for MVP.
  const joined = tokens.map((t) => t.text).join('');
  const markWord = (word: string, methods: EmphasisMethod[]) => {
    const start = joined.indexOf(word);
    if (start < 0) return;
    for (let i = 0; i < word.length; i += 1) {
      const token = tokens[start + i];
      if (!token) continue;
      token.isEmphasis = true;
      token.methods = i === word.length - 1 && methods.includes('extend') ? methods : methods.filter((m) => m !== 'extend');
      token.group = word;
    }
  };
  ['天公', '比高', '风光', '冰封', '雪飘', '银蛇', '蜡象', '妖娆', '江山', '英雄', '秦皇汉武', '唐宗宋祖', '成吉思汗', '风流人物', '今朝', '幸福', '喂马', '劈柴', '粮食', '蔬菜'].forEach((w) => {
    if (/妖娆|风流人物|今朝|幸福|蔬菜/.test(w)) markWord(w, ['light', 'extend']);
    else markWord(w, ['strong']);
  });
  tokens.forEach((t) => {
    if (t.pauseAfter === '/' && !t.breathAfter) t.breathAfter = true;
  });
  return tokens;
}

function generateSegments(raw: string): Segment[] {
  return splitSegments(raw).map((text, i) => {
    const id = String(i + 1).padStart(2, '0');
    const prosody = guessProsody(text);
    const tokens = tokenize(text, id);
    return {
      id,
      theme: getTheme(text),
      rhythm: guessRhythm(text),
      prosodyType: prosody.type,
      tone: guessTone(text),
      tokens,
      prosody: makeProsodyPoints(prosody.points, tokens.length, id),
    };
  });
}

function findBreakIndex(tokens: Token[], start: number, maxChars: number): number {
  const end = Math.min(tokens.length, start + maxChars);
  if (end >= tokens.length) return tokens.length;
  for (let i = end - 1; i > start + Math.floor(maxChars * 0.55); i -= 1) {
    const t = tokens[i];
    if (t.punctAfter || t.pauseAfter) return i + 1;
  }
  for (let i = end - 1; i > start + Math.floor(maxChars * 0.55); i -= 1) {
    if (tokens[i].group !== tokens[i + 1]?.group) return i + 1;
  }
  return end;
}

function buildLines(segments: Segment[], maxChars = CHARS_PER_LINE_TARGET): Line[] {
  const lines: Line[] = [];
  let globalLineNo = 1;
  segments.forEach((segment) => {
    let start = 0;
    let lineIndex = 0;
    while (start < segment.tokens.length) {
      const end = findBreakIndex(segment.tokens, start, maxChars);
      lines.push({
        segmentId: segment.id,
        segmentTheme: segment.theme,
        rhythm: segment.rhythm,
        prosodyType: segment.prosodyType,
        tone: segment.tone,
        lineIndex,
        lineNo: globalLineNo,
        startIndex: start,
        endIndex: end,
        tokens: segment.tokens.slice(start, end),
        prosody: segment.prosody,
      });
      start = end;
      lineIndex += 1;
      globalLineNo += 1;
    }
  });
  return lines;
}

function splitBySizes<T>(items: T[], sizes: number[]): T[][] {
  const pages: T[][] = [];
  let cursor = 0;
  sizes.forEach((size) => {
    pages.push(items.slice(cursor, cursor + size));
    cursor += size;
  });
  return pages;
}

function buildCandidateSizes(totalLines: number, pageCount: number, maxLinesPerPage: number): number[][] {
  const candidates: number[][] = [];
  const current: number[] = [];
  const walk = (pageIndex: number, remaining: number) => {
    if (pageIndex === pageCount) {
      if (remaining === 0) candidates.push([...current]);
      return;
    }
    const pagesLeft = pageCount - pageIndex - 1;
    const minForRest = pagesLeft;
    const maxForCurrent = Math.min(maxLinesPerPage, remaining - minForRest);
    for (let size = 1; size <= maxForCurrent; size += 1) {
      const rest = remaining - size;
      if (rest > pagesLeft * maxLinesPerPage) continue;
      current.push(size);
      walk(pageIndex + 1, rest);
      current.pop();
    }
  };
  walk(0, totalLines);
  return candidates;
}

function getPageMetrics(lineCount: number): PageLayoutMetrics {
  if (lineCount <= 4) {
    return {
      density: 'expanded',
      label: '放大模式',
      lineMinHeightMm: 53,
      pinyinRowMm: 8.2,
      textRowMm: 16.4,
      prosodyRowMm: 20.4,
      pinyinSizePt: 7.7,
      hanziSizePt: 21.8,
      prosodySvgMm: 19.4,
      cardGapMm: 3.4,
    };
  }
  if (lineCount === 5) {
    return {
      density: 'expanded',
      label: '放大模式',
      lineMinHeightMm: 46.8,
      pinyinRowMm: 7.6,
      textRowMm: 15.0,
      prosodyRowMm: 18.0,
      pinyinSizePt: 7.35,
      hanziSizePt: 21.0,
      prosodySvgMm: 17.2,
      cardGapMm: 3.0,
    };
  }
  if (lineCount <= 7) {
    return {
      density: 'standard',
      label: '标准模式',
      lineMinHeightMm: lineCount === 6 ? 36.8 : 33.2,
      pinyinRowMm: lineCount === 6 ? 6.8 : 6.3,
      textRowMm: lineCount === 6 ? 13.0 : 12.0,
      prosodyRowMm: lineCount === 6 ? 13.6 : 11.4,
      pinyinSizePt: lineCount === 6 ? 6.75 : 6.35,
      hanziSizePt: lineCount === 6 ? 18.6 : 17.8,
      prosodySvgMm: lineCount === 6 ? 12.8 : 10.7,
      cardGapMm: 2.4,
    };
  }
  return {
    density: 'compact',
    label: '紧凑模式',
    lineMinHeightMm: 29.2,
    pinyinRowMm: 5.7,
    textRowMm: 10.5,
    prosodyRowMm: 9.3,
    pinyinSizePt: 5.85,
    hanziSizePt: 16.6,
    prosodySvgMm: 8.6,
    cardGapMm: 1.8,
  };
}

function scorePaginationSizes(sizes: number[], totalLines: number): number {
  const max = Math.max(...sizes);
  const min = Math.min(...sizes);
  const ideal = totalLines <= 12 ? 5.5 : 6.7;
  let score = 0;
  sizes.forEach((size) => {
    score += Math.abs(size - ideal) * 7;
    if (size < 4) score += 80;
    if (size === 8) score += 6;
    if (size >= 5 && size <= 7) score -= 12;
  });
  score += (max - min) * 10;
  score += sizes.length * 4;
  return score;
}

function smartPaginate<T>(items: T[], maxLinesPerPage: number): T[][] {
  if (items.length === 0) return [[]];
  const pageCount = Math.max(1, Math.ceil(items.length / maxLinesPerPage));
  if (pageCount === 1) return [items];
  const candidates = buildCandidateSizes(items.length, pageCount, maxLinesPerPage);
  const best = candidates.reduce((currentBest, candidate) => (
    scorePaginationSizes(candidate, items.length) < scorePaginationSizes(currentBest, items.length) ? candidate : currentBest
  ), candidates[0]);
  return splitBySizes(items, best);
}

function countReadableChars(segments: Segment[]): number {
  return segments.reduce((sum, segment) => sum + segment.tokens.length, 0);
}

function formatPaginationDistribution(pages: Line[][]): string {
  if (!pages.length || pages.every((page) => page.length === 0)) return '暂无分页';
  return pages.map((page, i) => {
    const metrics = getPageMetrics(page.length);
    return `第 ${i + 1} 页 ${page.length} 行·${metrics.label}`;
  }).join('｜');
}

function normalizeTitle(title: string): string {
  const clean = title.trim().replace(/[\-－–—]/g, '·').replace(/·+/g, '·');
  return clean || '未命名作品';
}


function getTokenIndex(tokenId?: string): number | undefined {
  if (!tokenId) return undefined;
  const parts = tokenId.split('-');
  const maybeIndex = Number(parts[parts.length - 1]);
  return Number.isFinite(maybeIndex) ? maybeIndex : undefined;
}

function nearestProsodyIndex(segment: Segment | undefined, tokenIndex?: number, fallback = 0): number {
  if (!segment || segment.prosody.length === 0) return fallback;
  if (tokenIndex === undefined) return Math.max(0, Math.min(fallback, segment.prosody.length - 1));
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  segment.prosody.forEach((point, i) => {
    const distance = Math.abs(point.tokenIndex - tokenIndex);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  });
  return bestIndex;
}


function interpolateProsodyValue(points: ProsodyPoint[], tokenIndex: number): number {
  const sorted = sortProsody(points);
  if (!sorted.length) return levelValue.mid;
  if (tokenIndex <= sorted[0].tokenIndex) return levelValue[sorted[0].level];
  const last = sorted[sorted.length - 1];
  if (tokenIndex >= last.tokenIndex) return levelValue[last.level];

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (tokenIndex === left.tokenIndex) return levelValue[left.level];
    if (tokenIndex === right.tokenIndex) return levelValue[right.level];
    if (tokenIndex > left.tokenIndex && tokenIndex < right.tokenIndex) {
      const leftValue = levelValue[left.level];
      const rightValue = levelValue[right.level];
      const ratio = (tokenIndex - left.tokenIndex) / Math.max(1, right.tokenIndex - left.tokenIndex);
      return leftValue + (rightValue - leftValue) * ratio;
    }
  }

  return levelValue[last.level];
}

function buildDisplayProsodyPoints(
  points: ProsodyPoint[],
  lineStartIndex: number,
  lineEndIndex: number,
): ProsodyDisplayPoint[] {
  const sorted = sortProsody(points);
  const lineLastTokenIndex = Math.max(lineStartIndex, lineEndIndex - 1);
  const lineMiddleTokenIndex = Math.round((lineStartIndex + lineLastTokenIndex) / 2);

  const actualVisible = sorted
    .map((point) => ({
      ...point,
      globalIndex: points.findIndex((item) => item.id === point.id),
      displayValue: levelValue[point.level],
    }))
    .filter((point) => point.tokenIndex >= lineStartIndex && point.tokenIndex < lineEndIndex);

  const sampledAnchors: ProsodyDisplayPoint[] = [lineStartIndex, lineMiddleTokenIndex, lineLastTokenIndex].map((tokenIndex, index) => ({
    id: `virtual-${lineStartIndex}-${tokenIndex}-${index}`,
    level: 'mid',
    tokenIndex,
    globalIndex: -1,
    displayValue: interpolateProsodyValue(sorted, tokenIndex),
    isVirtual: true,
  }));

  const byToken = new Map<number, ProsodyDisplayPoint>();
  sampledAnchors.forEach((point) => byToken.set(point.tokenIndex, point));
  actualVisible.forEach((point) => byToken.set(point.tokenIndex, point));

  return [...byToken.values()].sort((a, b) => a.tokenIndex - b.tokenIndex);
}



type XYPoint = { x: number; y: number };

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothProsodyCoordinates(points: XYPoint[], top: number, bottom: number): XYPoint[] {
  if (points.length <= 2) return points;
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return point;
    const previous = points[index - 1];
    const next = points[index + 1];
    return {
      x: point.x,
      y: clampNumber(point.y * 0.62 + previous.y * 0.19 + next.y * 0.19, top, bottom),
    };
  });
}

function naturalProsodyPath(points: XYPoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const point = points[0];
    return `M ${point.x.toFixed(1)} ${point.y.toFixed(1)} L ${(point.x + 14).toFixed(1)} ${point.y.toFixed(1)}`;
  }
  if (points.length === 2) {
    const [start, end] = points;
    const cp1x = start.x + (end.x - start.x) * 0.45;
    const cp2x = start.x + (end.x - start.x) * 0.55;
    return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${cp1x.toFixed(1)} ${start.y.toFixed(1)} ${cp2x.toFixed(1)} ${end.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
  }

  const commands: string[] = [`M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const current = points[index];
    const next = points[index + 1];
    const afterNext = points[Math.min(points.length - 1, index + 2)];
    const tension = 0.22;
    const cp1x = current.x + (next.x - previous.x) * tension;
    const cp1y = current.y + (next.y - previous.y) * tension;
    const cp2x = next.x - (afterNext.x - current.x) * tension;
    const cp2y = next.y - (afterNext.y - current.y) * tension;
    commands.push(`C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${next.x.toFixed(1)} ${next.y.toFixed(1)}`);
  }
  return commands.join(' ');
}

function ProsodyMini({
  points,
  segmentId,
  widthMm,
  heightMm,
  lineStartIndex,
  lineEndIndex,
  tokens,
  selectedIndex,
  prosodyType,
  showEditorHandles = false,
  onPointClick,
  onAreaClick,
}: {
  points: ProsodyPoint[];
  segmentId: string;
  widthMm: number;
  heightMm: number;
  lineStartIndex: number;
  lineEndIndex: number;
  tokens: Token[];
  selectedIndex?: number;
  prosodyType: string;
  showEditorHandles?: boolean;
  onPointClick?: (segmentId: string, index: number, position: { x: number; y: number }) => void;
  onAreaClick?: (segmentId: string, tokenIndex: number, position: { x: number; y: number }) => void;
}) {
  // The x position of each prosody point is anchored to the corresponding text token.
  // Stage 9.27: this mini graph is now built after pagination/page-density has decided
  // the final height of the “势” layer. The viewBox height follows that final layout
  // value, instead of drawing inside a fixed internal coordinate box and then scaling it.
  const height = Math.max(24, heightMm * 4);
  const width = Math.max(96, widthMm * 4);
  const topPadding = Math.max(0.8, height * 0.035);
  const bottomPadding = Math.max(0.8, height * 0.035);
  const usableTop = topPadding;
  const usableBottom = height - bottomPadding;
  const usableHeight = usableBottom - usableTop;
  const tokenWidths = tokens.map(estimateTokenWidthMm);
  const totalWidth = Math.max(1, tokenWidths.reduce((sum, item) => sum + item, 0) + Math.max(0, tokens.length - 1) * TOKEN_GAP_MM);
  const tokenCentersMm = tokens.map((_, i) => {
    const before = tokenWidths.slice(0, i).reduce((sum, item) => sum + item, 0) + i * TOKEN_GAP_MM;
    return before + tokenWidths[i] / 2;
  });
  const xForTokenIndex = (tokenIndex: number) => {
    if (!tokens.length) return width / 2;
    const localIndex = Math.max(0, Math.min(tokens.length - 1, tokenIndex - lineStartIndex));
    return (tokenCentersMm[localIndex] / totalWidth) * width;
  };
  const displayPoints = buildDisplayProsodyPoints(points, lineStartIndex, lineEndIndex);
  const displayValues = displayPoints.map((point) => point.displayValue);
  const minDisplayValue = Math.min(...displayValues);
  const maxDisplayValue = Math.max(...displayValues);
  const centerY = usableTop + usableHeight / 2;
  const yForDisplayValue = (value: number) => {
    if (maxDisplayValue === minDisplayValue) {
      return centerY;
    }
    // 先按“当前行可见语势点”的最高值/最低值做归一化：
    // 当前行最低点贴近底部，最高点贴近顶部。
    const normalized = (value - minDisplayValue) / (maxDisplayValue - minDisplayValue);
    return usableBottom - normalized * usableHeight;
  };
  const coordinates = displayPoints.map((point) => ({
    x: xForTokenIndex(point.tokenIndex),
    y: yForDisplayValue(point.displayValue),
  }));
  const visibleCoordinates = smoothProsodyCoordinates(coordinates, usableTop, usableBottom);
  const path = naturalProsodyPath(visibleCoordinates);
  const firstPoint = visibleCoordinates[0] ?? { x: width / 2, y: height * 0.45 };
  const lastPoint = visibleCoordinates[visibleCoordinates.length - 1] ?? firstPoint;
  const areaBottom = height - Math.max(0.55, height * 0.018);
  const areaPath = `${path} L ${lastPoint.x.toFixed(1)} ${areaBottom.toFixed(1)} L ${firstPoint.x.toFixed(1)} ${areaBottom.toFixed(1)} Z`;
  return (
    <svg
      className="mini-prosody"
      viewBox={`0 0 ${width} ${height}`}
      aria-label="语势简线"
      onClick={(event) => {
        if (!onAreaClick || !tokens.length) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const localIndex = Math.max(0, Math.min(tokens.length - 1, Math.round(ratio * (tokens.length - 1))));
        onAreaClick(segmentId, lineStartIndex + localIndex, { x: event.clientX, y: event.clientY });
      }}
    >
      <rect className="prosody-bg" x="0.5" y="0.5" width={Math.max(0, width - 1)} height={Math.max(0, height - 1)} rx="5" />
      <path className="prosody-area" d={areaPath} />
      <path className="prosody-line" d={path} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {showEditorHandles && displayPoints.map((point, index) => {
        if (point.globalIndex < 0) return null;
        const x = coordinates[index]?.x ?? xForTokenIndex(point.tokenIndex);
        const y = coordinates[index]?.y ?? yForDisplayValue(point.displayValue);
        return (
          <circle
            key={point.id}
            className={selectedIndex === point.globalIndex ? 'prosody-dot selected' : 'prosody-dot'}
            cx={x}
            cy={y}
            r={selectedIndex === point.globalIndex ? '3.7' : '2.65'}
            fill="#477ecb"
            onClick={(event) => {
              event.stopPropagation();
              onPointClick?.(segmentId, point.globalIndex, { x: event.clientX, y: event.clientY });
            }}
          />
        );
      })}
    </svg>
  );
}

function CompactPinyinToken({ token }: { token: Token }) {
  return (
    <span className="pinyin-token" style={{ width: `${estimateTokenWidthMm(token)}mm` }}>
      <span className="pinyin">{token.pinyin}</span>
    </span>
  );
}

function CompactTextToken({
  token,
  selected,
  onClick,
}: {
  token: Token;
  selected: boolean;
  onClick?: (token: Token, position: { x: number; y: number }) => void;
}) {
  const isLight = token.methods.includes('light');
  const isStrong = token.methods.includes('strong');
  const isExtend = token.methods.includes('extend');
  const className = ['hanzi', isStrong ? 'strong' : '', isLight ? 'light' : '', selected ? 'selected-token' : ''].filter(Boolean).join(' ');
  return (
    <span
      className="text-token editable-token"
      style={{ width: `${estimateTokenWidthMm(token)}mm` }}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(token, { x: event.clientX, y: event.clientY });
      }}
      title="点击编辑文稿层 / 拼音层 / 语势层"
    >
      <span className="hanzi-box">
        <span className={className}>{token.text}</span>
      </span>
      <span className={['token-marks', token.breathAfter ? 'with-breath' : '', isExtend ? 'with-extend' : ''].filter(Boolean).join(' ')} aria-hidden="true">
        {isExtend && <span className="extend">——</span>}
        {token.breathAfter && <span className="breath">∨</span>}
        {token.punctAfter && <span className="punct">{token.punctAfter}</span>}
        {token.pauseAfter && <span className="pause">{token.pauseAfter}</span>}
      </span>
    </span>
  );
}

function PrintLine({
  line,
  metrics,
  selection,
  onTokenClick,
  onProsodyPointClick,
  onProsodyAreaClick,
}: {
  line: Line;
  metrics: PageLayoutMetrics;
  selection: ActiveSelection | null;
  onTokenClick: (segmentId: string, token: Token, position: { x: number; y: number }) => void;
  onProsodyPointClick: (segmentId: string, index: number, position: { x: number; y: number }) => void;
  onProsodyAreaClick: (segmentId: string, tokenIndex: number, position: { x: number; y: number }) => void;
}) {
  const selectedProsodyIndex = selection?.segmentId === line.segmentId ? selection.prosodyIndex : undefined;
  const showProsodyHandles = selection?.segmentId === line.segmentId && selection?.tab === 'prosody';
  const textWidthMm = estimateLineWidthMm(line.tokens);
  return (
    <div className="print-line">
      <div className="line-meta">
        <div className="line-id">{String(line.lineNo).padStart(2, '0')}</div>
        <div className="layer-labels" aria-hidden="true">
          <span>拼</span>
          <span>文</span>
          <span>势</span>
        </div>
      </div>
      <div className="line-main">
        <div className="score-grid" style={{ width: `${textWidthMm}mm` }}>
          <div className="pinyin-row">
            {line.tokens.map((token) => (
              <CompactPinyinToken key={`${token.id}-py`} token={token} />
            ))}
          </div>
          <div className="text-row">
            {line.tokens.map((token) => (
              <CompactTextToken
                key={token.id}
                token={token}
                selected={selection?.tokenId === token.id}
                onClick={(clickedToken, position) => onTokenClick(line.segmentId, clickedToken, position)}
              />
            ))}
          </div>
          <div className="prosody-row">
            <ProsodyMini
              points={line.prosody}
              segmentId={line.segmentId}
              widthMm={textWidthMm}
              heightMm={metrics.prosodySvgMm}
              lineStartIndex={line.startIndex}
              lineEndIndex={line.endIndex}
              tokens={line.tokens}
              selectedIndex={selectedProsodyIndex}
              prosodyType={line.prosodyType}
              showEditorHandles={showProsodyHandles}
              onPointClick={onProsodyPointClick}
              onAreaClick={onProsodyAreaClick}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function A4Page({
  page,
  pageIndex,
  totalPages,
  title,
  selection,
  onTokenClick,
  onProsodyPointClick,
  onProsodyAreaClick,
}: {
  page: Line[];
  pageIndex: number;
  totalPages: number;
  title: string;
  selection: ActiveSelection | null;
  onTokenClick: (segmentId: string, token: Token, position: { x: number; y: number }) => void;
  onProsodyPointClick: (segmentId: string, index: number, position: { x: number; y: number }) => void;
  onProsodyAreaClick: (segmentId: string, tokenIndex: number, position: { x: number; y: number }) => void;
}) {
  const isContinuation = pageIndex > 0;
  const displayTitle = normalizeTitle(title);
  const metrics = getPageMetrics(page.length);
  const pageStyle = {
    '--line-min-h': `${metrics.lineMinHeightMm}mm`,
    '--pinyin-row-h': `${metrics.pinyinRowMm}mm`,
    '--text-row-h': `${metrics.textRowMm}mm`,
    '--prosody-row-h': `${metrics.prosodyRowMm}mm`,
    '--pinyin-size': `${metrics.pinyinSizePt}pt`,
    '--hanzi-size': `${metrics.hanziSizePt}pt`,
    '--prosody-svg-h': `${metrics.prosodySvgMm}mm`,
    '--card-gap': `${metrics.cardGapMm}mm`,
  } as React.CSSProperties;
  return (
    <section className={`a4-page density-${metrics.density}`} style={pageStyle}>
      <header className={isContinuation ? 'page-header continuation' : 'page-header'}>
        <div>
          <h1>《{displayTitle}》朗诵情感图谱{isContinuation ? ' · 续页' : ''}</h1>
        </div>
        {!isContinuation && (
          <div className="legend-line compact">
            <span><b>红粗</b>=加大音量｜<i className="light-sample">字</i>=轻读｜——=拖长｜∨=换气｜<em>/ // ///</em>=停顿</span>
          </div>
        )}
      </header>
      <main className="page-lines">
        {page.map((line, i) => (
          <PrintLine
            key={`${line.segmentId}-${line.lineIndex}-${i}`}
            line={line}
            metrics={metrics}
            selection={selection}
            onTokenClick={onTokenClick}
            onProsodyPointClick={onProsodyPointClick}
            onProsodyAreaClick={onProsodyAreaClick}
          />
        ))}
      </main>
      <footer className="page-footer">第 {pageIndex + 1} / {totalPages} 页</footer>
    </section>
  );
}

function FloatingLayerEditor({
  selection,
  segments,
  onClose,
  onSwitchTab,
  onToggleMethod,
  onSetPause,
  onToggleBreath,
  onClearTokenMarks,
  onChangePinyin,
  onSetProsodyLevel,
  onAddProsodyPoint,
  onDeleteProsodyPoint,
}: {
  selection: ActiveSelection;
  segments: Segment[];
  onClose: () => void;
  onSwitchTab: (tab: EditorTab) => void;
  onToggleMethod: (method: EmphasisMethod) => void;
  onSetPause: (pause: Token['pauseAfter']) => void;
  onToggleBreath: () => void;
  onClearTokenMarks: () => void;
  onChangePinyin: (value: string) => void;
  onSetProsodyLevel: (level: VoiceLevel) => void;
  onAddProsodyPoint: () => void;
  onDeleteProsodyPoint: () => void;
}) {
  const segment = segments.find((item) => item.id === selection.segmentId);
  const token = segment?.tokens.find((item) => item.id === selection.tokenId);
  const prosodyIndex = nearestProsodyIndex(segment, selection.tokenIndex, selection.prosodyIndex ?? 0);
  const currentLevel = segment?.prosody[prosodyIndex]?.level;
  const left = Math.min(Math.max(selection.x + 10, 18), window.innerWidth - 360);
  const top = Math.min(Math.max(selection.y + 10, 18), window.innerHeight - 330);

  return (
    <div className="floating-layer-editor no-print" style={{ left, top }} onClick={(event) => event.stopPropagation()}>
      <div className="editor-head">
        <strong>{token ? `编辑：${token.text}` : `编辑语势点 ${prosodyIndex + 1}`}</strong>
        <button className="icon-btn" onClick={onClose}>×</button>
      </div>
      <div className="editor-tabs">
        <button className={selection.tab === 'text' ? 'active' : ''} onClick={() => onSwitchTab('text')} disabled={!token}>文稿层</button>
        <button className={selection.tab === 'pinyin' ? 'active' : ''} onClick={() => onSwitchTab('pinyin')} disabled={!token}>拼音层</button>
        <button className={selection.tab === 'prosody' ? 'active' : ''} onClick={() => onSwitchTab('prosody')}>语势层</button>
      </div>

      {selection.tab === 'text' && token && (
        <div className="editor-body">
          <div className="editor-section-title">文稿层标注</div>
          <div className="button-grid">
            <button className={token.methods.includes('strong') ? 'active-mark' : ''} onClick={() => onToggleMethod('strong')}>加大音量</button>
            <button className={token.methods.includes('light') ? 'active-mark' : ''} onClick={() => onToggleMethod('light')}>重音轻读</button>
            <button className={token.methods.includes('extend') ? 'active-mark' : ''} onClick={() => onToggleMethod('extend')}>拖长读音</button>
          </div>
          <div className="button-grid pause-grid">
            {(['', '/', '//', '///'] as Token['pauseAfter'][]).map((pause) => (
              <button key={pause || 'none'} className={token.pauseAfter === pause ? 'active-mark' : ''} onClick={() => onSetPause(pause)}>
                {pause || '无停顿'}
              </button>
            ))}
          </div>
          <div className="button-grid two">
            <button className={token.breathAfter ? 'active-mark' : ''} onClick={onToggleBreath}>换气 ∨</button>
            <button className="danger-soft" onClick={onClearTokenMarks}>清除当前字标注</button>
          </div>
        </div>
      )}

      {selection.tab === 'pinyin' && token && (
        <div className="editor-body">
          <div className="editor-section-title">拼音层</div>
          <label className="inline-label">
            当前字：{token.text}
            <input value={token.pinyin} onChange={(event) => onChangePinyin(event.target.value)} />
          </label>
          <p className="editor-hint">修改后会实时反映到 A4 预览。多音字可在这里人工校对。</p>
        </div>
      )}

      {selection.tab === 'prosody' && segment && (
        <div className="editor-body">
          <div className="editor-section-title">语势层</div>
          <div className="level-row">
            {levelOrder.map((level) => (
              <button key={level} className={currentLevel === level ? 'active-level' : ''} onClick={() => onSetProsodyLevel(level)}>
                {levelLabel[level]}
              </button>
            ))}
          </div>
          <div className="button-grid two">
            <button onClick={onAddProsodyPoint}>新增语势点</button>
            <button className="danger-soft" onClick={onDeleteProsodyPoint} disabled={segment.prosody.length <= 2}>删除最近语势点</button>
          </div>
          <p className="editor-hint">当前编辑第 {prosodyIndex + 1} 个语势点，共 {segment.prosody.length} 个。A4 版显示阶梯式语势图，语势点仍锚定具体文字。</p>
        </div>
      )}
    </div>
  );
}

export function App() {
  const [title, setTitle] = useState('');
  const [rawText, setRawText] = useState('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selection, setSelection] = useState<ActiveSelection | null>(null);
  const parsedDraft = useMemo(() => extractTitleAndBody(rawText), [rawText]);
  const effectiveTitle = title.trim() || parsedDraft.title;
  const lines = useMemo(() => buildLines(segments), [segments]);
  const pages = useMemo(() => smartPaginate(lines, MAX_LINES_PER_PAGE), [lines]);
  const draftSegments = useMemo(() => (parsedDraft.body.trim() ? generateSegments(parsedDraft.body) : []), [parsedDraft.body]);
  const draftLines = useMemo(() => buildLines(draftSegments), [draftSegments]);
  const draftPages = useMemo(() => smartPaginate(draftLines, MAX_LINES_PER_PAGE), [draftLines]);
  const draftCharCount = useMemo(() => countReadableChars(draftSegments), [draftSegments]);
  const activePlanPages = segments.length > 0 ? pages : draftPages;
  const activeLineCount = segments.length > 0 ? lines.length : draftLines.length;
  const activeCharCount = segments.length > 0 ? countReadableChars(segments) : draftCharCount;

  const updateSegment = (segmentId: string, updater: (segment: Segment) => Segment) => {
    setSegments((previous) => previous.map((segment) => (segment.id === segmentId ? updater(segment) : segment)));
  };

  const updateSelectedToken = (updater: (token: Token) => Token) => {
    if (!selection?.tokenId) return;
    updateSegment(selection.segmentId, (segment) => ({
      ...segment,
      tokens: segment.tokens.map((token) => (token.id === selection.tokenId ? updater(token) : token)),
    }));
  };

  const handleGenerate = () => {
    if (!title.trim() && parsedDraft.title) setTitle(parsedDraft.title);
    setSegments(generateSegments(parsedDraft.body));
    setSelection(null);
  };

  const handleTokenClick = (segmentId: string, token: Token, position: { x: number; y: number }) => {
    const segment = segments.find((item) => item.id === segmentId);
    const tokenIndex = getTokenIndex(token.id);
    setSelection({
      segmentId,
      tokenId: token.id,
      tokenIndex,
      prosodyIndex: nearestProsodyIndex(segment, tokenIndex),
      tab: 'text',
      x: position.x,
      y: position.y,
    });
  };

  const handleProsodyPointClick = (segmentId: string, index: number, position: { x: number; y: number }) => {
    const segment = segments.find((item) => item.id === segmentId);
    const point = segment?.prosody[index];
    setSelection({ segmentId, prosodyIndex: index, tokenIndex: point?.tokenIndex, tab: 'prosody', x: position.x, y: position.y });
  };

  const handleProsodyAreaClick = (segmentId: string, tokenIndex: number, position: { x: number; y: number }) => {
    const segment = segments.find((item) => item.id === segmentId);
    setSelection({ segmentId, tokenIndex, prosodyIndex: nearestProsodyIndex(segment, tokenIndex), tab: 'prosody', x: position.x, y: position.y });
  };

  const toggleMethod = (method: EmphasisMethod) => {
    updateSelectedToken((token) => {
      let methods = new Set(token.methods);
      if (methods.has(method)) methods.delete(method);
      else methods.add(method);
      if (method === 'strong' && methods.has('strong')) methods.delete('light');
      if (method === 'light' && methods.has('light')) methods.delete('strong');
      const nextMethods = Array.from(methods);
      return { ...token, methods: nextMethods, isEmphasis: nextMethods.length > 0 };
    });
  };

  const setPause = (pauseAfter: Token['pauseAfter']) => updateSelectedToken((token) => ({ ...token, pauseAfter }));
  const toggleBreath = () => updateSelectedToken((token) => ({ ...token, breathAfter: !token.breathAfter }));
  const clearTokenMarks = () => updateSelectedToken((token) => ({ ...token, methods: [], isEmphasis: false, pauseAfter: '', breathAfter: false }));
  const changePinyin = (value: string) => updateSelectedToken((token) => ({ ...token, pinyin: value }));

  const setProsodyLevel = (level: VoiceLevel) => {
    if (!selection) return;
    updateSegment(selection.segmentId, (segment) => {
      const index = nearestProsodyIndex(segment, selection.tokenIndex, selection.prosodyIndex ?? 0);
      return { ...segment, prosody: segment.prosody.map((item, i) => (i === index ? { ...item, level } : item)) };
    });
  };

  const addProsodyPoint = () => {
    if (!selection) return;
    updateSegment(selection.segmentId, (segment) => {
      const anchorTokenIndex = Math.max(0, Math.min(segment.tokens.length - 1, selection.tokenIndex ?? segment.prosody[selection.prosodyIndex ?? 0]?.tokenIndex ?? 0));
      const nearestIndex = nearestProsodyIndex(segment, anchorTokenIndex, selection.prosodyIndex ?? 0);
      const nextPoint: ProsodyPoint = {
        id: `${segment.id}-p${Date.now()}`,
        level: segment.prosody[nearestIndex]?.level ?? 'mid',
        tokenIndex: anchorTokenIndex,
      };
      const next = sortProsody([...segment.prosody, nextPoint]);
      const nextIndex = next.findIndex((point) => point.id === nextPoint.id);
      setSelection((current) => (current ? { ...current, prosodyIndex: nextIndex, tokenIndex: anchorTokenIndex } : current));
      return { ...segment, prosody: next };
    });
  };

  const deleteProsodyPoint = () => {
    if (!selection) return;
    updateSegment(selection.segmentId, (segment) => {
      if (segment.prosody.length <= 2) return segment;
      const index = nearestProsodyIndex(segment, selection.tokenIndex, selection.prosodyIndex ?? 0);
      const next = segment.prosody.filter((_, i) => i !== index);
      setSelection((current) => (current ? { ...current, prosodyIndex: Math.max(0, Math.min(index, next.length - 1)) } : current));
      return { ...segment, prosody: next };
    });
  };

  return (
    <div className="app" onClick={() => setSelection(null)}>
      <section className="control-panel no-print" onClick={(event) => event.stopPropagation()}>
        <div className="control-title">
          <h2>A4 打印塑封核心版</h2>
          <p>粘贴文稿后生成 A4 图谱；点击文字或语势线即可编辑。</p>
        </div>
        <div className="input-grid compact-control-grid">
          <label>
            作品名
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="text-input">
            文稿内容
            <textarea value={rawText} onChange={(e) => setRawText(e.target.value)} rows={5} />
          </label>
          <div className="actions">
            <button onClick={handleGenerate}>生成 A4 打印版</button>
          </div>
        </div>
        <div className="layout-report">
          <div className="layout-report-title">排版检查</div>
          {rawText.trim() ? (
            <div className="layout-report-grid">
              <span>文稿字数：{activeCharCount}</span>
              <span>预计行数：{activeLineCount}</span>
              <span>预计页数：{activePlanPages.length}</span>
              <span className="distribution">分页方案：{formatPaginationDistribution(activePlanPages)}</span>
              <span>分页模式：智能分页 + 页面空间回流放大，单页最多 {MAX_LINES_PER_PAGE} 行</span>
            </div>
          ) : (
            <p>粘贴文稿后，这里会自动检查字数、预计行数、预计页数和每页分配方案。</p>
          )}
        </div>
      </section>

      <section className="print-preview">
        {pages.map((page, i) => (
          <A4Page
            key={i}
            page={page}
            pageIndex={i}
            totalPages={pages.length}
            title={effectiveTitle}
            selection={selection}
            onTokenClick={handleTokenClick}
            onProsodyPointClick={handleProsodyPointClick}
            onProsodyAreaClick={handleProsodyAreaClick}
          />
        ))}
      </section>

      {selection && (
        <FloatingLayerEditor
          selection={selection}
          segments={segments}
          onClose={() => setSelection(null)}
          onSwitchTab={(tab) => setSelection((current) => (current ? { ...current, tab } : current))}
          onToggleMethod={toggleMethod}
          onSetPause={setPause}
          onToggleBreath={toggleBreath}
          onClearTokenMarks={clearTokenMarks}
          onChangePinyin={changePinyin}
          onSetProsodyLevel={setProsodyLevel}
          onAddProsodyPoint={addProsodyPoint}
          onDeleteProsodyPoint={deleteProsodyPoint}
        />
      )}
    </div>
  );
}
