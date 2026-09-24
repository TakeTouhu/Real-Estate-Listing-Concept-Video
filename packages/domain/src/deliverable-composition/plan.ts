/**
 * Transaction I — atomic deliverable composition admission.
 *
 * Phase 6C ends with every `GenerationScene` `READY`, the `GenerationJob`
 * `SCENES_READY`, and each Scene's `currentDeliveredRequestId` naming the
 * rendition the customer is entitled to see. This module answers the next
 * question, and only that question:
 *
 * ```text
 * exactly which immutable scene renditions belong to the next deliverable?
 * ```
 *
 * It is a **plan**, not an execution. Nothing here reads an object store, runs
 * `ffprobe`, invokes `ffmpeg`, produces bytes, or consumes a customer unit. The
 * durable answer is a `GenerationDeliverableVersion` plus one immutable input
 * row per Scene, admitted in one transaction alongside
 * `GenerationJob SCENES_READY -> COMPOSITION_PENDING`.
 *
 * ## Why a plan is its own durable identity
 *
 * Composition can crash. Without a frozen input set, a restarted composition
 * re-derives "which renditions" from live rows — and live rows move: a
 * regeneration can replace a Scene's delivered pointer between two attempts at
 * the same video. The customer would then receive a video assembled from a
 * selection nobody ever approved, and no record would exist of which selection
 * each attempt used. Freezing the set makes the deliverable reconstructable and
 * makes two attempts at it comparable.
 *
 * ## What planning deliberately does not do
 *
 * `GenerationJob.currentDeliverableVersionId` is **not** moved here. For an
 * initial composition it stays null; for a recomposition it keeps naming the
 * previous, still-usable deliverable. The customer keeps the video they already
 * have until a validated replacement is published — which is Transaction G's
 * job, and Transaction G is deferred. Composition correctness and billing
 * correctness are separate failure domains, so planning consumes no unit:
 *
 * ```text
 * composition plan
 *   != composition success
 *   != durable final bytes
 *   != media-valid final bytes
 *   != DELIVERABLE_READY
 *   != unit CONSUME
 * ```
 */

import { sha256Hex } from "@app/shared";

/** What one Transaction I attempt concluded. Closed and application-owned. */
export type AdmitCompositionPlanOutcome =
  | {
      readonly kind: "PLANNED";
      readonly deliverableVersionId: string;
      readonly ordinal: number;
      readonly inputFingerprint: string;
    }
  /**
   * This Job's plan for the current cycle already exists. Nothing is written
   * again — no version, no input row, no ordinal increment, no event.
   */
  | {
      readonly kind: "ALREADY_PLANNED";
      readonly deliverableVersionId: string;
      readonly ordinal: number;
      readonly inputFingerprint: string;
    }
  /**
   * The durable facts do not admit a plan: the Job is not `SCENES_READY`, a
   * Scene is not `READY` or has no delivered pointer, a selected request is not
   * `DELIVERED`, its latest attempt is not `OUTPUT_VERIFIED`, its media verdict
   * is not `VALID`, or the reservation and deliverable pointer do not describe a
   * legitimate composition cycle. An ordinary outcome, not an error.
   */
  | { readonly kind: "NOT_ELIGIBLE" }
  /** No such Job visible to this organization, or it has no scenes at all. */
  | { readonly kind: "NOT_FOUND" };

/**
 * The fixed defect codes Transaction I may raise.
 *
 * Every one is an internal consistency violation — a state combination the
 * application believes it cannot produce. None carries customer input, provider
 * text, a storage location or an id, and none is repaired: silently rebuilding a
 * half-written plan would destroy the evidence of whatever wrote half of it.
 */
export type DeliverableCompositionDefectCode =
  /**
   * The Job says it is `COMPOSITION_PENDING`, but the durable plan behind that
   * claim is absent, incomplete, or does not describe this Job's scenes.
   */
  | "PARTIAL_PLAN_STATE"
  /** A media verdict is bound to different bytes than its attempt's verified receipt. */
  | "SOURCE_RECEIPT_BINDING_CONFLICT"
  /**
   * The ordered input set offered for fingerprinting repeats a Scene, repeats a
   * position, or is not in ascending position order.
   */
  | "PLAN_INPUT_ORDER_INVALID"
  /** The plan was written but the Job's current deliverable pointer moved with it. */
  | "CURRENT_DELIVERABLE_POINTER_MOVED";

const DEFECT_MESSAGES: Record<DeliverableCompositionDefectCode, string> = {
  PARTIAL_PLAN_STATE:
    "A job awaiting composition has no complete durable plan, and one will not be rebuilt automatically",
  SOURCE_RECEIPT_BINDING_CONFLICT:
    "A media validation is bound to different bytes than its attempt's verified receipt",
  PLAN_INPUT_ORDER_INVALID:
    "A composition input set repeats a scene or position, or is not in ascending position order",
  CURRENT_DELIVERABLE_POINTER_MOVED:
    "Composition planning changed the job's current deliverable pointer",
};

export class DeliverableCompositionDefect extends Error {
  readonly code: DeliverableCompositionDefectCode;

  constructor(code: DeliverableCompositionDefectCode) {
    super(DEFECT_MESSAGES[code]);
    this.name = "DeliverableCompositionDefect";
    this.code = code;
  }
}

