import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  MAX_AUTOMATIC_MEDIA_RECOVERY_ATTEMPTS_PER_REQUEST,
  MAX_MEDIA_RECOVERY_BATCH_SIZE,
  AutomaticMediaRecoveryDefect,
  automaticMediaRecoveryAllowed,
  isMediaFailureKind,
  mediaRecoveryReasonCode,
  validateMediaRecoveryBatchLimit,
  MEDIA_INTEGRITY_MISMATCH_SYSTEM_RECOVERY_REASON,
  MEDIA_INVALID_SYSTEM_RECOVERY_REASON,
} from "./policy";
import { AutomaticMediaFailureRecoveryRunner } from "./runner";
import type {
  AdmitAutomaticMediaRecoveryInput,
  AutomaticMediaRecoveryCandidate,
  AutomaticMediaRecoveryPlan,
  AutomaticMediaRecoveryRepository,
} from "./ports";
import type { AutomaticMediaRecoveryOutcome } from "./policy";
import type { FxSnapshot, PricingSnapshot } from "../pricing/index";
import { epochMillisFromDate } from "../pricing/index";

/**
 * The dormant runner, and the ordering guarantee it exists to enforce:
 * planning finishes before admission opens a transaction.
 */

const RATE = {
  id: "fx_runner",
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  rateNumerator: 150,
  rateDenominator: 1,
  effectiveAt: epochMillisFromDate(new Date("2026-09-10T00:00:00.000Z")),
  sourceReference: null,
} as FxSnapshot;

const SNAPSHOT = { fxSnapshotId: RATE.id, provider: "wavespeed" } as unknown as PricingSnapshot;

function candidate(suffix: string): AutomaticMediaRecoveryCandidate {
  return {
    organizationId: "org_a",
    sourceValidationId: `momv_${suffix}`,
    sourceAttemptId: `sgen_${suffix}`,
    generationSceneRequestId: `genreq_${suffix}`,
    mediaFailureKind: "INVALID_MEDIA",
    route: {
      providerName: "wavespeed",
      providerModelId: "wavespeed-ai/open-video/image-to-video",
      requestModelKey: "wavespeed-open-video",
      requestNativeGenerationResolution: "1080p",
      requestResolutionNormalization: "NONE",
      requestNativeMeetsTarget: true,
    },
    targetOutputResolution: "1080p",
    sceneDurationSeconds: 5,
    jobQualityTier: "HIGH_QUALITY",
    persistedPricingIdentity: {},
    persistedPricingContractFingerprint: "fingerprint",
  };
}

/** Records every call in order, so a test can prove what happened when. */
class FakeRepository implements AutomaticMediaRecoveryRepository {
  readonly calls: string[] = [];
  readonly admissions: AdmitAutomaticMediaRecoveryInput[] = [];
  outcome: AutomaticMediaRecoveryOutcome = {
    kind: "ADMITTED",
    attemptId: "sgen_recovery",
    attemptOrdinal: 2,
  };
  duplicate = false;

  constructor(private readonly candidates: readonly AutomaticMediaRecoveryCandidate[]) {}

  async findAutomaticMediaRecoveryCandidates() {
    this.calls.push("find");
    return this.duplicate ? [...this.candidates, ...this.candidates] : this.candidates;
  }

  async admitAutomaticMediaRecovery(input: AdmitAutomaticMediaRecoveryInput) {
    this.calls.push(`admit:${input.sourceAttemptId}`);
    this.admissions.push(input);
    return this.outcome;
  }
}

function runner(
  repository: FakeRepository,
  plan: (candidate: AutomaticMediaRecoveryCandidate) => Promise<AutomaticMediaRecoveryPlan>,
) {
  let n = 0;
  return new AutomaticMediaFailureRecoveryRunner({
    repository,
    planner: { plan },
    ids: {
      nextAttemptId: () => {
        n += 1;
        return `sgen_new_${n}`;
      },
      nextPricingSnapshotId: () => `price_new_${n}`,
    },
    context: () => ({
      actorType: "WORKER",
      actorUserId: null,
      correlationId: `corr-${n}`,
      causationId: null,
      reasonCode: null,
      metadata: {},
      eventType: "test",
    }),
  });
}

const planned = async (): Promise<AutomaticMediaRecoveryPlan> => ({
  kind: "PLANNED",
  pricingSnapshot: SNAPSHOT,
  fxSnapshot: RATE,
});

describe("the cost circuit breaker", () => {
  it("is one automatic recovery per request", () => {
    expect(MAX_AUTOMATIC_MEDIA_RECOVERY_ATTEMPTS_PER_REQUEST).toBe(1);
    expect(automaticMediaRecoveryAllowed(0)).toBe(true);
    expect(automaticMediaRecoveryAllowed(1)).toBe(false);
    expect(automaticMediaRecoveryAllowed(2)).toBe(false);
  });

  it("counts every SYSTEM_RECOVERY attempt, not only ones it created", () => {
    // Conservative on purpose: nothing durably records which actor admitted a
    // recovery, and guessing permissively is what produces a spending loop.
    expect(automaticMediaRecoveryAllowed(1)).toBe(false);
  });
});

