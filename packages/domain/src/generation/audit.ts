/**
 * Audit vocabulary for scene generation.
 *
 * One action, deliberately. `generation.requested` follows the established
 * `<module>.<verb>` shape (`analysis.requested`, `storyboard.composed`), and no
 * existing action names its resource with an underscore — which is why the
 * event is `generation.requested` and not `scene_generation.started`. The
 * `resourceType` below carries the table-name form (`scene_generation`, like
 * `video_project` and `asset_analysis`); the action does not.
 *
 * It is emitted **once per newly created attempt, only after the job has been
 * accepted by the queue** — never for a reused active or succeeded attempt, and
 * never for a race-winner returned by another request. A record of "requested
 * for execution" that outran a successful enqueue would be a lie about what the
 * system actually did.
 */
export const GenerationAuditAction = {
  GenerationRequested: "generation.requested",
} as const;

export type GenerationAuditActionValue =
  (typeof GenerationAuditAction)[keyof typeof GenerationAuditAction];

/** The `resourceType` every generation audit entry carries. Table-name form. */
export const GENERATION_AUDIT_RESOURCE_TYPE = "scene_generation";
