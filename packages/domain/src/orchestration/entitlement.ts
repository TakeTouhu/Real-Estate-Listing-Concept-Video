import { videoUnitsForSeconds, type PricingResult } from "../pricing/index";
import {
  MAX_USER_REGENERATIONS_PER_SCENE,
  type GenerationAttemptKind,
  type GenerationQualityTier,
  type SceneGenerationRequestKind,
  type SceneGenerationRequestState,
} from "./types";

/**
 * What a customer's entitlement buys, derived rather than counted.
 *
 * Every rule here answers one question: when is a customer's right actually
 * spent? The answer is always "when they received what they asked for", never
 * "when they asked" and never "when the platform tried".
 */

/**
 * The units one job must hold before any provider is contacted.
 *
 * High quality reserves the same total *and* marks that total as high quality.
 * It does not reserve twice: the high-quality allowance sits **inside** the
 * total allowance, so a 60-second high-quality video is two total units, two of
 * which are high quality — not two plus two. Treating it as additive would
 * silently double every high-quality customer's consumption.
 */
export interface RequiredGenerationUnits {
  readonly totalVideoUnits: number;
  readonly highQualityUnits: number;
}

/**
 * How many units a job requires, **delegated** to the customer pricing domain.
 *
 * This function used to carry its own `Math.ceil(seconds / 30)`, which was a
 * second implementation of a contract Phase 4C-3B-2D already owns — and it
 * disagreed with the original in the place that matters commercially: it
 * happily turned 91 seconds into four units, inventing an entitlement tier the
 * product does not sell. The product ceiling is 90 seconds, and beyond it the
 * correct answer is a refusal, not a bigger number.
 *
 * Returning a `PricingResult` rather than throwing, because an over-long
 * duration is an ordinary customer input the caller must handle, and it is the
 * same shape `videoUnitsForSeconds` already uses.
 */
export function requiredUnitsFor(
  qualityTier: GenerationQualityTier,
  totalDurationSeconds: number,
): PricingResult<RequiredGenerationUnits> {
  const units = videoUnitsForSeconds(totalDurationSeconds);
  if (!units.ok) return units;
  return {
    ok: true,
    value: {
      totalVideoUnits: units.value,
      highQualityUnits: qualityTier === "HIGH_QUALITY" ? units.value : 0,
    },
  };
}

/**
 * One delivered rendition request, reduced to the only two facts that decide
 * whether a regeneration right was spent.
 */
export interface RegenerationLedgerEntry {
  readonly kind: SceneGenerationRequestKind;
  readonly state: SceneGenerationRequestState;
}

/**
 * How many user regenerations a scene has actually consumed.
 *
 * **Derived, never stored.** A mutable counter incremented when a request is
 * created drifts the first time a provider fails: the customer asked once, the
 * platform failed twice, and a counter cannot tell those apart afterwards.
 * Counting `DELIVERED` requests can only ever be right, because the fact it
 * counts is the fact the entitlement is defined in terms of.
 *
 * `INITIAL` never counts. `PENDING`, `GENERATING`, `FAILED_TERMINAL` and
 * `CANCELLED` never count either — a customer whose regeneration failed still
 * has their right.
 */
export function usedUserRegenerationCount(
  requests: readonly RegenerationLedgerEntry[],
): number {
  return requests.filter(
    (entry) => entry.kind === "USER_REGENERATION" && entry.state === "DELIVERED",
  ).length;
}

/** Whether the customer may still ask for another rendition of this scene. */
export function mayAdmitUserRegeneration(
  requests: readonly RegenerationLedgerEntry[],
): boolean {
  return usedUserRegenerationCount(requests) < MAX_USER_REGENERATIONS_PER_SCENE;
}

/**
 * The ordinal the next user regeneration request would carry.
 *
 * `null` when the entitlement is exhausted, so a caller that forgets to check
 * cannot produce a third ordinal — the database would reject it, but failing
 * here names the reason instead of surfacing a constraint violation.
 *
 * The ordinal is derived from *delivered* requests, which means a failed
 * regeneration does not burn an ordinal any more than it burns the right.
 */
export function nextUserRegenerationOrdinal(
  requests: readonly RegenerationLedgerEntry[],
): number | null {
  const used = usedUserRegenerationCount(requests);
  return used < MAX_USER_REGENERATIONS_PER_SCENE ? used + 1 : null;
}

/**
 * How many times the platform has retried this request on its own account.
 *
 * Counted over attempt kinds, entirely separately from the customer's
 * regeneration usage. The two must never share a counter: a provider outage
 * would otherwise consume rights the customer never exercised.
 */
export function systemRecoveryAttemptCount(
  attempts: readonly { readonly attemptKind: GenerationAttemptKind }[],
): number {
  return attempts.filter((attempt) => attempt.attemptKind === "SYSTEM_RECOVERY").length;
}

/**
 * The ordinal a new attempt on a request would carry.
 *
 * Scoped to the parent request and never reused, so `(requestId, ordinal)` can
 * be a unique key: an ordinal that repeats would let two rows claim to be the
 * same attempt, which is the shape of a duplicate submission.
 */
export function nextAttemptOrdinal(
  attempts: readonly { readonly attemptOrdinal: number }[],
): number {
  return attempts.reduce((highest, a) => Math.max(highest, a.attemptOrdinal), 0) + 1;
}
