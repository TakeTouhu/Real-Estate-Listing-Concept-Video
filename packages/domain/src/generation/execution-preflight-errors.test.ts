import { describe, expect, it } from "vitest";
import {
  PREFLIGHT_REFUSAL_REASONS,
  type PreflightFailureState,
  type PreflightRefusalReason,
  preflightDispositionFor,
  preflightFailureStateFor,
} from "./execution-preflight-errors";
import { canTransition, isActiveGenerationState, isTerminalGenerationState } from "./state-machine";

/**
 * Where each refusal parks, written out independently of the module's own
 * derivation.
 *
 * This is the point of the file. `preflightFailureStateFor` reaches its answer
 * through `preflightDispositionFor`, so a test that also went through the
 * disposition would prove only that the same function returns the same value
 * twice. Naming the expected **state** for every reason here means the two
 * chains are independent: an edit to either table has to be made here too,
 * deliberately.
 */
const EXPECTED: Record<PreflightRefusalReason, PreflightFailureState> = {
  LEGACY_SNAPSHOT_MISSING: "FAILED_TERMINAL",
  LEGACY_PROMPT_MISSING: "FAILED_TERMINAL",
  REQUEST_HASH_MISMATCH: "FAILED_TERMINAL",
  PROVIDER_IDENTITY_MISMATCH: "FAILED_TERMINAL",
  MODEL_UNAVAILABLE: "FAILED_RETRYABLE",
  MODEL_DELIVERY_PLAN_CHANGED: "FAILED_TERMINAL",
  ASSET_NOT_FOUND: "FAILED_TERMINAL",
  ASSET_NOT_READY: "FAILED_RETRYABLE",
  ASSET_UPLOAD_FAILED: "FAILED_RETRYABLE",
  ASSET_UNRECOVERABLE: "FAILED_TERMINAL",
  ASSET_FORMAT_UNSUPPORTED: "FAILED_TERMINAL",
  ASSET_SOURCE_UNIDENTIFIABLE: "FAILED_TERMINAL",
  ASSET_SOURCE_CHANGED: "FAILED_TERMINAL",
  ASSET_OBJECT_MISSING: "FAILED_TERMINAL",
  STORAGE_UNAVAILABLE: "FAILED_RETRYABLE",
  SIGNED_SOURCE_URL_UNUSABLE: "FAILED_RETRYABLE",
};

describe("preflightFailureStateFor", () => {
  it.each(PREFLIGHT_REFUSAL_REASONS)("parks %s in its documented state", (reason) => {
    expect(preflightFailureStateFor(reason)).toBe(EXPECTED[reason]);
  });

  it("covers the whole reason vocabulary and nothing else", () => {
    // Guards the table above against silently drifting out of step with the
    // vocabulary: a seventeenth reason would make this fail rather than quietly
    // going untested.
    expect(Object.keys(EXPECTED).sort()).toEqual([...PREFLIGHT_REFUSAL_REASONS].sort());
    expect(PREFLIGHT_REFUSAL_REASONS).toHaveLength(16);
  });

  it("returns only the two failure states, for every reason", () => {
    for (const reason of PREFLIGHT_REFUSAL_REASONS) {
      expect(["FAILED_RETRYABLE", "FAILED_TERMINAL"]).toContain(
        preflightFailureStateFor(reason),
      );
    }
  });

  it("agrees with the disposition it derives from", () => {
    // The derivation itself: RETRYABLE parks retryable, TERMINAL parks terminal.
    // Asserted as a property over all sixteen rather than as two hand-picked
    // examples, so an inverted mapping cannot survive by luck.
    for (const reason of PREFLIGHT_REFUSAL_REASONS) {
      const expected =
        preflightDispositionFor(reason) === "RETRYABLE" ? "FAILED_RETRYABLE" : "FAILED_TERMINAL";
      expect(preflightFailureStateFor(reason)).toBe(expected);
    }
  });

  it("partitions the vocabulary — neither state is unreachable", () => {
    // A mapping that sent all sixteen to one state would pass every assertion
    // above that did not name a specific reason.
    const states = PREFLIGHT_REFUSAL_REASONS.map(preflightFailureStateFor);
    expect(states).toContain("FAILED_RETRYABLE");
    expect(states).toContain("FAILED_TERMINAL");
    // Phase 4C-3B-2B added one to each side: MODEL_UNAVAILABLE is retryable
    // (a catalog entry can come back), MODEL_DELIVERY_PLAN_CHANGED is not (a
    // corrected delivery plan needs a new admission, not a retry).
    expect(states.filter((s) => s === "FAILED_RETRYABLE")).toHaveLength(5);
    expect(states.filter((s) => s === "FAILED_TERMINAL")).toHaveLength(11);
  });

  it("only ever names a state QUEUED is legally allowed to reach", () => {
    // The link between this helper and the state machine. If the amendment were
    // reverted, or the helper started naming some third state, this fails —
    // rather than the adapter discovering it at runtime through
    // `assertTransition` with a row already selected.
    for (const reason of PREFLIGHT_REFUSAL_REASONS) {
      expect(canTransition("QUEUED", preflightFailureStateFor(reason))).toBe(true);
    }
  });

  it("never parks a refusal in a state that licenses a provider call", () => {
    // The failure this narrow return type exists to prevent: a helper about
    // work that will not be submitted must never produce SUBMITTING.
    for (const reason of PREFLIGHT_REFUSAL_REASONS) {
      expect(preflightFailureStateFor(reason)).not.toBe("SUBMITTING");
      expect(preflightFailureStateFor(reason)).not.toBe("PROCESSING");
      expect(preflightFailureStateFor(reason)).not.toBe("SUCCEEDED");
    }
  });

  it("keeps the identity consequence of each parking spot", () => {
    // Retryable parks hold the request identity so admission reuses the
    // attempt; terminal parks release it so a deliberate later admission can
    // create a new one. This is the observable difference between the two, and
    // it is a property of the states, not of this helper — asserted here
    // because the helper is what decides which one a refusal gets.
    expect(isActiveGenerationState("FAILED_RETRYABLE")).toBe(true);
    expect(isTerminalGenerationState("FAILED_TERMINAL")).toBe(true);
  });
});
