import { describe, expect, it } from "vitest";
import {
  mayAdmitUserRegeneration,
  nextAttemptOrdinal,
  nextUserRegenerationOrdinal,
  requiredUnitsFor,
  systemRecoveryAttemptCount,
  usedUserRegenerationCount,
  type RegenerationLedgerEntry,
} from "./entitlement";
import { isCoherentAttemptRecord, reconciliationDeadlineFrom } from "./certainty";
import {
  ALLOWED_TRANSITION_METADATA_KEYS,
  FORBIDDEN_TRANSITION_METADATA_KEYS,
  sanitizeTransitionMetadata,
} from "./transition-metadata";
import { MAX_USER_REGENERATIONS_PER_SCENE } from "./types";

/**
 * The accounting rules, asserted as the separations they exist to enforce.
 *
 * Each of these has a specific way of going wrong in production, and the tests
 * are written against that failure rather than against the implementation:
 * counting a right at request time, counting a platform retry as a customer
 * choice, or reserving a high-quality unit twice.
 */

const initial = (state: RegenerationLedgerEntry["state"]): RegenerationLedgerEntry => ({
  kind: "INITIAL",
  state,
});
const regen = (state: RegenerationLedgerEntry["state"]): RegenerationLedgerEntry => ({
  kind: "USER_REGENERATION",
  state,
});

describe("a regeneration right is spent on delivery and at no other moment", () => {
  it("does not charge the initial generation against the entitlement", () => {
    expect(usedUserRegenerationCount([initial("DELIVERED")])).toBe(0);
    expect(mayAdmitUserRegeneration([initial("DELIVERED")])).toBe(true);
    expect(nextUserRegenerationOrdinal([initial("DELIVERED")])).toBe(1);
  });

  it.each([["PENDING"], ["GENERATING"]] as const)(
    "does not spend the right while a regeneration is %s",
    (state) => {
      const ledger = [initial("DELIVERED"), regen(state)];
      expect(usedUserRegenerationCount(ledger)).toBe(0);
      expect(mayAdmitUserRegeneration(ledger)).toBe(true);
    },
  );

  it.each([["FAILED_TERMINAL"], ["CANCELLED"]] as const)(
    "returns the right when a regeneration ends %s",
    (state) => {
      // The platform failed the customer. Charging them a right for it would
      // make every provider outage cost the customer something.
      const ledger = [initial("DELIVERED"), regen(state)];
      expect(usedUserRegenerationCount(ledger)).toBe(0);
      expect(nextUserRegenerationOrdinal(ledger)).toBe(1);
    },
  );

  it("spends exactly one right on the first delivered regeneration", () => {
    const ledger = [initial("DELIVERED"), regen("DELIVERED")];
    expect(usedUserRegenerationCount(ledger)).toBe(1);
    expect(nextUserRegenerationOrdinal(ledger)).toBe(2);
    expect(mayAdmitUserRegeneration(ledger)).toBe(true);
  });

  it("spends the second right on the second delivered regeneration", () => {
    const ledger = [initial("DELIVERED"), regen("DELIVERED"), regen("DELIVERED")];
    expect(usedUserRegenerationCount(ledger)).toBe(2);
    expect(mayAdmitUserRegeneration(ledger)).toBe(false);
    expect(nextUserRegenerationOrdinal(ledger)).toBeNull();
  });

  it("refuses a third regeneration", () => {
    const exhausted = [
      initial("DELIVERED"),
      regen("DELIVERED"),
      regen("DELIVERED"),
      // A failed third attempt does not somehow grant a fourth either.
      regen("FAILED_TERMINAL"),
    ];
    expect(mayAdmitUserRegeneration(exhausted)).toBe(false);
    expect(nextUserRegenerationOrdinal(exhausted)).toBeNull();
    expect(MAX_USER_REGENERATIONS_PER_SCENE).toBe(2);
  });

  it("counts many in-flight regenerations as zero spent", () => {
    // The count is over delivered requests, so an implementation that counted
    // rows would report three here and lock the customer out.
    const ledger = [initial("DELIVERED"), regen("GENERATING"), regen("PENDING"), regen("CANCELLED")];
    expect(usedUserRegenerationCount(ledger)).toBe(0);
    expect(mayAdmitUserRegeneration(ledger)).toBe(true);
  });
});