describe("the failure vocabulary", () => {
  it("admits exactly the two terminal media verdicts", () => {
    expect(isMediaFailureKind("INVALID_MEDIA")).toBe(true);
    expect(isMediaFailureKind("INTEGRITY_MISMATCH")).toBe(true);
    for (const other of ["VALID", "PENDING", "RUNNING", "", "invalid_media"]) {
      expect(`${other}: ${isMediaFailureKind(other)}`).toBe(`${other}: false`);
    }
  });

  it("gives each failure kind its own fixed reason code", () => {
    expect(mediaRecoveryReasonCode("INVALID_MEDIA")).toBe(MEDIA_INVALID_SYSTEM_RECOVERY_REASON);
    expect(mediaRecoveryReasonCode("INTEGRITY_MISMATCH")).toBe(
      MEDIA_INTEGRITY_MISMATCH_SYSTEM_RECOVERY_REASON,
    );
    expect(MEDIA_INVALID_SYSTEM_RECOVERY_REASON).not.toBe(
      MEDIA_INTEGRITY_MISMATCH_SYSTEM_RECOVERY_REASON,
    );
  });

  it("gives every defect a fixed message carrying no external text", () => {
    for (const code of [
      "SOURCE_RECEIPT_BINDING_CONFLICT",
      "SOURCE_VALIDATION_MISBOUND",
      "RECOVERY_ROUTE_MISMATCH",
      "RECOVERY_FX_BINDING_CONFLICT",
    ] as const) {
      const defect = new AutomaticMediaRecoveryDefect(code);
      expect(defect.code).toBe(code);
      expect(defect.name).toBe("AutomaticMediaRecoveryDefect");
      expect(defect.message).not.toMatch(/https?:|sgen_|momv_|org\//);
    }
  });
});

describe("the batch bound is proved, never clamped", () => {
  it("accepts the frozen maximum and refuses anything past it", () => {
    expect(MAX_MEDIA_RECOVERY_BATCH_SIZE).toBe(100);
    expect(validateMediaRecoveryBatchLimit(1)).toBe(1);
    expect(validateMediaRecoveryBatchLimit(100)).toBe(100);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101]) {
      expect(() => validateMediaRecoveryBatchLimit(bad)).toThrow(AppError);
    }
  });

  it("refuses a bad limit before touching the repository", async () => {
    const repository = new FakeRepository([candidate("one")]);
    await expect(runner(repository, planned).runOnce(0)).rejects.toThrow(AppError);
    expect(repository.calls).toEqual([]);
  });
});

describe("planning happens before admission, never inside it", () => {
  it("finishes each plan before the matching admission starts", async () => {
    const repository = new FakeRepository([candidate("one"), candidate("two")]);
    const order: string[] = [];
    const subject = runner(repository, async (one) => {
      order.push(`plan-start:${one.sourceAttemptId}`);
      await Promise.resolve();
      order.push(`plan-end:${one.sourceAttemptId}`);
      return planned();
    });

    await subject.runOnce(10);

    // Interleaved order proves the boundary: a plan never starts while an
    // admission is open, and an admission never starts before its plan ended.
    expect(order).toEqual([
      "plan-start:sgen_one",
      "plan-end:sgen_one",
      "plan-start:sgen_two",
      "plan-end:sgen_two",
    ]);
    expect(repository.calls).toEqual(["find", "admit:sgen_one", "admit:sgen_two"]);
  });

  it("never hands the repository anything to run", async () => {
    const repository = new FakeRepository([candidate("one")]);
    await runner(repository, planned).runOnce(10);
    const [admission] = repository.admissions;
    if (admission === undefined) throw new Error("expected an admission");
    // Structural: everything the repository receives is data, never a callback.
    for (const value of Object.values(admission)) {
      expect(typeof value).not.toBe("function");
    }
  });
});

