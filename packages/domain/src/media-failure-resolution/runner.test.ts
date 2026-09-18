import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import type { FxSnapshot, PricingSnapshot } from "../pricing/index";
import type { TransitionContext } from "../orchestration/ports";
import type {
  AdmitAutomaticMediaRecoveryInput,
  AutomaticMediaRecoveryCandidate,
  AutomaticMediaRecoveryPlan,
  AutomaticMediaRecoveryRepository,
} from "../media-recovery/ports";
import type { AutomaticMediaRecoveryOutcome } from "../media-recovery/policy";
import { MediaFailureResolutionRunner } from "./runner";
import {
  MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS,
  validateMediaFailureResolutionBatchLimit,
  validateMediaFailureResolutionLeaseMs,
  validateMediaFailureResolutionRetryDelayMs,
} from "./policy";
import type {
  ClaimMediaFailureResolutionInput,
  DeferMediaFailureResolutionInput,
  MediaFailureResolutionClaim,
  MediaFailureResolutionClaimOutcome,
  MediaFailureResolutionDisposition,
  MediaFailureResolutionRepository,
  MediaFailureResolutionWriteOutcome,
  ReleaseMediaFailureResolutionInput,
  ResolveMediaFailureResolutionInput,
  ResolveRecoveryAdmittedInput,
  SettleExhaustedMediaFailureInput,
} from "./ports";
import type { SettleExhaustedMediaFailureOutcome } from "./policy";

/**
 * What the coordinator does with each disposition, and what it never does.
 *
 * The recurring theme: a refusal it did not cause is handed back rather than
 * held, and nothing external ever escapes as text.
 */

const NOW = 1_700_000_000_000;
const SENTINEL = "RAW_PROVIDER_OR_FX_SECRET_TEXT";

const CANDIDATE: AutomaticMediaRecoveryCandidate = {
  organizationId: "org_a",
  sourceValidationId: "momv_1",
  sourceAttemptId: "sgen_1",
  generationSceneRequestId: "genreq_1",
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
  persistedPricingContractFingerprint: "fp",
};

const PLAN: AutomaticMediaRecoveryPlan = {
  kind: "PLANNED",
  pricingSnapshot: { fxSnapshotId: "fx_1" } as unknown as PricingSnapshot,
  fxSnapshot: { id: "fx_1" } as unknown as FxSnapshot,
};

function claimFor(
  disposition: MediaFailureResolutionDisposition,
): MediaFailureResolutionClaim {
  return {
    workId: "momfr_1",
    sourceValidationId: "momv_1",
    sourceAttemptId: "sgen_1",
    organizationId: "org_a",
    version: 3,
    leaseToken: "lease_1",
    disposition,
  };
}

interface Calls {
  readonly deferred: DeferMediaFailureResolutionInput[];
  readonly released: ReleaseMediaFailureResolutionInput[];
  readonly recovered: ResolveRecoveryAdmittedInput[];
  readonly obsolete: ResolveMediaFailureResolutionInput[];
  readonly settled: SettleExhaustedMediaFailureInput[];
  readonly admitted: AdmitAutomaticMediaRecoveryInput[];
}

