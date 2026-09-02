import type { RoomType } from "../analysis/types";
// Type-only, and one-directional at runtime: the resolution vocabulary is
// declared once, next to the catalog that has to honour it, so a project cannot
// store a target no model entry is able to describe.
import type { TargetOutputResolution } from "../generation/model-catalog";

/**
 * Project lifecycle:
 *   DRAFT → STORYBOARD_READY → STORYBOARD_STALE → STORYBOARD_READY …
 *
 * `STORYBOARD_STALE` is *derived*, never pushed: no module notifies this one
 * when an analysis is refreshed. A reader compares the project's stored
 * {@link VideoProject.compositionFingerprint} with the fingerprint of the
 * currently eligible input set, so a stale storyboard is detectable long after
 * the refresh that invalidated it, with no cross-module hook or event.
 */
export type VideoProjectStatus = "DRAFT" | "STORYBOARD_READY" | "STORYBOARD_STALE";

export const VIDEO_PROJECT_STATUSES: readonly VideoProjectStatus[] = [
  "DRAFT",
  "STORYBOARD_READY",
  "STORYBOARD_STALE",
];

/**
 * Project-level settings for one property's walkthrough video.
 *
 * Provider-neutral: `durationSeconds` and `aspectRatio` are stored as
 * requested. `targetOutputResolution` is the exception, and deliberately so —
 * it is a closed product vocabulary rather than free text, because it is a
 * promise the product makes about the deliverable, not a value passed through
 * to a vendor (ADR-0034).
 */
export interface VideoProject {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly name: string;
  readonly status: VideoProjectStatus;
  readonly durationSeconds: number;
  readonly aspectRatio: string;
  /**
   * The product deliverable the customer asked for — a **quality class**, not a
   * raster size, and not the token any provider is sent.
   *
   * It was `resolution: string` until ADR-0034. The rename is not cosmetic: the
   * old field was read by generation as the value to *generate at*, which was
   * only ever coherent because the one wired model generated natively at the
   * same two strings the product offered.
   */
  readonly targetOutputResolution: TargetOutputResolution;
  readonly stylePreset: string | null;
  readonly cameraMotion: string | null;
  /** Untrusted user text. Compiled and moderated in Phase 3C-3, never here. */
  readonly prompt: string | null;
  readonly negativePrompt: string | null;
  readonly includeMusic: boolean;
  readonly includeCaptions: boolean;
  readonly brandTemplateId: string | null;
  /**
   * Digest of the APPROVED analysis input set the current storyboard was
   * composed from. Null until a storyboard exists.
   */
  readonly compositionFingerprint: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One planned scene.
 *
 * Carries no `organizationId`: tenant scope is inherited through the project.
 * `propertyId` is not denormalization for convenience — it is half of the two
 * composite foreign keys that make a scene whose project and asset belong to
 * different properties (and so different organizations) impossible to insert.
 */
export interface StoryboardScene {
  readonly id: string;
  readonly videoProjectId: string;
  readonly propertyId: string;
  readonly assetId: string;
  /** Unique within the project; the database enforces it. */
  readonly position: number;
  readonly roomType: RoomType | null;
  readonly durationSeconds: number;
  readonly cameraMotion: string | null;
  /** Filled by the Phase 3C-3 compiler; null while only persistence exists. */
  readonly compiledPrompt: string | null;
  /** Provenance: the analysis revision this scene was composed from. */
  readonly sourceAnalysisRevision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Minimum scenes a storyboard may contain (docs/ProductRequirements.md). */
export const MIN_STORYBOARD_SCENES = 3;
