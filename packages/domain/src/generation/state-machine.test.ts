import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  ACTIVE_SCENE_GENERATION_STATES,
  TERMINAL_SCENE_GENERATION_STATES,
  allowedTransitionsFrom,
  assertTransition,
  canTransition,
  isActiveGenerationState,
  isTerminalGenerationState,
} from "./state-machine";
import { SCENE_GENERATION_STATES, type SceneGenerationState } from "./types";

/**
 * The complete legal transition set, written out independently of the module's
 * own table. Asserting the two agree proves the contract rather than
 * re-reading the implementation, and any future edit to the table has to be
 * made here too — deliberately, not by accident.
 */
const EXPECTED: Readonly<Record<SceneGenerationState, readonly SceneGenerationState[]>> = {
  QUEUED: ["SUBMITTING", "CANCELLED"],
  SUBMITTING: ["PROCESSING", "FAILED_RETRYABLE", "FAILED_TERMINAL", "SUBMISSION_UNKNOWN"],
  PROCESSING: ["SUCCEEDED", "FAILED_RETRYABLE", "FAILED_TERMINAL"],
  FAILED_RETRYABLE: ["QUEUED"],
  SUBMISSION_UNKNOWN: [],
  SUCCEEDED: [],
  FAILED_TERMINAL: [],
  CANCELLED: [],
};

describe("the transition contract", () => {
  it.each(SCENE_GENERATION_STATES)("allows exactly the documented moves out of %s", (from) => {
    expect([...allowedTransitionsFrom(from)].sort()).toEqual([...EXPECTED[from]].sort());
  });

  it("agrees with canTransition across the whole vocabulary", () => {
    // The cartesian product, checked by table rather than 64 hand-written
    // cases: every pair not listed above must be refused.
    for (const from of SCENE_GENERATION_STATES) {
      for (const to of SCENE_GENERATION_STATES) {
        expect(canTransition(from, to)).toBe(EXPECTED[from].includes(to));
      }
    }
  });

  it("permits the submission path a worker actually walks", () => {
    expect(canTransition("QUEUED", "SUBMITTING")).toBe(true);
    expect(canTransition("SUBMITTING", "PROCESSING")).toBe(true);
    expect(canTransition("PROCESSING", "SUCCEEDED")).toBe(true);
  });

  it("permits cancelling only before anything has been sent", () => {
    expect(canTransition("QUEUED", "CANCELLED")).toBe(true);
    // Post-submission cancellation is provider-dependent and is not modelled.
    expect(canTransition("SUBMITTING", "CANCELLED")).toBe(false);
    expect(canTransition("PROCESSING", "CANCELLED")).toBe(false);
  });

  it("separates the three ways a submission can fail", () => {
    expect(canTransition("SUBMITTING", "FAILED_RETRYABLE")).toBe(true);
    expect(canTransition("SUBMITTING", "FAILED_TERMINAL")).toBe(true);
    expect(canTransition("SUBMITTING", "SUBMISSION_UNKNOWN")).toBe(true);
  });

  it("lets a demonstrably safe failure return to the start of the submission path", () => {
    expect(canTransition("FAILED_RETRYABLE", "QUEUED")).toBe(true);
    // But not straight back into a POST: it re-enters through QUEUED.
    expect(canTransition("FAILED_RETRYABLE", "SUBMITTING")).toBe(false);
  });

  it("can represent every verdict the provider port normalizes about a known prediction", () => {
    // `ProviderGenerationState` in @app/video-providers already distinguishes a
    // retryable prediction failure from a terminal one. A successful poll can
    // report either, so both must be reachable — otherwise Phase 4C would have
    // to misclassify a retryable failure as terminal.
    expect(canTransition("PROCESSING", "SUCCEEDED")).toBe(true);
    expect(canTransition("PROCESSING", "FAILED_RETRYABLE")).toBe(true);
    expect(canTransition("PROCESSING", "FAILED_TERMINAL")).toBe(true);
  });

  it("keeps one route back into a provider POST from a retryable prediction failure", () => {
    // The retry goes through FAILED_RETRYABLE, never straight from PROCESSING,
    // so `FAILED_RETRYABLE -> QUEUED -> SUBMITTING` stays the only path.
    expect(canTransition("PROCESSING", "QUEUED")).toBe(false);
    expect(canTransition("PROCESSING", "SUBMITTING")).toBe(false);
    expect(canTransition("FAILED_RETRYABLE", "QUEUED")).toBe(true);
    expect(canTransition("QUEUED", "SUBMITTING")).toBe(true);
  });

  it("has no edge for a failing status GET, because that is not a state change", () => {
    // Two different situations that must not be conflated:
    //
    //   transport failure of the GET  — "we do not know the latest provider
    //                                    state"; retried in place, stays
    //                                    PROCESSING, no transition at all
    //   a successful GET reporting
    //   FAILED_RETRYABLE              — "we learned this known prediction
    //                                    failed retryably"; that IS a
    //                                    transition, covered above
    //
    // The absence asserted here is the first case. A prediction whose fate we
    // simply could not read is never recorded as a failure, and never becomes
    // SUBMISSION_UNKNOWN either — that state is about an ambiguous *submission*,
    // and this prediction id is already known.
    expect(canTransition("PROCESSING", "SUBMISSION_UNKNOWN")).toBe(false);
    expect(canTransition("PROCESSING", "PROCESSING")).toBe(false);
  });

  it.each(TERMINAL_SCENE_GENERATION_STATES)("leaves %s terminal", (state) => {
    expect(allowedTransitionsFrom(state)).toEqual([]);
    for (const to of SCENE_GENERATION_STATES) {
      expect(canTransition(state, to)).toBe(false);
    }
  });

  it("does not let a terminal job be revived instead of regenerated", () => {
    // A deliberate regeneration is a NEW job. Reviving this one would overwrite
    // the record of an attempt that may already have been paid for.
    expect(canTransition("SUCCEEDED", "QUEUED")).toBe(false);
    expect(canTransition("FAILED_TERMINAL", "QUEUED")).toBe(false);
    expect(canTransition("CANCELLED", "QUEUED")).toBe(false);
    expect(canTransition("SUCCEEDED", "SUBMITTING")).toBe(false);
  });
});