function harness(options: {
  readonly claim: MediaFailureResolutionClaimOutcome;
  readonly plan?: () => Promise<AutomaticMediaRecoveryPlan> | AutomaticMediaRecoveryPlan;
  readonly admit?: AutomaticMediaRecoveryOutcome;
  readonly settlement?: SettleExhaustedMediaFailureOutcome;
  readonly candidates?: readonly { readonly sourceValidationId: string }[];
}): { runner: MediaFailureResolutionRunner; calls: Calls } {
  const calls: Calls = {
    deferred: [],
    released: [],
    recovered: [],
    obsolete: [],
    settled: [],
    admitted: [],
  };
  const applied: MediaFailureResolutionWriteOutcome = { kind: "APPLIED" };

  const work: MediaFailureResolutionRepository = {
    async findResolutionCandidates() {
      return options.candidates ?? [{ sourceValidationId: "momv_1" }];
    },
    async claim(_input: ClaimMediaFailureResolutionInput) {
      return options.claim;
    },
    async defer(input) {
      calls.deferred.push(input);
      return applied;
    },
    async release(input) {
      calls.released.push(input);
      return applied;
    },
    async resolveRecoveryAdmitted(input) {
      calls.recovered.push(input);
      return applied;
    },
    async resolveObsolete(input) {
      calls.obsolete.push(input);
      return applied;
    },
    async settleExhaustedMediaFailure(input) {
      calls.settled.push(input);
      return options.settlement ?? { kind: "SETTLED", resolutionKind: "INITIAL_FAILURE_SETTLED", settledAt: NOW };
    },
  };

  const recovery: AutomaticMediaRecoveryRepository = {
    async findAutomaticMediaRecoveryCandidates() {
      throw new Error("the coordinator must not use the Phase 6B discovery");
    },
    async admitAutomaticMediaRecovery(input) {
      calls.admitted.push(input);
      return options.admit ?? { kind: "ADMITTED", attemptId: "sgen_2", attemptOrdinal: 2 };
    },
  };

  const runner = new MediaFailureResolutionRunner({
    work,
    recovery,
    planner: { plan: async () => (options.plan ? await options.plan() : PLAN) },
    ids: {
      nextAttemptId: () => "sgen_new",
      nextPricingSnapshotId: () => "price_new",
      nextLeaseToken: () => "lease_1",
    },
    clock: () => NOW,
    context: (): TransitionContext => ({
      actorType: "SYSTEM",
      actorUserId: null,
      reasonCode: null,
      correlationId: "corr_1",
      causationId: null,
      eventType: "test.resolution",
      metadata: {},
    }),
  });
  return { runner, calls };
}

describe("the recovery path", () => {
  it("plans, admits and binds the work row to the exact attempt", async () => {
    const { runner, calls } = harness({
      claim: { kind: "CLAIMED", claim: claimFor({ kind: "ADMIT_RECOVERY", candidate: CANDIDATE }) },
    });

    const report = await runner.runOnce(10);

    expect(report).toMatchObject({ claimed: 1, recovered: 1, settled: 0, deferred: 0 });
    expect(calls.admitted).toHaveLength(1);
    expect(calls.recovered).toHaveLength(1);
    expect(calls.recovered[0]?.recoveryAttemptId).toBe("sgen_2");
    expect(calls.deferred).toHaveLength(0);
  });

  it("hands the claim back when admission declines under its own locks", async () => {
    const { runner, calls } = harness({
      claim: { kind: "CLAIMED", claim: claimFor({ kind: "ADMIT_RECOVERY", candidate: CANDIDATE }) },
      admit: { kind: "NOT_ELIGIBLE" },
    });

    const report = await runner.runOnce(10);

    expect(report.recovered).toBe(0);
    expect(calls.recovered).toHaveLength(0);
    // Released, not resolved: the authority that refused is the one holding the
    // locks, and next pass re-classifies against whatever is true then.
    expect(calls.released).toHaveLength(1);
    expect(calls.released[0]?.nextAttemptAt).toBe(NOW + MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS);
  });

  it("binds to an existing recovery rather than creating a second one", async () => {
    const { runner, calls } = harness({
      claim: {
        kind: "CLAIMED",
        claim: claimFor({ kind: "RECONCILE_RECOVERY", recoveryAttemptId: "sgen_existing" }),
      },
    });

    const report = await runner.runOnce(10);

    expect(report.outcomes[0]?.result).toEqual({
      kind: "RECONCILED",
      recoveryAttemptId: "sgen_existing",
    });
    // The crash-after-admission case: no plan, no admission, no second snapshot.
    expect(calls.admitted).toHaveLength(0);
    expect(calls.recovered[0]?.recoveryAttemptId).toBe("sgen_existing");
  });
});

