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
 *
 * ### The reservation is Job-scoped, and the attempt is not
 *
 * One `GenerationReservation` belongs to one `GenerationJob`, and a Job has many
 * scenes, each of which can have its own attempt at the provider boundary. So
 * several attempts can be durably unknown at once behind a *single* suspended
 * hold. Restoring that hold the moment the first of them resolves would lift a
 * Job-level suspension while the Job is still uncertain — the customer's unit
 * would look usable while money may still be being spent on a sibling nobody can
 * account for.
 *
 * That is why the restoring conclusions need one more persisted fact than the
 * reservation's own state: how many *other* attempts in the same Job are still
 * `RECONCILIATION_PENDING + SUBMISSION_UNKNOWN`.
 */

/** What this conclusion should do to a suspended hold. */
export type ReservationAction =
  /** `RECONCILIATION_HOLD → RESERVED`. The entitlement is usable again. */
  | "RESTORE"
  /** `RECONCILIATION_HOLD → RELEASED`. This path cannot continue. */
  | "RELEASE"
  /**
   * Stay in `RECONCILIATION_HOLD`, deliberately.
   *
   * The hold is exactly where it should be and is *kept* there because another
   * attempt in the same Job is still durably unknown. Distinct from `NONE`
   * because it is a decision rather than the absence of one: this conclusion
   * would have restored the hold, and the sibling is the reason it did not.
   *
   * Nothing is written for it — no state change, no version bump, and no
   * reservation transition event, because no transition occurred. The reason it
   * stayed is recorded on the *attempt's* event instead, as
   * `remainingPendingUnknownAttempts`.
   */
  | "KEEP_HOLD"
  /**
   * Touch nothing, for a reason that has nothing to do with siblings.
   *
   * A correct post-delivery `CONSUMED` unit, a missing reservation, an already
   * `RELEASED` one, or a state this phase did not put there.
   */
  | "NONE";

/**
 * Decide what happens to the reservation, from persisted facts only.
 *
 * Keyed on the **reservation's own state** first, because only a suspended hold
 * is a thing this phase put there. A `CONSUMED` unit stays spent whoever owns
 * it, a `RELEASED` one stays gone, and a `RESERVED` one is already where a
 * restore would put it. A post-delivery `USER_REGENERATION` reaches none of the
 * moves for exactly that reason: its reservation is `CONSUMED`, so the action is
 * `NONE` and the unit is never restored, released or spent again.
 *
 * Then, for the two conclusions that would *restore*, on whether this attempt
 * was the last durably unknown one in its Job:
 *
 * ```text
 * accepted            + no unknown siblings → RESTORE    the Job is certain again
 * accepted            + unknown siblings    → KEEP_HOLD  a sibling may still be costing money
 * retryable rejection + no unknown siblings → RESTORE    a recovery attempt may use this unit
 * retryable rejection + unknown siblings    → KEEP_HOLD
 * terminal rejection                        → RELEASE    this path cannot continue
 * exhaustion                                → RELEASE    the customer is made whole
 * ```
 *
 * The two releasing conclusions ignore siblings on purpose. Releasing is how the
 * customer stops being charged for a question nobody could answer, and making
 * that wait on an unrelated sibling would hold their money hostage to it. The
 * asymmetry is deliberate and one-way: `RELEASED` is terminal, so a later
 * conclusion from a sibling can never resurrect it.
 */
export function reservationActionFor(input: {
  readonly reservationState: GenerationReservationState | null;
  readonly conclusion: "ACCEPTED" | "REJECTED_RETRYABLE" | "REJECTED_TERMINAL" | "EXHAUSTED";
  /**
   * How many *other* attempts in the same `GenerationJob` are still
   * `RECONCILIATION_PENDING + SUBMISSION_UNKNOWN`, counted under the same lock
   * that serializes this decision. Never supplied by a caller.
   */
  readonly otherPendingUnknownAttemptsInJob: number;
}): ReservationAction {
  if (input.reservationState !== "RECONCILIATION_HOLD") return "NONE";
  switch (input.conclusion) {
    case "ACCEPTED":
    case "REJECTED_RETRYABLE":
      // Restoring rather than releasing is what keeps a retryable provider
      // failure actually retryable. Releasing here would hand the unit back and
      // leave a future SYSTEM_RECOVERY attempt with nothing to stand on — the
      // customer's request would be quietly unfinishable.
      //
      // But only when this attempt was the last unknown one in its Job. The
      // hold is Job-level; lifting it while a sibling is still unaccounted for
      // would say the Job is certain when it is not.
      return input.otherPendingUnknownAttemptsInJob === 0 ? "RESTORE" : "KEEP_HOLD";
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
