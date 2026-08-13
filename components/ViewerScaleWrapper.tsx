"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

export const VIEWER_ARTBOARD_WIDTH = 1600;
const VIEWER_PLAYER_SAFE_AREA = 124;

export function ViewerScaleWrapper({
  children,
  artboardRef,
}: {
  children: ReactNode;
  artboardRef?: RefObject<HTMLDivElement | null>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const localArtboardRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ scale: 1, height: 0 });

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    const artboard = localArtboardRef.current;
    if (!viewport || !artboard) return;

    const availableWidth = viewport.clientWidth;
    const scale = Math.min(1, Math.max(0.1, availableWidth / VIEWER_ARTBOARD_WIDTH));
    const designHeight = Math.max(1, artboard.scrollHeight);
    const height = Math.ceil(designHeight * scale) + VIEWER_PLAYER_SAFE_AREA;
    setLayout((current) => (
      Math.abs(current.scale - scale) < 0.0005 && current.height === height
        ? current
        : { scale, height }
    ));
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const artboard = localArtboardRef.current;
    if (!viewport || !artboard) return;

    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    schedule();

    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    observer.observe(artboard);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [measure]);

  const setArtboardRef = useCallback((element: HTMLDivElement | null) => {
    localArtboardRef.current = element;
    if (artboardRef) artboardRef.current = element;
  }, [artboardRef]);

  return (
    <div
      className="viewer-scale-viewport"
      data-viewer-design-width={VIEWER_ARTBOARD_WIDTH}
      ref={viewportRef}
      style={{ height: layout.height > 0 ? `${layout.height}px` : undefined }}
    >
      <div
        className="viewer-artboard"
        data-viewer-artboard="true"
        ref={setArtboardRef}
        style={{ "--viewer-scale": layout.scale } as CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}