describe("one pass, bounded and deterministic", () => {
  it("admits one recovery per candidate and counts them", async () => {
    const repository = new FakeRepository([candidate("one"), candidate("two")]);
    const report = await runner(repository, planned).runOnce(10);

    expect(report.admitted).toBe(2);
    expect(report.noPlan).toBe(0);
    expect(repository.admissions.map((one) => one.attemptId)).toEqual([
      "sgen_new_1",
      "sgen_new_2",
    ]);
  });

  it("acts on a duplicated candidate only once", async () => {
    const repository = new FakeRepository([candidate("one")]);
    repository.duplicate = true;
    const report = await runner(repository, planned).runOnce(10);

    expect(report.admitted).toBe(1);
    expect(repository.calls).toEqual(["find", "admit:sgen_one"]);
  });

  it("reports a candidate it cannot plan and never admits it", async () => {
    const repository = new FakeRepository([candidate("one")]);
    const report = await runner(repository, async () => ({
      kind: "NO_PLAN",
      code: "NO_SAFE_CURRENT_ROUTE",
    })).runOnce(10);

    expect(report.admitted).toBe(0);
    expect(report.noPlan).toBe(1);
    expect(report.outcomes[0]?.result).toEqual({
      kind: "NO_PLAN",
      code: "NO_SAFE_CURRENT_ROUTE",
    });
    // Nothing was admitted: an unsafe route is never retried anyway.
    expect(repository.calls).toEqual(["find"]);
  });

  it("does not count a refused admission as an admission", async () => {
    const repository = new FakeRepository([candidate("one")]);
    repository.outcome = { kind: "RECOVERY_LIMIT_REACHED" };
    const report = await runner(repository, planned).runOnce(10);

    expect(report.admitted).toBe(0);
    expect(report.outcomes[0]?.result).toEqual({
      kind: "OUTCOME",
      outcome: { kind: "RECOVERY_LIMIT_REACHED" },
    });
  });

  it("generates a fresh opaque id per attempt and per pricing snapshot", async () => {
    const repository = new FakeRepository([candidate("one"), candidate("two")]);
    await runner(repository, planned).runOnce(10);

    const ids = repository.admissions.map((one) => one.attemptId);
    expect(new Set(ids).size).toBe(2);
    for (const admission of repository.admissions) {
      // Never derived from the organization, source attempt, validation or request.
      expect(admission.attemptId).not.toContain(admission.organizationId);
      expect(admission.attemptId).not.toContain(admission.sourceAttemptId);
      expect(admission.attemptId).not.toContain(admission.sourceValidationId);
      expect(admission.pricingSnapshotId).not.toBe(admission.attemptId);
    }
  });

});

describe("a planner failure never carries external text", () => {
  /** Anything a real planner could be holding when it goes wrong. */
  const SENTINEL = "RAW_PROVIDER_OR_FX_SECRET_TEXT";

  /** Every place an error could smuggle text out, including the whole object. */
  function leakSurfaces(error: unknown): string {
    const app = error as {
      message?: unknown;
      cause?: unknown;
      details?: unknown;
      stack?: unknown;
    };
    const own: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(error as object)) {
      own[key] = (error as Record<string, unknown>)[key];
    }
    return [
      String(app.message ?? ""),
      JSON.stringify(app.cause ?? null),
      JSON.stringify(app.details ?? null),
      JSON.stringify(own, (_k, v: unknown) => (v instanceof Error ? String(v.stack) : v)),
      String(error),
    ].join("|");
  }

  async function failureFrom(
    plan: () => Promise<AutomaticMediaRecoveryPlan>,
  ): Promise<{ error: unknown; repository: FakeRepository }> {
    const repository = new FakeRepository([candidate("one")]);
    try {
      await runner(repository, plan).runOnce(10);
    } catch (error) {
      return { error, repository };
    }
    throw new Error("expected the runner to fail");
  }

  it("normalizes a thrown planner to the fixed error and drops the original", async () => {
    const { error, repository } = await failureFrom(async () => {
      throw new Error(`${SENTINEL} at https://vendor.example/x`);
    });

    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Automatic media recovery planning failed",
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect((error as { details?: unknown }).details).toBeUndefined();
    expect(leakSurfaces(error)).not.toContain(SENTINEL);
    // Nothing was admitted on the way out.
    expect(repository.calls).toEqual(["find"]);
  });

  for (const [name, value] of [
    ["undefined", undefined],
    ["null", null],
    ["a string", `${SENTINEL}`],
    ["an unknown kind", { kind: SENTINEL }],
    ["NO_PLAN with no code", { kind: "NO_PLAN" }],
    ["NO_PLAN with a raw code", { kind: "NO_PLAN", code: SENTINEL }],
    ["PLANNED with no snapshot", { kind: "PLANNED", fxSnapshot: {} }],
    ["PLANNED with a null snapshot", { kind: "PLANNED", pricingSnapshot: null, fxSnapshot: {} }],
    ["PLANNED with no rate", { kind: "PLANNED", pricingSnapshot: {} }],
    ["PLANNED with a raw rate", { kind: "PLANNED", pricingSnapshot: {}, fxSnapshot: SENTINEL }],
  ] as const) {
    it(`normalizes a planner returning ${name}`, async () => {
      const { error, repository } = await failureFrom(
        async () => value as unknown as AutomaticMediaRecoveryPlan,
      );

      expect(error).toMatchObject({
        code: "INTERNAL_ERROR",
        message: "Automatic media recovery planning failed",
      });
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      expect((error as { details?: unknown }).details).toBeUndefined();
      expect(leakSurfaces(error)).not.toContain(SENTINEL);
      // A malformed plan is never admitted, and never becomes a TypeError.
      expect(repository.calls).toEqual(["find"]);
    });
  }

  it("still accepts every well-formed refusal code", async () => {
    for (const code of [
      "PERSISTED_PRICING_IDENTITY_MALFORMED",
      "NO_SAFE_CURRENT_ROUTE",
      "NO_SAFE_CURRENT_PRICING",
      "AMBIGUOUS_CURRENT_PRICING",
    ] as const) {
      const repository = new FakeRepository([candidate("one")]);
      const report = await runner(repository, async () => ({ kind: "NO_PLAN", code })).runOnce(10);
      expect(report.noPlan).toBe(1);
      expect(report.outcomes[0]?.result).toEqual({ kind: "NO_PLAN", code });
    }
  });
});
