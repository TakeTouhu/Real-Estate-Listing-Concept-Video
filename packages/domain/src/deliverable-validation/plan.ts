/**
 * What a composed deliverable must measure to be the video that was planned
 * (ADR-0081).
 *
 * The generic media policy proves the bytes are a usable MP4-family video and
 * reports their facts; it deliberately compares them with nothing. This is the
 * comparison, for a deliverable only: the frame size of the composition's frozen
 * profile, and the length the job was admitted for.
 *
 * ## Why the plan, and not the provider
 *
 * Scene outputs are not compared with anything, because a provider's native
 * resolution is not the customer's target (`ManagedOutputMediaFacts`). A
 * deliverable is different: this platform's own composer made it, padding every
 * scene into the frozen raster and holding or trimming each to its planned
 * length, and the composition runner blocks a plan whose scenes do not sum to
 * the admitted length before composing it. A deliverable of another size or
 * length is therefore one the composer got wrong, and the honest verdict is that
 * it is not the video that was planned.
 *
 * ## The one tolerance
 *
 * The frame size is compared exactly. The length is compared within one frame
 * period of the frozen rate, rounded up to whole milliseconds (34 ms at 30 fps):
 * the container's duration is rounded to the millisecond on the way in, and a
 * frame is the smallest step the composer can take. A missing or extra scene is
 * at least a second, far outside it.
 */

import type {
  ManagedOutputMediaFacts,
  ManagedOutputMediaInvalidReason,
} from "../provider-output/media-validation";
import { DeliverableValidationDefect } from "./durable";

/** The measurements a deliverable must have. Derived, never stored. */
export interface PlannedDeliverableMedia {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly durationMs: number;
  /** One frame period of the frozen rate, rounded up to whole milliseconds. */
  readonly durationToleranceMs: number;
}

/** The two ways a usable video can fail to be the planned one. */
export type DeliverableOffPlanReason = Extract<
  ManagedOutputMediaInvalidReason,
  "VIDEO_DIMENSIONS_INVALID" | "DURATION_INVALID"
>;

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The plan for one deliverable version: its composition's frozen raster and
 * rate, and its job's admitted length.
 *
 * @throws DeliverableValidationDefect PERSISTED_RECORD_MALFORMED when any value
 * is not a positive safe integer, which no row this build writes can hold.
 */
export function plannedDeliverableMedia(input: {
  readonly targetWidthPx: number;
  readonly targetHeightPx: number;
  readonly frameRateNumerator: number;
  readonly frameRateDenominator: number;
  readonly requestedDurationSeconds: number;
}): PlannedDeliverableMedia {
  const durationMs = input.requestedDurationSeconds * 1000;
  if (
    !isPositiveSafeInteger(input.targetWidthPx) ||
    !isPositiveSafeInteger(input.targetHeightPx) ||
    !isPositiveSafeInteger(input.frameRateNumerator) ||
    !isPositiveSafeInteger(input.frameRateDenominator) ||
    !isPositiveSafeInteger(input.requestedDurationSeconds) ||
    !isPositiveSafeInteger(durationMs)
  ) {
    throw new DeliverableValidationDefect("PERSISTED_RECORD_MALFORMED");
  }
  const framePeriodMs = 1000 * input.frameRateDenominator;
  return {
    widthPx: input.targetWidthPx,
    heightPx: input.targetHeightPx,
    durationMs,
    // Integer ceiling, so no rate rounds its own frame period down.
    durationToleranceMs: Math.floor(
      (framePeriodMs + input.frameRateNumerator - 1) / input.frameRateNumerator,
    ),
  };
}

/**
 * Why measured facts are not the planned video, or `null` when they are.
 *
 * The size is judged first, so facts wrong in both are refused with the same
 * reason on every worker and every attempt.
 */
export function deliverableOffPlanReason(
  facts: ManagedOutputMediaFacts,
  plan: PlannedDeliverableMedia,
): DeliverableOffPlanReason | null {
  if (facts.videoWidth !== plan.widthPx || facts.videoHeight !== plan.heightPx) {
    return "VIDEO_DIMENSIONS_INVALID";
  }
  if (Math.abs(facts.durationMs - plan.durationMs) > plan.durationToleranceMs) {
    return "DURATION_INVALID";
  }
  return null;
}
