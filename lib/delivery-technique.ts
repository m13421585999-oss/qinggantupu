import type {
  DeliveryTechniqueMark,
  RecitationSentence,
  TimedToken,
} from "./recitation-schema";

export type DistanceViewType = Extract<
  DeliveryTechniqueMark["type"],
  "distant_view" | "close_view"
>;

export function deliveryTechniqueAt(
  sentence: RecitationSentence,
  tokenIndex: number,
  type: DeliveryTechniqueMark["type"],
) {
  return sentence.deliveryTechniqueMarks?.find((mark) => (
    mark.tokenIndex === tokenIndex && mark.type === type
  ));
}

export function distanceViewAt(sentence: RecitationSentence, tokenIndex: number) {
  return sentence.deliveryTechniqueMarks?.find((mark): mark is DeliveryTechniqueMark & {
    type: DistanceViewType;
  } => (
    mark.tokenIndex === tokenIndex
    && (mark.type === "distant_view" || mark.type === "close_view")
  ));
}

/** Consecutive virtual-voice tokens on one rendered line share one outline. */
export function virtualVoiceTokenRuns(
  sentence: RecitationSentence,
  renderedTokenIndexes: readonly number[],
) {
  const marked = new Set((sentence.deliveryTechniqueMarks ?? []).flatMap((mark) => (
    mark.type === "virtual_voice" ? [mark.tokenIndex] : []
  )));
  const runs: number[][] = [];
  for (const tokenIndex of renderedTokenIndexes) {
    if (!marked.has(tokenIndex)) continue;
    const current = runs.at(-1);
    if (current?.at(-1) === tokenIndex - 1) current.push(tokenIndex);
    else runs.push([tokenIndex]);
  }
  return runs;
}

/** 虚声 is independent; 远景 and 近景 form one mutually exclusive group. */
export function setDeliveryTechniqueAt(
  sentence: RecitationSentence,
  token: TimedToken,
  type: DeliveryTechniqueMark["type"],
) {
  const distanceType = type === "distant_view" || type === "close_view";
  const current = distanceType
    ? distanceViewAt(sentence, token.index)
    : deliveryTechniqueAt(sentence, token.index, "virtual_voice");
  const marks = (sentence.deliveryTechniqueMarks ?? []).filter((mark) => (
    mark.tokenIndex !== token.index
    || (distanceType
      ? mark.type === "virtual_voice"
      : mark.type === "distant_view" || mark.type === "close_view")
  ));
  if (current?.type === type) {
    return { ...sentence, deliveryTechniqueMarks: marks.length ? marks : undefined };
  }
  return {
    ...sentence,
    deliveryTechniqueMarks: [...marks, {
      id: current?.id ?? `${sentence.id}-delivery-technique-${type}-${token.index}`,
      tokenId: token.id,
      tokenIndex: token.index,
      type,
      source: "human" as const,
    }].sort((left, right) => (
      left.tokenIndex - right.tokenIndex || left.type.localeCompare(right.type)
    )),
  };
}