describe("a planning refusal defers rather than terminalizes", () => {
  it("records the refusal code and a future retry instant", async () => {
    const { runner, calls } = harness({
      claim: { kind: "CLAIMED", claim: claimFor({ kind: "ADMIT_RECOVERY", candidate: CANDIDATE }) },
      plan: () => ({ kind: "NO_PLAN", code: "NO_SAFE_CURRENT_PRICING" }),
    });

    const report = await runner.runOnce(10);

    expect(report.deferred).toBe(1);
    expect(calls.deferred).toHaveLength(1);
    expect(calls.deferred[0]?.refusalCode).toBe("NO_SAFE_CURRENT_PRICING");
    expect(calls.deferred[0]?.nextAttemptAt).toBe(NOW + MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS);
    // Nothing customer-visible happened. An FX source being unreachable is not
    // a verdict about the customer.
    expect(calls.settled).toHaveLength(0);
    expect(calls.admitted).toHaveLength(0);
  });

  it("uses a configurable retry delay, validated rather than clamped", async () => {
    expect(() => validateMediaFailureResolutionRetryDelayMs(0)).toThrow(AppError);
    expect(() => validateMediaFailureResolutionRetryDelayMs(60 * 60 * 1000 + 1)).toThrow(AppError);
    expect(validateMediaFailureResolutionRetryDelayMs(1000)).toBe(1000);
    expect(() => validateMediaFailureResolutionLeaseMs(60 * 60 * 1000 + 1)).toThrow(AppError);
    expect(() => validateMediaFailureResolutionBatchLimit(101)).toThrow(AppError);
  });
});

describe("settlement", () => {
  it("delegates the whole customer consequence to Transaction H", async () => {
    const { runner, calls } = harness({
      claim: { kind: "CLAIMED", claim: claimFor({ kind: "SETTLE_EXHAUSTED" }) },
    });

    const report = await runner.runOnce(10);

    expect(report.settled).toBe(1);
    expect(calls.settled).toHaveLength(1);
    // Transaction H resolves the work row itself, in its own commit.
    expect(calls.recovered).toHaveLength(0);
    expect(calls.obsolete).toHaveLength(0);
    expect(calls.released).toHaveLength(0);
  });

  it("releases the claim when settlement is refused", async () => {
    const { runner, calls } = harness({
      claim: { kind: "CLAIMED", claim: claimFor({ kind: "SETTLE_EXHAUSTED" }) },
      settlement: { kind: "NOT_EXHAUSTED" },
    });

    await runner.runOnce(10);

    expect(calls.released).toHaveLength(1);
  });
});

describe("obsolete work", () => {
  it("resolves without touching the customer", async () => {
    const { runner, calls } = harness({
      claim: { kind: "CLAIMED", claim: claimFor({ kind: "OBSOLETE" }) },
    });

    const report = await runner.runOnce(10);

    expect(report.outcomes[0]?.result).toEqual({ kind: "RESOLVED", resolutionKind: "OBSOLETE" });
    expect(calls.obsolete).toHaveLength(1);
    expect(calls.settled).toHaveLength(0);
    expect(calls.admitted).toHaveLength(0);
  });
});

describe("claims it does not get", () => {
  it("reports an unclaimable item without acting on it", async () => {
    const { runner, calls } = harness({ claim: { kind: "NOT_CLAIMED" } });
    const report = await runner.runOnce(10);
    expect(report.claimed).toBe(0);
    expect(report.outcomes[0]?.result).toEqual({ kind: "SKIPPED" });
    expect(calls.admitted).toHaveLength(0);
  });

  it("never reopens terminal work", async () => {
    const { runner, calls } = harness({
      claim: { kind: "ALREADY_RESOLVED", resolutionKind: "INITIAL_FAILURE_SETTLED" },
    });
    const report = await runner.runOnce(10);
    expect(report.outcomes[0]?.result).toEqual({
      kind: "RESOLVED",
      resolutionKind: "INITIAL_FAILURE_SETTLED",
    });
    expect(calls.settled).toHaveLength(0);
  });

  it("acts on a duplicated candidate only once", async () => {
    const { runner, calls } = harness({
      claim: { kind: "CLAIMED", claim: claimFor({ kind: "OBSOLETE" }) },
      candidates: [{ sourceValidationId: "momv_1" }, { sourceValidationId: "momv_1" }],
    });
    await runner.runOnce(10);
    expect(calls.obsolete).toHaveLength(1);
  });
});