describe("SUBMISSION_UNKNOWN — the ambiguous submission", () => {
  it("is reachable from a submission whose outcome could not be established", () => {
    expect(canTransition("SUBMITTING", "SUBMISSION_UNKNOWN")).toBe(true);
  });

  it("refuses every automatic way back into a provider POST", () => {
    // The provider may already hold a billed prediction for this request.
    expect(canTransition("SUBMISSION_UNKNOWN", "QUEUED")).toBe(false);
    expect(canTransition("SUBMISSION_UNKNOWN", "SUBMITTING")).toBe(false);
  });

  it("refuses to invent a prediction it never received", () => {
    // PROCESSING asserts a prediction id is known. Nothing in Phase 4 may
    // assume one; a human resolves this (docs/decisions/TODO.md).
    expect(canTransition("SUBMISSION_UNKNOWN", "PROCESSING")).toBe(false);
  });

  it("has no automatic exit whatsoever", () => {
    expect(allowedTransitionsFrom("SUBMISSION_UNKNOWN")).toEqual([]);
  });

  it("still holds the local generation identity", () => {
    // This is what stops a second job — and so a second paid POST — being
    // created for the same request while the first one's fate is unknown.
    expect(isActiveGenerationState("SUBMISSION_UNKNOWN")).toBe(true);
    expect(isTerminalGenerationState("SUBMISSION_UNKNOWN")).toBe(false);
  });

  it("is active without being automatically retryable", () => {
    // Two different properties. Having no outgoing transition is not the same
    // as having released the identity, and conflating them would either strand
    // the identity or authorise a duplicate POST.
    expect(isActiveGenerationState("SUBMISSION_UNKNOWN")).toBe(true);
    expect(allowedTransitionsFrom("SUBMISSION_UNKNOWN")).toEqual([]);
  });
});

describe("active and terminal sets", () => {
  it("names exactly the active states", () => {
    expect([...ACTIVE_SCENE_GENERATION_STATES].sort()).toEqual(
      ["FAILED_RETRYABLE", "PROCESSING", "QUEUED", "SUBMISSION_UNKNOWN", "SUBMITTING"].sort(),
    );
  });

  it("names exactly the terminal states", () => {
    expect([...TERMINAL_SCENE_GENERATION_STATES].sort()).toEqual(
      ["CANCELLED", "FAILED_TERMINAL", "SUCCEEDED"].sort(),
    );
  });

  it("partitions the vocabulary — every state is exactly one of the two", () => {
    // Neither set is derived from the other, so this is a real check that they
    // agree rather than a tautology.
    for (const state of SCENE_GENERATION_STATES) {
      expect(isActiveGenerationState(state)).toBe(!isTerminalGenerationState(state));
    }
    expect(
      ACTIVE_SCENE_GENERATION_STATES.length + TERMINAL_SCENE_GENERATION_STATES.length,
    ).toBe(SCENE_GENERATION_STATES.length);
  });

  it("keeps FAILED_RETRYABLE active, so it retains the identity", () => {
    // It can return to QUEUED. Releasing the identity here would let a second
    // job be created alongside one that is still going to submit.
    expect(isActiveGenerationState("FAILED_RETRYABLE")).toBe(true);
    expect(isTerminalGenerationState("FAILED_RETRYABLE")).toBe(false);
    expect(canTransition("FAILED_RETRYABLE", "QUEUED")).toBe(true);
  });

  it("releases the identity only when the attempt is genuinely over", () => {
    for (const state of TERMINAL_SCENE_GENERATION_STATES) {
      expect(isActiveGenerationState(state)).toBe(false);
    }
  });

  it("is the set Phase 4A-2's partial unique index must use", () => {
    // 4A-2 writes `WHERE state IN (...)` by hand, because Prisma cannot express
    // a partial index. Exporting the set — and pinning it here — is what stops
    // the SQL predicate and the domain drifting apart silently.
    expect([...ACTIVE_SCENE_GENERATION_STATES].sort().join(",")).toBe(
      "FAILED_RETRYABLE,PROCESSING,QUEUED,SUBMISSION_UNKNOWN,SUBMITTING",
    );
  });
});

describe("assertTransition", () => {
  it("passes a legal move through silently", () => {
    expect(() => assertTransition("QUEUED", "SUBMITTING")).not.toThrow();
  });

  it("refuses an illegal move as an internal error, not a customer refusal", () => {
    // Nothing a customer submits reaches this. An illegal move is a worker bug
    // or a lost race, and a 422 would blame the wrong party.
    const error = (() => {
      try {
        assertTransition("SUBMISSION_UNKNOWN", "SUBMITTING");
        return null;
      } catch (e: unknown) {
        return e as AppError;
      }
    })();
    expect(error).toBeInstanceOf(AppError);
    expect(error!.code).toBe("INTERNAL_ERROR");
    expect(error!.details).toEqual({ from: "SUBMISSION_UNKNOWN", to: "SUBMITTING" });
  });

  it("refuses reviving every terminal state", () => {
    for (const state of TERMINAL_SCENE_GENERATION_STATES) {
      expect(() => assertTransition(state, "QUEUED")).toThrow(AppError);
    }
  });
});
