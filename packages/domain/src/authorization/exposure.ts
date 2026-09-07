import { deepFreeze } from "@app/shared";
import { yen, type Yen } from "../pricing/units";
import type { GenerationAttemptState } from "../orchestration/types";

/**
 * Which attempts are costing money right now, in one place.
 *
 * Every repository that aggregates provider-cost exposure reads these sets
 * rather than writing its own state list. A duplicated list is how an attempt
 * ends up counted twice, or — much worse — not at all: the Safety Guard is only
 * as honest as the states it remembers to look at, and a list copied into a
 * second query drifts the first time a state is added.
 *
 * The three categories are disjoint **by construction**, asserted by a test.
 * An attempt contributes to exactly one of them, so no arithmetic here can
 * double-count and none can silently drop a state.
 */

/**
 * Cost that is already known to have been incurred.
 *
 * Deliberately **empty**, and that is a statement rather than an oversight.
 * Phase 4C-3B-2E persists an *estimate* — `estimatedPlanningCostMicroUsd` — and
 * nothing anywhere persists what a provider actually billed. Treating the
 * estimate as actual would put a projection into the field a margin review
 * reads as fact, and the difference between those two is the entire point of
 * having both.
 *
 * So known actual cost is modelled as an explicit input that is currently
 * always zero, sourced from nothing. Production activation requires the
 * provider-outcome ingestion path that would populate it; until then the Safety
 * Guard runs on estimates alone and the completion report says so.
 */
export const KNOWN_ACTUAL_COST_ATTEMPT_STATES: readonly GenerationAttemptState[] = deepFreeze(
  [] as const,
);

/**
 * Attempts whose acceptance by the provider is unresolved.
 *
 * `RECONCILIATION_PENDING` is the state the platform enters when it does not
 * know whether a submission was accepted, and the honest assumption is that it
 * was: an attempt that may have been billed must be carried as exposure until
 * reconciliation says otherwise. Releasing it because a worker restarted, or
 * because the deadline passed without an answer, would make a crash look like
 * a refund.
 *
 * `RECONCILIATION_EXHAUSTED` is deliberately **not** here. It is a terminal
 * state reached after the reconciliation policy has run out of ways to find
 * out, and whatever it concluded belongs in actual cost, not in a category
 * named for open questions. Counting it as uncertain forever would hold
 * exposure against an organization with no path to release it.
 */
export const UNCERTAIN_COST_ATTEMPT_STATES: readonly GenerationAttemptState[] = deepFreeze([
  "RECONCILIATION_PENDING",
] as const);

/**
 * Attempts at or past the provider boundary whose cost lifecycle is unfinished.
 *
 * `SUBMITTING` counts from the instant the boundary commits, before any HTTP
 * call is made. That is the conservative direction and the only safe one: an
 * attempt that crashed mid-POST is indistinguishable from one that never sent,
 * and the difference is a charge.
 *
 * `PROCESSING` and `PROVIDER_SUCCEEDED` are unambiguously billable — the
 * provider has the work. `OUTPUT_INGESTING` still counts because the provider's
 * charge does not depend on whether the platform finished copying the result.
 *
 * `OUTPUT_VERIFIED`, `FAILED_TERMINAL`, `FAILED_RETRYABLE` and
 * `CANCELLED_PRE_SUBMISSION` are absent. The first three have finished their
 * cost lifecycle — what they cost is settled and belongs to actual cost once
 * that path exists — and the last never crossed the boundary at all.
 *
 * `RECONCILIATION_PENDING` is absent **because it is uncertain**, not because
 * it is free. Listing it in both sets is the double-count this separation
 * exists to prevent.
 */
export const IN_FLIGHT_COST_ATTEMPT_STATES: readonly GenerationAttemptState[] = deepFreeze([
  "SUBMITTING",
  "PROCESSING",
  "PROVIDER_SUCCEEDED",
  "OUTPUT_INGESTING",
] as const);

/** Every state that contributes provider-cost exposure, in one list. */
export const COST_EXPOSED_ATTEMPT_STATES: readonly GenerationAttemptState[] = deepFreeze([
  ...UNCERTAIN_COST_ATTEMPT_STATES,
  ...IN_FLIGHT_COST_ATTEMPT_STATES,
] as const);

/**
 * The provider-cost exposure of one organization's billing cycle.
 *
 * Every component is a yen amount and every one is named, because a single
 * total is unauditable: when the guard pauses an organization, the operator
 * needs to see which category moved.
 */
export interface ProviderCostExposure {
  /** Actually incurred. Currently always zero — see the constant above. */
  readonly knownActualCostYen: Yen;
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
      exposure.uncertainCostYen +
      exposure.inFlightCostYen +
      exposure.nextProjectedCostYen,
  );
}
