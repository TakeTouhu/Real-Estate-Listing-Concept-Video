import { deepFreeze } from "@app/shared";
import { yen, type Yen } from "../pricing/units";
import type { GenerationAttemptState, SubmissionCertainty } from "../orchestration/types";

/**
 * Which attempts are costing money, in one place.
 *
 * Every repository that aggregates provider-cost exposure classifies through
 * {@link classifyProviderCostExposure} rather than writing its own state list. A
 * duplicated list is how an attempt ends up counted twice, or — much worse — not
 * at all: the Safety Guard is only as honest as the states it remembers to look
 * at, and a list copied into a second query drifts the first time a state is
 * added.
 *
 * **Execution state alone is not the question.** An attempt's cost depends on
 * whether it crossed the provider boundary, and that is `submissionCertainty`,
 * a separate axis. `FAILED_TERMINAL` says the work is over; it says nothing
 * about whether the provider was paid, and the same state covers both "the
 * provider ran it and billed us, then the output failed validation" and "the
 * provider refused it outright". Classifying on state alone would treat those
 * identically and silently drop the first from the guard.
 *
 * The categories are disjoint by construction — one call, one answer — so no
 * arithmetic here can double-count and none can silently drop a pair.
 */

/** Which bucket one attempt's provider cost belongs to. */
export type ProviderCostExposureCategory =
  | "KNOWN_ACTUAL"
  | "SETTLED_ESTIMATED"
  | "UNCERTAIN"
  | "IN_FLIGHT"
  | "NONE";

/**
 * States that carry cost regardless of what certainty says.
 *
 * At these states the attempt is either at the provider or unresolved with it,
 * so no certainty value makes the money go away — including a certainty column
 * that disagrees with the state, which is a corruption to survive
 * conservatively rather than a reason to stop counting.
 *
 * Exported so a persistence prefilter can narrow before classifying, never so a
 * caller can classify with it. {@link isPotentiallyCostExposed} is the predicate
 * a query must mirror, and a test proves the mirror covers everything the
 * classifier counts.
 */
export const ALWAYS_COST_EXPOSED_ATTEMPT_STATES: readonly GenerationAttemptState[] = deepFreeze([
  "SUBMITTING",
  "PROCESSING",
  "PROVIDER_SUCCEEDED",
  "OUTPUT_INGESTING",
  "RECONCILIATION_PENDING",
  "RECONCILIATION_EXHAUSTED",
] as const);

/**
 * Certainties that carry cost at any other state.
 *
 * `ACCEPTED` means the provider took the work; whatever happened afterwards, it
 * was billed. `SUBMISSION_UNKNOWN` means nobody can say — and an attempt that
 * may have been billed must be carried until something establishes it was not.
 */
export const COST_BEARING_SUBMISSION_CERTAINTIES: readonly SubmissionCertainty[] = deepFreeze([
  "ACCEPTED",
  "SUBMISSION_UNKNOWN",
] as const);

/**
 * The prefilter a persistence query mirrors: could this pair cost anything?
 *
 * Deliberately wider than the classifier. A prefilter that is too narrow drops
 * exposure before anything can classify it; one that is slightly too wide costs
 * a row that classifies to `NONE`.
 */
export function isPotentiallyCostExposed(
  state: GenerationAttemptState,
  certainty: SubmissionCertainty,
): boolean {
  if (certainty === "DEFINITIVELY_REJECTED") return false;
  return (
    ALWAYS_COST_EXPOSED_ATTEMPT_STATES.includes(state) ||
    COST_BEARING_SUBMISSION_CERTAINTIES.includes(certainty)
  );
}