describe("system recovery is not a customer regeneration", () => {
  it("counts recovery attempts on their own axis", () => {
    const attempts = [
      { attemptKind: "PRIMARY" as const },
      { attemptKind: "SYSTEM_RECOVERY" as const },
      { attemptKind: "SYSTEM_RECOVERY" as const },
    ];
    expect(systemRecoveryAttemptCount(attempts)).toBe(2);
  });

  it("leaves the customer's entitlement untouched however many times the platform retries", () => {
    // Six provider attempts, one delivered customer request: one right spent.
    const ledger = [initial("DELIVERED"), regen("DELIVERED")];
    const attempts = Array.from({ length: 6 }, (_, i) => ({
      attemptKind: i === 0 ? ("PRIMARY" as const) : ("SYSTEM_RECOVERY" as const),
    }));
    expect(systemRecoveryAttemptCount(attempts)).toBe(5);
    expect(usedUserRegenerationCount(ledger)).toBe(1);
  });

  it("allocates attempt ordinals that are never reused", () => {
    expect(nextAttemptOrdinal([])).toBe(1);
    expect(nextAttemptOrdinal([{ attemptOrdinal: 1 }])).toBe(2);
    // Even if an earlier attempt row were removed, the next ordinal is past the
    // highest ever seen rather than filling the gap: reusing an ordinal would
    // let two rows claim to be the same attempt.
    expect(nextAttemptOrdinal([{ attemptOrdinal: 1 }, { attemptOrdinal: 3 }])).toBe(4);
  });
});

describe("high-quality units sit inside the total, never beside it", () => {
  it("reserves total only for normal quality", () => {
    expect(requiredUnitsFor("NORMAL", 60)).toEqual({ totalVideoUnits: 2, highQualityUnits: 0 });
  });

  it("reserves the same total and marks it high quality", () => {
    // 60 seconds at high quality is 2 total and 2 high-quality — not 2 + 2.
    // Additive arithmetic here would double every high-quality customer's bill.
    expect(requiredUnitsFor("HIGH_QUALITY", 60)).toEqual({
      totalVideoUnits: 2,
      highQualityUnits: 2,
    });
  });

  it("never reports more high-quality units than total units", () => {
    for (const seconds of [1, 29, 30, 31, 60, 90, 121]) {
      const normal = requiredUnitsFor("NORMAL", seconds);
      const high = requiredUnitsFor("HIGH_QUALITY", seconds);
      expect(normal.highQualityUnits).toBeLessThanOrEqual(normal.totalVideoUnits);
      expect(high.highQualityUnits).toBe(high.totalVideoUnits);
    }
  });

  it("rounds a partial unit up", () => {
    // 31 seconds is two units. Rounding down would give away the second one.
    expect(requiredUnitsFor("NORMAL", 31).totalVideoUnits).toBe(2);
    expect(requiredUnitsFor("NORMAL", 30).totalVideoUnits).toBe(1);
    expect(requiredUnitsFor("NORMAL", 1).totalVideoUnits).toBe(1);
  });

  it.each([[0], [-30], [1.5], [Number.NaN]])("refuses a duration of %s", (seconds) => {
    expect(() => requiredUnitsFor("NORMAL", seconds)).toThrow(RangeError);
  });
});

describe("certainty and execution state are separate axes", () => {
  it("accepts the four contract pairings", () => {
    expect(
      isCoherentAttemptRecord({
        certainty: "PRE_SUBMISSION",
        state: "QUEUED",
        providerPredictionId: null,
      }),
    ).toBe(true);
    expect(
      isCoherentAttemptRecord({
        certainty: "ACCEPTED",
        state: "PROCESSING",
        providerPredictionId: "pred_1",
      }),
    ).toBe(true);
    expect(
      isCoherentAttemptRecord({
        certainty: "DEFINITIVELY_REJECTED",
        state: "FAILED_TERMINAL",
        providerPredictionId: null,
      }),
    ).toBe(true);
    expect(
      isCoherentAttemptRecord({
        certainty: "SUBMISSION_UNKNOWN",
        state: "RECONCILIATION_PENDING",
        providerPredictionId: null,
      }),
    ).toBe(true);
  });

  it("refuses a provider reference without acceptance", () => {
    // The hard rule: a prediction id implies ACCEPTED. Anything else means a
    // fabricated reference reached a paid attempt's permanent record.
    for (const certainty of [
      "PRE_SUBMISSION",
      "DEFINITIVELY_REJECTED",
      "SUBMISSION_UNKNOWN",
    ] as const) {
      expect(
        isCoherentAttemptRecord({
          certainty,
          state: "RECONCILIATION_PENDING",
          providerPredictionId: "pred_invented",
        }),
      ).toBe(false);
    }
  });

  it("refuses a rejected attempt that claims the provider is working", () => {
    expect(
      isCoherentAttemptRecord({
        certainty: "DEFINITIVELY_REJECTED",
        state: "PROCESSING",
        providerPredictionId: null,
      }),
    ).toBe(false);
  });

  it("refuses an accepted attempt that claims nothing was sent", () => {
    for (const state of ["QUEUED", "SUBMITTING", "CANCELLED_PRE_SUBMISSION"] as const) {
      expect(
        isCoherentAttemptRecord({ certainty: "ACCEPTED", state, providerPredictionId: null }),
      ).toBe(false);
    }
  });

  it("freezes a reconciliation deadline rather than recomputing it", () => {
    const started = new Date("2026-09-04T00:00:00.000Z");
    expect(reconciliationDeadlineFrom(started).toISOString()).toBe("2026-09-05T00:00:00.000Z");
    // A different configured window produces a different deadline, which is the
    // point: the value is snapshotted per attempt, so changing the default
    // later cannot move a deadline that was already written.
    expect(reconciliationDeadlineFrom(started, 60_000).toISOString()).toBe(
      "2026-09-04T00:01:00.000Z",
    );
  });

  it.each([[0], [-1], [1.5]])("refuses a reconciliation window of %s ms", (ms) => {
    expect(() => reconciliationDeadlineFrom(new Date(), ms)).toThrow(RangeError);
  });
});

