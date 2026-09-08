import type {
  GenerationReservationState,
  SceneGenerationRequestKind,
} from "../orchestration/types";
import type { EntitlementAnomaly } from "../submission/entitlement-anomaly";

/**
 * What the customer's entitlement should do when uncertainty ends, and what to
 * say when it is not where it should be.
 *
 * The vocabulary is Phase 4C-3B-2G-1's `EntitlementAnomaly`, reused unchanged —
 * a second set of anomaly strings would be two vocabularies for one concept,
 * and an operator querying entitlement anomalies would have to know which phase
 * wrote each row. Only the *expectation* differs, and it has to: at the
 * submission boundary a healthy reservation is `RESERVED`, while an attempt in
 * reconciliation has already had its hold suspended, so `RECONCILIATION_HOLD`
 * is the healthy state here and `RESERVED` is the surprise.
 */

/** What this conclusion should do to a suspended hold. */
export type ReservationAction =
  /** `RECONCILIATION_HOLD → RESERVED`. The entitlement is usable again. */
  | "RESTORE"
  /** `RECONCILIATION_HOLD → RELEASED`. This path cannot continue. */
  | "RELEASE"
  /** Touch nothing. */
  | "NONE";

/**
 * Decide what happens to the reservation, from persisted facts only.
 *
 * Deliberately keyed on the **reservation's own state**, not the request kind.
 * Only a suspended hold moves, because only a suspended hold is a thing this
 * phase put there. A `CONSUMED` unit stays spent whoever owns it, a `RELEASED`
 * one stays gone, and a `RESERVED` one is already where a restore would put it.
 * That single rule delivers every case the brief enumerates without a matrix of
 * request kinds to get wrong:
 *
 * ```text
 * accepted            → RESTORE   the work is running; the unit is live again
 * retryable rejection → RESTORE   a future recovery attempt may use this unit
 * terminal rejection  → RELEASE   this path cannot continue
 * exhaustion          → RELEASE   unknowable at the deadline; the customer is made whole
 * ```
 *
 * A post-delivery `USER_REGENERATION` reaches none of them: its reservation is
 * `CONSUMED`, so the action is `NONE` and the unit is never restored, released
 * or spent again.
 */
export function reservationActionFor(input: {
  readonly reservationState: GenerationReservationState | null;
  readonly conclusion: "ACCEPTED" | "REJECTED_RETRYABLE" | "REJECTED_TERMINAL" | "EXHAUSTED";
}): ReservationAction {
  if (input.reservationState !== "RECONCILIATION_HOLD") return "NONE";
  switch (input.conclusion) {
    case "ACCEPTED":
    case "REJECTED_RETRYABLE":
      // Restoring rather than releasing is what keeps a retryable provider
      // failure actually retryable. Releasing here would hand the unit back and
      // leave a future SYSTEM_RECOVERY attempt with nothing to stand on — the
      // customer's request would be quietly unfinishable.
      return "RESTORE";
    case "REJECTED_TERMINAL":
    case "EXHAUSTED":
      return "RELEASE";
  }
}

/**
 * Classify the entitlement bookkeeping behind a reconciling attempt.
 *
 * Never refuses; its whole output is a label. The request kind comes from the
 * persisted chain, never from a caller — it is what separates a correct
 * `CONSUMED` (a post-delivery regeneration) from an anomalous one (an `INITIAL`
 * request standing on a spent unit), and a caller able to assert it could
 * relabel an anomaly as routine.
 */
export function classifyReconciliationEntitlement(input: {
  readonly requestKind: SceneGenerationRequestKind;
  readonly reservationState: GenerationReservationState | null;
}): EntitlementAnomaly {
  const { requestKind, reservationState } = input;
  if (reservationState === null) return "RESERVATION_MISSING";

  switch (reservationState) {
    case "RECONCILIATION_HOLD":
      // The healthy state for an attempt in reconciliation: Phase 2G-1
      // suspended it when uncertainty became durable.
      return "NONE";
    case "CONSUMED":
      // A post-delivery regeneration's unit is spent by design. An INITIAL
      // request has no such story — its own unit should still be held.
      return requestKind === "USER_REGENERATION"
        ? "NONE"
        : "INITIAL_RESERVATION_ALREADY_CONSUMED";
    case "RELEASED":
      return "RESERVATION_RELEASED";
    case "RESERVING":
      return "RESERVATION_RESERVING";
    case "RESERVED":
      // Not an error the platform can act on, but not right either: something
      // restored this hold without going through a reconciliation conclusion.
      // Recorded rather than silently released, because guessing a destructive
      // transition on bookkeeping that already disagrees with itself is how one
      // inconsistency becomes two.
      return "RESERVATION_STATE_INCONSISTENT";
  }
}
