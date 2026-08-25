import type { DistanceViewType } from "@/lib/delivery-technique";

/** Compact emoji cues that remain readable at roughly one character width. */
export function DistanceViewGlyph({ type }: { type: DistanceViewType }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- supplied artwork must remain unchanged in editor and print output.
    <img
      className={`recitation-distance-glyph ${type === "distant_view" ? "is-distant-view" : "is-close-view"}`}
      src={type === "distant_view" ? "/distant-view-emoji.png" : "/close-view-emoji.png"}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
