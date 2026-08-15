import type { PrintSettings, RecitationSentence } from "./recitation-schema";

export const CSS_PIXELS_PER_MM = 96 / 25.4;

export const DEFAULT_A4_PRINT_SETTINGS: PrintSettings = {
  paper: "A4",
  orientation: "portrait",
  widthMm: 210,
  heightMm: 297,
  marginTopMm: 15,
  marginBottomMm: 15,
  marginLeftMm: 15,
  marginRightMm: 15,
  renderDpr: 2.5,
};

export interface SentencePrintBlock {
  id: string;
  paragraphId: string;
  sentenceIds: string[];
  sentence: RecitationSentence;
  sceneImageUrl?: string;
}

export interface MeasuredPrintBlock {
  id: string;
  heightPx: number;
}

export interface PrintPagePlan {
  index: number;
  blockIds: string[];
  usedHeightPx: number;
  capacityPx: number;
  hasOversizedBlock: boolean;
}

export interface PaginationOptions {
  firstPageCapacityPx: number;
  continuationPageCapacityPx: number;
  blockGapPx: number;
  protectSingleBlockPages?: boolean;
  maxBlocksPerPage?: number;
}

function pageCapacity(index: number, options: PaginationOptions) {
  return index === 0
    ? options.firstPageCapacityPx
    : options.continuationPageCapacityPx;
}

function pageHeight(blocks: MeasuredPrintBlock[], gapPx: number) {
  return blocks.reduce((height, block, index) => (
    height + block.heightPx + (index > 0 ? gapPx : 0)
  ), 0);
}

/**
 * Paginate already-rendered sentence blocks. Heights always come from the DOM
 * at the exact A4 content width; this function never estimates from character
 * counts and never slices a block at an arbitrary pixel row.
 */
export function paginateMeasuredPrintBlocks(
  blocks: MeasuredPrintBlock[],
  options: PaginationOptions,
): PrintPagePlan[] {
  const usableBlocks = blocks.filter((block) => (
    block.id && Number.isFinite(block.heightPx) && block.heightPx > 0
  ));
  if (!usableBlocks.length) return [];

  const pages: Array<{ blocks: MeasuredPrintBlock[]; capacityPx: number }> = [];
  let current = { blocks: [] as MeasuredPrintBlock[], capacityPx: pageCapacity(0, options) };

  for (const block of usableBlocks) {
    const required = block.heightPx + (current.blocks.length ? options.blockGapPx : 0);
    const used = pageHeight(current.blocks, options.blockGapPx);
    const reachedBlockLimit = Number.isFinite(options.maxBlocksPerPage)
      && current.blocks.length >= Math.max(1, Math.floor(options.maxBlocksPerPage!));
    if (current.blocks.length && (reachedBlockLimit || used + required > current.capacityPx + 0.5)) {
      pages.push(current);
      current = {
        blocks: [block],
        capacityPx: pageCapacity(pages.length, options),
      };
    } else {
      current.blocks.push(block);
    }
  }
  if (current.blocks.length) pages.push(current);

  // A lightweight widow safeguard: when a continuation page contains only one
  // sentence, bring the preceding sentence with it if both fit and the previous
  // page still retains at least two complete sentences.
  if (options.protectSingleBlockPages !== false) {
    for (let index = 1; index < pages.length; index += 1) {
      const page = pages[index];
      const previous = pages[index - 1];
      if (page.blocks.length !== 1 || previous.blocks.length < 3) continue;
      const companion = previous.blocks.at(-1)!;
      const combined = [companion, ...page.blocks];
      if (pageHeight(combined, options.blockGapPx) <= page.capacityPx + 0.5) {
        previous.blocks.pop();
        page.blocks.unshift(companion);
      }
    }
  }

  return pages.filter((page) => page.blocks.length).map((page, index) => {
    const usedHeightPx = pageHeight(page.blocks, options.blockGapPx);
    return {
      index,
      blockIds: page.blocks.map((block) => block.id),
      usedHeightPx,
      capacityPx: page.capacityPx,
      hasOversizedBlock: page.blocks.some((block) => block.heightPx > page.capacityPx + 0.5),
    };
  });
}

export function safePrintFilename(title: string, extension: "pdf" | "png") {
  const base = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return `${base || "朗诵情感图谱"}-朗诵情感图谱.${extension}`;
}

export function mmToCssPixels(value: number) {
  return value * CSS_PIXELS_PER_MM;
}