describe("transition metadata cannot carry a prompt or a credential", () => {
  it("keeps the identifiers an operator needs", () => {
    const safe = sanitizeTransitionMetadata({
      attemptId: "sgen_1",
      attemptKind: "SYSTEM_RECOVERY",
      providerName: "wavespeed",
      reasonCode: "PROVIDER_TIMEOUT",
      stateVersion: 3,
    });
    expect(safe).toEqual({
      attemptId: "sgen_1",
      attemptKind: "SYSTEM_RECOVERY",
      providerName: "wavespeed",
      reasonCode: "PROVIDER_TIMEOUT",
      stateVersion: 3,
    });
  });

  it.each([
    ["requestCompiledPrompt"],
    ["requestRenderedPrompt"],
    ["compiledPrompt"],
    ["renderedPrompt"],
    ["prompt"],
    ["negativePrompt"],
    ["providerResponse"],
    ["providerRequest"],
    ["rawErrorBody"],
    ["providerOutputUrl"],
    ["signedUrl"],
    ["apiKey"],
    ["authorization"],
  ])("throws rather than silently dropping %s", (key) => {
    // Dropping quietly would hide the bug at its source. The value that leaks
    // is always the one somebody added in a hurry, so this fails loudly.
    expect(() => sanitizeTransitionMetadata({ [key]: "secret value" })).toThrow(
      /forbidden keys/,
    );
  });

  it("never echoes the offending value in the error it raises", () => {
    try {
      sanitizeTransitionMetadata({ requestCompiledPrompt: "a sunlit living room, cinematic" });
      throw new Error("expected a refusal");
    } catch (error) {
      const text = JSON.stringify({
        message: (error as Error).message,
        details: (error as { details?: unknown }).details,
      });
      expect(text).not.toContain("sunlit");
      expect(text).toContain("requestCompiledPrompt");
    }
  });

  /**
   * The allowlist is checked on its own terms, not through the forbidden list.
   *
   * Found by a surviving mutation. Adding `requestCompiledPrompt` to the
   * allowlist changed nothing observable, because the forbidden check fires
   * first — so the allowlist itself had no test at all. The dangerous version
   * of that mutation is the one nobody thought to forbid: allowlisting
   * `snapshotCompiledPrompt` would have leaked a prompt with every check
   * passing.
   */
  it("allowlists nothing that looks like a secret or free text", () => {
    const suspicious = /prompt|secret|token|credential|password|authorization|url|body|payload|response/i;
    const offenders = ALLOWED_TRANSITION_METADATA_KEYS.filter((key) => suspicious.test(key));
    expect(offenders).toEqual([]);
  });

  it("keeps the two lists disjoint", () => {
    // A key on both lists means one of them is wrong, and which one is wrong
    // depends on evaluation order — the kind of ambiguity that resolves itself
    // badly under a later refactor.
    const overlap = ALLOWED_TRANSITION_METADATA_KEYS.filter((key) =>
      FORBIDDEN_TRANSITION_METADATA_KEYS.includes(key),
    );
    expect(overlap).toEqual([]);
  });

  it("drops unknown keys quietly", () => {
    // An unrecognised key is probably a caller being imprecise rather than a
    // leak, so it is dropped rather than raised.
    expect(sanitizeTransitionMetadata({ someFutureField: "x", attemptId: "sgen_1" })).toEqual({
      attemptId: "sgen_1",
    });
  });

  it("drops values that are not scalars", () => {
    expect(
      sanitizeTransitionMetadata({ attemptId: { nested: "object" }, providerName: "fal" }),
    ).toEqual({ providerName: "fal" });
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(sanitizeTransitionMetadata({ attemptId: "sgen_1" }))).toBe(true);
  });
});
