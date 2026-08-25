"use client";

import {
  useCallback,
  useLayoutEffect,
  useState,
  type RefObject,
} from "react";
import { virtualVoiceTokenRuns } from "@/lib/delivery-technique";
import type { RecitationSentence } from "@/lib/recitation-schema";

interface VirtualVoiceBox {
  id: string;
  tokenIndexes: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
}

export function VirtualVoiceGroupOverlay({
  sentence,
  tokenIndexes,
  characterRefs,
  rowElement,
}: {
  sentence: RecitationSentence;
  tokenIndexes: readonly number[];
  characterRefs: RefObject<Map<number, HTMLElement>>;
  rowElement: HTMLElement | null;
}) {
  const [boxes, setBoxes] = useState<VirtualVoiceBox[]>([]);

  const measure = useCallback(() => {
    if (!rowElement) {
      setBoxes([]);
      return;
    }
    const rowRect = rowElement.getBoundingClientRect();
    const next = virtualVoiceTokenRuns(sentence, tokenIndexes).flatMap((run) => {
      const first = characterRefs.current.get(run[0]);
      const last = characterRefs.current.get(run.at(-1)!);
      if (!first || !last) return [];
      const firstRect = first.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      const fontSize = Number.parseFloat(window.getComputedStyle(first).fontSize) || 16;
      const height = fontSize * 1.18;
      const horizontalPadding = fontSize * 0.14;
      const firstCenter = firstRect.left + firstRect.width / 2;
      const lastCenter = lastRect.left + lastRect.width / 2;
      const left = firstCenter - fontSize / 2 - horizontalPadding;
      const right = lastCenter + fontSize / 2 + horizontalPadding;
      const centerY = firstRect.top + firstRect.height / 2;
      return [{
        id: `${run[0]}-${run.at(-1)}`,
        tokenIndexes: run.join(","),
        left: left - rowRect.left,
        top: centerY - height / 2 - rowRect.top,
        width: right - left,
        height,
        fontSize,
      }];
    });
    setBoxes((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, [characterRefs, rowElement, sentence, tokenIndexes]);

  useLayoutEffect(() => {
    if (!rowElement) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(rowElement);
    virtualVoiceTokenRuns(sentence, tokenIndexes).forEach((run) => {
      run.forEach((tokenIndex) => {
        const element = characterRefs.current.get(tokenIndex);
        if (element) observer.observe(element);
      });
    });
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [characterRefs, measure, rowElement, sentence, tokenIndexes]);

  return (
    <div className="recitation-virtual-voice-overlay" aria-hidden="true">
      {boxes.map((box) => (
        <span
          className="recitation-virtual-voice-group"
          data-virtual-voice-token-indexes={box.tokenIndexes}
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            fontSize: box.fontSize,
          }}
          key={box.id}
        />
      ))}
    </div>
  );
}