/**
 * Which exposure bucket one attempt belongs to, from both of its axes.
 *
 * The rules, in the order they are applied:
 *
 * 1. `DEFINITIVELY_REJECTED` is the one certainty that zeroes cost anywhere.
 *    The provider refused the submission; there is nothing to bill. It is the
 *    only negative fact strong enough to override the state.
 * 2. Reconciliation states are uncertain by definition — the platform tried to
 *    find out and could not. `RECONCILIATION_EXHAUSTED` included: exhausting the
 *    reconciliation window resolves the *customer's* entitlement, and resolves
 *    nothing at all about what the provider charged. Treating it as zero because
 *    the state is terminal would make giving up look like a refund.
 * 3. At or past the boundary with an unfinished lifecycle: in flight.
 * 4. Everything else is decided by certainty. `ACCEPTED` is settled estimated
 *    cost — the work crossed, the estimate is the best figure that exists.
 *    `SUBMISSION_UNKNOWN` is uncertain. `PRE_SUBMISSION` never crossed, and is
 *    the only way a terminal attempt costs nothing.
 *
 * Nothing here returns `KNOWN_ACTUAL`, and that is a statement rather than an
 * omission: no persisted field anywhere records what a provider actually
 * billed. The category exists in the type so that the ingestion path which will
 * populate it has a place to put its answer, and so the Safety Guard's
 * arithmetic does not have to change on the day it arrives.
 */
export function classifyProviderCostExposure(
  state: GenerationAttemptState,
  certainty: SubmissionCertainty,
): ProviderCostExposureCategory {
  if (certainty === "DEFINITIVELY_REJECTED") return "NONE";

  switch (state) {
    case "RECONCILIATION_PENDING":
    case "RECONCILIATION_EXHAUSTED":
      return "UNCERTAIN";
    case "SUBMITTING":
    case "PROCESSING":
    case "PROVIDER_SUCCEEDED":
    case "OUTPUT_INGESTING":
      return "IN_FLIGHT";
    case "QUEUED":
    case "CANCELLED_PRE_SUBMISSION":
    case "OUTPUT_VERIFIED":
    case "FAILED_RETRYABLE":
    case "FAILED_TERMINAL":
      return certainty === "PRE_SUBMISSION"
        ? "NONE"
        : certainty === "ACCEPTED"
          ? "SETTLED_ESTIMATED"
          : "UNCERTAIN";
    default: {
      // A new attempt state must not inherit whichever branch happened to be
      // last. This fails the build instead.
      const unreachable: never = state;
      return unreachable;
    }
  }
}

/**
 * The provider-cost exposure of one organization's billing cycle.
 *
 * Every component is a yen amount and every one is named, because a single
 * total is unauditable: when the guard pauses an organization, the operator
 * needs to see which category moved. All five are persisted with the
 * authorization event for exactly that reason.
 */
export interface ProviderCostExposure {
  /**
   * Actually incurred, as the provider billed it.
   *
   * Currently always zero, sourced from nothing. Phase 4C-3B-2E persists an
   * *estimate* and nothing persists an actual, and writing an estimate into
   * this field would put a projection where a margin review reads a fact.
   * Production activation requires the provider-cost ingestion path that
   * populates it — and that path replaces {@link settledEstimatedCostYen} for
   * the same attempts, rather than adding to it.
   */
  readonly knownActualCostYen: Yen;
  /**
   * Attempts that finished their lifecycle after crossing the boundary, still
   * valued at their immutable planning estimate.
   *
   * Conservative and explicitly **not** actual cost. The alternative was to drop
   * them the moment their execution ended, which would let a cycle's real spend
   * disappear from the guard one attempt at a time while the money stayed spent.
   */
  readonly settledEstimatedCostYen: Yen;
  /** Attempts whose acceptance is unresolved, at their planning estimate. */
  readonly uncertainCostYen: Yen;
  /** Attempts at or past the boundary, at their planning estimate. */
  readonly inFlightCostYen: Yen;
  /** The candidate attempt this authorization would add. */
  readonly nextProjectedCostYen: Yen;
}

/** The sum the Safety Guard subtracts from billing-cycle revenue. */
export function totalProviderCostExposureYen(exposure: ProviderCostExposure): Yen {
  return yen(
    exposure.knownActualCostYen +
      exposure.settledEstimatedCostYen +
      exposure.uncertainCostYen +
      exposure.inFlightCostYen +
      exposure.nextProjectedCostYen,
  );
}
