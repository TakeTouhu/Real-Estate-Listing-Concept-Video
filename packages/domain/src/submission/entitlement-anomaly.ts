import { deepFreeze } from "@app/shared";
import type {
  GenerationReservationState,
  SceneGenerationRequestKind,
} from "../orchestration/types";

/**
 * What the entitlement bookkeeping looked like when provider reality landed.
 *
 * After the paid boundary, an inconsistent reservation must never stop the
 * outcome being written — the provider may already have been paid, and losing
 * that fact is the more expensive mistake by far. But "must not block" was
 * being implemented as "must not mention": a missing or released reservation
 * produced an ordinary `APPLIED` and vanished, so nobody found out that money
 * had been spent against bookkeeping that did not add up.
 *
 * Both properties are needed. The write proceeds, *and* the anomaly is recorded
 * durably enough to survive the process that noticed it. This enum is the
 * closed vocabulary that makes the second half possible: a value from a fixed
 * set, safe to put in transition metadata, never provider or customer text.
 */
export type EntitlementAnomaly =
  /** Bookkeeping was consistent with this request kind. */
  | "NONE"
  /** The job has no reservation row at all. */
  | "RESERVATION_MISSING"
  /** The reservation was already released before the outcome landed. */
  | "RESERVATION_RELEASED"
  /** Still mid-reservation: the boundary was crossed before reserving finished. */
  | "RESERVATION_RESERVING"
  /**
   * An `INITIAL` request standing on a spent unit.
   *
   * A `USER_REGENERATION` running against a `CONSUMED` reservation is correct by
   * contract — the regeneration right is sold with the original video and
   * exercised after delivery, by which time the unit is spent by design. An
   * `INITIAL` request has no such story: its unit should still be held, and a
   * consumed one means the first video was already paid out for this job.
   */
  | "INITIAL_RESERVATION_ALREADY_CONSUMED"
  /**
   * Any other reservation state that cannot be explained for this request.
   *
   * Currently **unreachable**, and deliberately kept. `classifyEntitlementAnomaly`
   * switches exhaustively over `GenerationReservationState`, so a new state
   * fails to compile there rather than falling through to this label — which is
   * the better failure. This member exists so that whoever adds that state has
   * somewhere honest to put it while they decide, instead of reaching for
   * `NONE`.
   */
  | "RESERVATION_STATE_INCONSISTENT";

export const ENTITLEMENT_ANOMALIES: readonly EntitlementAnomaly[] = deepFreeze([
  "NONE",
  "RESERVATION_MISSING",
  "RESERVATION_RELEASED",
  "RESERVATION_RESERVING",
  "INITIAL_RESERVATION_ALREADY_CONSUMED",
  "RESERVATION_STATE_INCONSISTENT",
] as const);

/**
 * Classify the entitlement bookkeeping behind one attempt.
 *
 * The request kind is loaded from the persisted chain, never supplied by the
 * caller: it is the fact that separates a correct `CONSUMED` from an anomalous
 * one, and a caller able to assert it could relabel an entitlement anomaly as
 * routine by claiming a regeneration that never happened.
 *
 * This never refuses. Its whole output is a label.
 */
export function classifyEntitlementAnomaly(input: {
  readonly requestKind: SceneGenerationRequestKind;
  readonly reservationState: GenerationReservationState | null;
}): EntitlementAnomaly {
  const { requestKind, reservationState } = input;
  if (reservationState === null) return "RESERVATION_MISSING";

  switch (reservationState) {
    case "RESERVED":
      return "NONE";
    case "RECONCILIATION_HOLD":
      // Already suspended, by an earlier uncertainty entry on this same job.
      // Expected on any second attempt, and not an anomaly.
      return "NONE";
    case "CONSUMED":
      return requestKind === "USER_REGENERATION"
        ? "NONE"
        : "INITIAL_RESERVATION_ALREADY_CONSUMED";
    case "RELEASED":
      return "RESERVATION_RELEASED";
    case "RESERVING":
      return "RESERVATION_RESERVING";
  }
}
