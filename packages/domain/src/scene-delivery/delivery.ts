/**
 * Transaction F — atomic validated Scene delivery.
 *
 * This is the customer-visible delivery authority. It consumes one durable
 * `ManagedOutputMediaValidation.status = VALID` verdict and performs, as one
 * business fact:
 *
 * ```text
 * SceneGenerationRequest  GENERATING -> DELIVERED   (+ deliveredAt)
 * GenerationScene         GENERATING|REVISING -> READY
 * GenerationScene.currentDeliveredRequestId = the delivered request
 * GenerationJob           GENERATING -> SCENES_READY, iff every Scene is READY
 * ```
 *
 * ## Why these writes are one transaction
 *
 * Splitting them re-creates the crash boundary Transaction F exists to remove.
 * A request marked `DELIVERED` whose Scene never reached `READY` is a scene the
 * customer paid a regeneration right for and cannot see; a Scene pointing at a
 * request that is not `DELIVERED` is a pointer to something the ledger says
 * never happened. Neither is repairable afterwards, because nothing records
 * which half was intended. So there is exactly one repository operation, and it
 * owns the locks, the authority re-reads, every write and every event.
 *
 * ## What `VALID` does and does not mean here
 *
 * `OUTPUT_VERIFIED` keeps its exact meaning — canonical managed bytes copied
 * and byte-level integrity verified — and is not redefined. The media verdict
 * is an orthogonal durable fact, and Transaction F simply *requires* it before
 * showing the scene to a customer. No S3 read and no `ffprobe` run happens
 * here: the durable `VALID` row is the media authority, already established by
 * Phase 2H-3B-5.
 *
 * ## Deliberately not here
 *
 * `INVALID_MEDIA` and `INTEGRITY_MISMATCH` remain durable terminal verdicts
 * with no downstream action. Admitting a `SYSTEM_RECOVERY` attempt is a
 * different failure and cost domain — it chooses a provider, a model, a pricing
 * identity and a possible future paid call — and belongs to Phase 6B. Quota
 * `CONSUME` belongs to Transaction G at
 * `DELIVERABLE_VALIDATING -> DELIVERABLE_READY`, because a ready Scene is not a
 * delivered video.
 */

import { AppError } from "@app/shared";

/** What one Transaction F attempt concluded. Closed and application-owned. */
export type ValidatedSceneDeliveryOutcome =
  | {
      readonly kind: "DELIVERED";
      /** Whether this delivery was the one that made the Job `SCENES_READY`. */
      readonly jobAdvanced: boolean;
    }
  /**
   * The exact same request was already fully delivered. Nothing is written
   * again — no version, no `deliveredAt`, no event.
   */
  | { readonly kind: "ALREADY_APPLIED" }
  /**
   * The durable facts do not admit delivery: no `VALID` verdict yet, a newer
   * sibling attempt exists, or a state has moved on. An ordinary outcome, not
   * an error — the caller reloads rather than retrying a side effect.
   */
  | { readonly kind: "NOT_ELIGIBLE" }
  /** No such validation, attempt or request visible to this organization. */
  | { readonly kind: "NOT_FOUND" };

/**
 * The fixed defect codes Transaction F may raise.
 *
 * Every one is an internal consistency violation — a state combination the
 * application believes it can never produce. None is customer input, none
 * carries external text, and none is repaired: silently fixing a half-applied
 * delivery would destroy the evidence of whatever produced it.
 */
export type ValidatedSceneDeliveryDefectCode =
  /** The validation's frozen receipt disagrees with the attempt's. */
  | "RECEIPT_BINDING_CONFLICT"
  /** A `USER_REGENERATION` delivery found its Scene somewhere other than `REVISING`, or an `INITIAL` one somewhere other than `GENERATING`. */
  | "SCENE_STATE_CONFLICT"
  /** The Scene's delivered pointer names a request from another Scene or chain. */
  | "DELIVERY_POINTER_CONFLICT"
  /** A `USER_REGENERATION` reached delivery with nothing on its Scene to replace. */
  | "REGENERATION_PREDECESSOR_MISSING"
  /** Request, Scene and pointer disagree about whether delivery happened. */
  | "PARTIAL_DELIVERY_STATE";

const DEFECT_MESSAGES: Record<ValidatedSceneDeliveryDefectCode, string> = {
  RECEIPT_BINDING_CONFLICT:
    "A media validation is bound to different bytes than its attempt's verified receipt",
  SCENE_STATE_CONFLICT: "The scene is not in the state its request kind requires for delivery",
  DELIVERY_POINTER_CONFLICT:
    "The scene's delivered-request pointer does not belong to this scene",
  REGENERATION_PREDECESSOR_MISSING:
    "A regeneration reached delivery with no delivered predecessor on its scene",
  PARTIAL_DELIVERY_STATE: "Request, scene and delivered pointer disagree about delivery",
};

export class ValidatedSceneDeliveryDefect extends Error {
  readonly code: ValidatedSceneDeliveryDefectCode;

  constructor(code: ValidatedSceneDeliveryDefectCode) {
    super(DEFECT_MESSAGES[code]);
    this.name = "ValidatedSceneDeliveryDefect";
    this.code = code;
  }
}

/**
 * The largest delivery batch one pass may claim.
 *
 * A frozen number, matching the reconciliation and media-validation bounds: it
 * states how much work one pass may take before yielding, and a deployment
 * needing more throughput should run more passes.
 */
export const MAX_SCENE_DELIVERY_BATCH_SIZE = 100;

/**
 * Prove a candidate-query limit is usable, or refuse.
 *
 * Not clamping, for the same reason the other maintenance bounds do not:
 * silently substituting 100 for 5000 lets a caller believe it swept far more
 * than it did. `Number.isSafeInteger` rejects `NaN`, both infinities, fractions
 * and anything past 2^53-1 — every value a SQL `LIMIT` must never receive.
 */
export function validateSceneDeliveryBatchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SCENE_DELIVERY_BATCH_SIZE) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Scene delivery batch limit must be an integer between 1 and ${MAX_SCENE_DELIVERY_BATCH_SIZE}`,
    );
  }
  return value;
}

/**
 * The event vocabulary Transaction F appends, reusing the existing writer.
 *
 * Fixed application-owned strings. Nothing derived from a provider, a media
 * fact, an exception or a URL ever reaches event metadata.
 */
export const SCENE_REQUEST_DELIVERED_EVENT_TYPE = "scene_request.delivered";
export const SCENE_READY_EVENT_TYPE = "scene.ready";
export const JOB_SCENES_READY_EVENT_TYPE = "job.scenes_ready";

/** The reason code recorded on every Transaction F transition. */
export const VALIDATED_DELIVERY_REASON_CODE = "VALIDATED_MEDIA_DELIVERY";