/**
 * Prefix documenting the digest algorithm **and what the digest is about**.
 *
 * Deliberately not `sha256:<hex>` and deliberately not the storyboard's
 * `computeCompositionFingerprint` vocabulary. Three different digests now exist
 * in stored data and each answers a different question:
 *
 * - `sha256:<hex>` — ADR-0012's storyboard composition fingerprint: *was the
 *   storyboard composed from the eligible analysis set that exists today?*
 * - `sha256:v2:<hex>` — ADR-0034's generation request hash: *are these two
 *   provider requests the same request?*
 * - `sha256:deliverable-input:v1:<hex>` — this one: *was this deliverable
 *   version planned from this exact ordered set of validated scene bytes, for
 *   this exact frozen job delivery target?*
 *
 * None of them is an object content hash. The final video's own SHA-256 is a
 * fourth thing entirely and does not exist yet. Making the vocabulary visible in
 * the stored value is what keeps a future reader from comparing two of them.
 */
const DELIVERABLE_INPUT_FINGERPRINT_PREFIX = "sha256:deliverable-input:v1";

/** One frozen scene rendition, as it enters the fingerprint. */
export interface DeliverableInputFingerprintScene {
  readonly position: number;
  readonly generationSceneId: string;
  /** The Scene's `currentDeliveredRequestId` — the selection authority. */
  readonly sceneGenerationRequestId: string;
  readonly sceneGenerationAttemptId: string;
  readonly mediaValidationId: string;
  readonly sourceSha256: string;
  readonly sourceSizeBytes: bigint;
}

/**
 * The job's frozen delivery target, bound into the same digest.
 *
 * The same ordered bytes composed for 1080p 16:9 and for 720p 9:16 are not the
 * same deliverable. These three are snapshotted on the Job at creation and never
 * re-read from the mutable project, so binding them here freezes what the
 * customer was admitted under rather than what the project says today.
 */
export interface DeliverableInputFingerprintTarget {
  readonly targetOutputResolution: string;
  readonly targetAspectRatio: string;
  readonly requestedDurationSeconds: number;
}

/**
 * Digest identifying **one deliverable version's complete ordered input set**.
 *
 * The payload is a canonical structure, not concatenated text: the same
 * discipline as `computeCompositionFingerprint` and `computeGenerationRequestHash`.
 * Structure rather than a chosen separator is what keeps the encoding
 * unambiguous, so no id containing a delimiter can make two different plans
 * collide. Because every tuple is built positionally, the order properties
 * happen to arrive on the input objects cannot affect the result.
 *
 * `sourceSizeBytes` is serialized as its decimal string. `JSON.stringify`
 * refuses a `bigint` outright, and converting to `Number` would silently lose
 * precision above 2^53 — on the one value in the payload whose whole purpose is
 * to be exact.
 *
 * **Timestamps are absent**, deliberately: `createdAt`, `validatedAt` and
 * `deliveredAt` all move between two runs that selected identical bytes, and a
 * fingerprint that changed with them could never prove two plans equal.
 *
 * **The order is not repaired.** The caller supplies scenes in ascending
 * position order because that is the order the transaction locked and read them
 * in; sorting here would hide a reader that returned them in some other order,
 * and that reader's order is exactly what the fingerprint is supposed to
 * witness.
 *
 * @throws DeliverableCompositionDefect PLAN_INPUT_ORDER_INVALID
 */
export function computeDeliverableInputFingerprint(
  target: DeliverableInputFingerprintTarget,
  scenes: readonly DeliverableInputFingerprintScene[],
): string {
  assertPlanInputOrder(scenes);
  const canonical: readonly [
    readonly [string, string, number],
    readonly (readonly [number, string, string, string, string, string, string])[],
  ] = [
    [target.targetOutputResolution, target.targetAspectRatio, target.requestedDurationSeconds],
    scenes.map(
      (scene): readonly [number, string, string, string, string, string, string] => [
        scene.position,
        scene.generationSceneId,
        scene.sceneGenerationRequestId,
        scene.sceneGenerationAttemptId,
        scene.mediaValidationId,
        scene.sourceSha256,
        scene.sourceSizeBytes.toString(),
      ],
    ),
  ];
  return `${DELIVERABLE_INPUT_FINGERPRINT_PREFIX}:${sha256Hex(JSON.stringify(canonical))}`;
}

/**
 * Every scene appears once, at one position, in ascending position order.
 *
 * The database enforces the two uniqueness halves on the stored rows, and this
 * enforces them one step earlier — on the set that is about to be hashed — so a
 * plan that would violate them never acquires a fingerprint that looks valid.
 */
function assertPlanInputOrder(scenes: readonly DeliverableInputFingerprintScene[]): void {
  const seen = new Set<string>();
  let previous: number | null = null;
  for (const scene of scenes) {
    if (seen.has(scene.generationSceneId)) {
      throw new DeliverableCompositionDefect("PLAN_INPUT_ORDER_INVALID");
    }
    seen.add(scene.generationSceneId);
    if (previous !== null && scene.position <= previous) {
      throw new DeliverableCompositionDefect("PLAN_INPUT_ORDER_INVALID");
    }
    previous = scene.position;
  }
}

/**
 * The event vocabulary Transaction I appends, through the existing writer.
 *
 * Fixed application-owned strings. Nothing derived from a provider, a prompt, a
 * storage key, a filename or an exception reaches event metadata.
 */
export const DELIVERABLE_PLANNED_EVENT_TYPE = "deliverable.planned";
export const JOB_COMPOSITION_PENDING_EVENT_TYPE = "job.composition_pending";

/** The state a planned deliverable version is recorded as entering. */
export const DELIVERABLE_PLANNED_STATE = "PLANNED";

/** The reason code recorded on every Transaction I transition. */
export const COMPOSITION_PLAN_REASON_CODE = "DELIVERABLE_COMPOSITION_PLANNED";

/** The first ordinal any job's first deliverable version receives. */
export const FIRST_DELIVERABLE_ORDINAL = 1;