describe("no external text escapes planning", () => {
  it("normalizes a thrown planner and releases the claim", async () => {
    const { runner, calls } = harness({
      claim: { kind: "CLAIMED", claim: claimFor({ kind: "ADMIT_RECOVERY", candidate: CANDIDATE }) },
      plan: () => {
        throw new Error(`fx vendor said ${SENTINEL}`);
      },
    });

    await expect(runner.runOnce(10)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Automatic media recovery planning failed",
    });
    // The claim is handed back so a planning defect costs a retry delay rather
    // than a whole lease period.
    expect(calls.released).toHaveLength(1);
  });

  it.each([
    ["undefined", undefined],
    ["a string", "PLANNED"],
    ["an unknown kind", { kind: "MAYBE" }],
    ["a plan with no snapshot", { kind: "PLANNED", fxSnapshot: {} }],
    ["a plan with no rate", { kind: "PLANNED", pricingSnapshot: {} }],
    ["a raw refusal code", { kind: "NO_PLAN", code: SENTINEL }],
  ])("normalizes %s", async (_name, value) => {
    const { runner } = harness({
      claim: { kind: "CLAIMED", claim: claimFor({ kind: "ADMIT_RECOVERY", candidate: CANDIDATE }) },
      plan: () => value as unknown as AutomaticMediaRecoveryPlan,
    });

    let caught: unknown;
    try {
      await runner.runOnce(10);
    } catch (error) {
      caught = error;
    }
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
    expect(serialized.includes(SENTINEL)).toBe(false);
    expect((caught as AppError).message).toBe("Automatic media recovery planning failed");
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
  });

  it("does not let a failing release replace the fixed error", async () => {
    const calls: string[] = [];
    const work = {
      async findResolutionCandidates() {
        return [{ sourceValidationId: "momv_1" }];
      },
      async claim(): Promise<MediaFailureResolutionClaimOutcome> {
        return {
          kind: "CLAIMED",
          claim: claimFor({ kind: "ADMIT_RECOVERY", candidate: CANDIDATE }),
        };
      },
      async defer() {
        return { kind: "APPLIED" as const };
      },
      async release(): Promise<MediaFailureResolutionWriteOutcome> {
        calls.push("release");
        throw new Error(`database said ${SENTINEL}`);
      },
      async resolveRecoveryAdmitted() {
        return { kind: "APPLIED" as const };
      },
      async resolveObsolete() {
        return { kind: "APPLIED" as const };
      },
      async settleExhaustedMediaFailure(): Promise<SettleExhaustedMediaFailureOutcome> {
        return { kind: "NOT_FOUND" };
      },
    };
    const runner = new MediaFailureResolutionRunner({
      work,
      recovery: {
        async findAutomaticMediaRecoveryCandidates() {
          return [];
        },
        async admitAutomaticMediaRecovery() {
          return { kind: "NOT_ELIGIBLE" };
        },
      },
      planner: {
        plan: async () => {
          throw new Error(`planner said ${SENTINEL}`);
        },
      },
      ids: {
        nextAttemptId: () => "sgen_new",
        nextPricingSnapshotId: () => "price_new",
        nextLeaseToken: () => "lease_1",
      },
      clock: () => NOW,
      context: (): TransitionContext => ({
        actorType: "SYSTEM",
        actorUserId: null,
        reasonCode: null,
        correlationId: "corr_1",
        causationId: null,
        eventType: "test.resolution",
        metadata: {},
      }),
    });

    let caught: unknown;
    try {
      await runner.runOnce(10);
    } catch (error) {
      caught = error;
    }
    expect(calls).toEqual(["release"]);
    expect((caught as AppError).message).toBe("Automatic media recovery planning failed");
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
    expect(serialized.includes(SENTINEL)).toBe(false);
  });
});
