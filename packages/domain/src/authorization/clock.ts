import { epochMillis, type EpochMillis } from "../pricing/units";

/**
 * Where the authorization instant comes from — and, more to the point, where it
 * does not.
 *
 * Pricing eligibility is a function of time: a contract has an effective window,
 * and `evaluatePaidSubmissionPricingEligibility` refuses one that has expired.
 * When the instant arrives as caller input, a caller can choose a time at which
 * an expired contract was still eligible and authorize a paid submission against
 * a price the product no longer sells. That is not a hypothetical misuse — it is
 * the ordinary consequence of a worker passing along a timestamp it captured
 * when it picked the job up, which may be minutes old by the time it authorizes.
 *
 * So the instant is a dependency, not an argument. The service reads it **after
 * acquiring the cost-admission lock**, so a request that waited behind a long
 * queue is evaluated at the time it actually reached the front rather than at
 * the time it joined. It is read exactly once and the same value is used for
 * every part of one decision, so no two checks can disagree about when "now" is.
 *
 * Nothing in the domain calls `Date.now()` directly. A test injects a fixed
 * clock and gets a decision it can reason about; production injects the system
 * clock and gets one it cannot influence.
 */
export interface AuthorizationClock {
  now(): EpochMillis;
}

/** The production clock. The only place the domain reads wall time. */
export function createSystemAuthorizationClock(): AuthorizationClock {
  return {
    now(): EpochMillis {
      return epochMillis(Date.now());
    },
  };
}

/** A clock that always answers the same instant, for deterministic tests. */
export function createFixedAuthorizationClock(instant: EpochMillis): AuthorizationClock {
  return {
    now(): EpochMillis {
      return instant;
    },
  };
}
