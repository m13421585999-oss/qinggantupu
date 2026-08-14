export interface VisualGenerationTargetIdentity {
  type: "all" | "hero" | "scene";
  sceneId?: string;
}

/**
 * A visual job's user-facing target is its kind and optional scene. Whether it
 * had to create a plan is an execution detail that can change after the job
 * starts, so it must not prevent a retry from reconnecting to the same job.
 */
export function sameVisualGenerationTarget(
  left: VisualGenerationTargetIdentity,
  right: VisualGenerationTargetIdentity,
) {
  return left.type === right.type
    && (left.sceneId ?? "") === (right.sceneId ?? "");
}
