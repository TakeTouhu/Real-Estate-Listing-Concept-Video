import { describe, expect, it } from "vitest";
import {
  safePositiveByteCount,
  sha256Digest,
  type ManagedOutputVerificationReceipt,
} from "../completion/output";
import type { ManagedDeliverableOutputKey } from "../deliverable-composition-execution/durable";
import type { TransitionContext } from "../orchestration/ports";
import { ISO_BMFF_CONTAINER, type ManagedOutputMediaFacts } from "../provider-output/media-validation";
import { DeliverableSettlementDefect } from "../deliverable-settlement/settlement";
import { DeliverableValidationDefect } from "./durable";
import type {
  ClaimDeliverableValidationOutcome,
  DeliverableValidationClaim,
  DeliverableValidationPublicationTarget,
  DeliverableValidationRepository,
  DeferDeliverableValidationOutcome,
  FinalizeDeliverableValidOutcome,
  FinalizeDeliverableVerdictOutcome,
  PublishValidatedDeliverableOutcome,
} from "./ports";
import { DeliverableValidationRunner } from "./runner";

/**
 * The order the runner is allowed to do things in, and the answers it is allowed
 * to reach.
 *
 * Every collaborator is a fake that records the exact sequence of calls, because
 * the property that matters most here is not any single answer — it is that the
 * validator runs *between* two short transactions and that Transaction G runs
 * after the verdict is durable, never before and never inside.
 */

const KEY = "org/org_1/deliverables/gdv_1/output" as ManagedDeliverableOutputKey;
const RECEIPT: ManagedOutputVerificationReceipt = {
  sha256: sha256Digest("a".repeat(64)),
  sizeBytes: safePositiveByteCount(4_096),
};
const FACTS: ManagedOutputMediaFacts = {
  container: ISO_BMFF_CONTAINER,
  durationMs: 10_000,
  videoWidth: 1920,
  videoHeight: 1080,
  videoStreamCount: 1,
  audioStreamCount: 0,
};

const CLAIM: DeliverableValidationClaim = {
  organizationId: "org_1",
  generationJobId: "genjob_1",
  deliverableVersionId: "gdv_1",
  validationId: "gdval_1",
  leaseToken: "vlease_1",
  version: 1,
  attemptCount: 1,
  outputStorageKey: KEY,
  expectedReceipt: RECEIPT,
  plannedMedia: { widthPx: 1920, heightPx: 1080, durationMs: 10_000, durationToleranceMs: 34 },
};

const PUBLICATION: DeliverableValidationPublicationTarget = {
  organizationId: "org_1",
  generationJobId: "genjob_1",
  deliverableVersionId: "gdv_1",
  validationId: "gdval_1",
  validationVersion: 2,
  receipt: { sha256: RECEIPT.sha256, sizeBytes: RECEIPT.sizeBytes },
};

const CONTEXT: TransitionContext = {
  actorType: "SYSTEM",
  actorUserId: null,
  correlationId: "corr_1",
  causationId: null,
  reasonCode: null,
  metadata: {},
  eventType: "test",
};

interface FakeOptions {
  readonly candidates?: readonly string[];
  readonly claim?: ClaimDeliverableValidationOutcome;
  readonly claims?: readonly ClaimDeliverableValidationOutcome[];
  readonly finalizeValid?: FinalizeDeliverableValidOutcome;
  readonly finalizeVerdict?: FinalizeDeliverableVerdictOutcome;
  readonly defer?: DeferDeliverableValidationOutcome;
  readonly publish?: PublishValidatedDeliverableOutcome;
}

/** A repository that records every call and answers from a script. */
function fakeRepository(options: FakeOptions) {
  const calls: string[] = [];
  const claims = options.claims ?? [];
  let claimIndex = 0;
  const seen: { limit?: number; validatorKey?: unknown } = {};
  const repository: DeliverableValidationRepository = {
    async findValidationCandidates(query) {
      calls.push("findCandidates");
      seen.limit = query.limit;
      return (options.candidates ?? ["gdv_1"]).map((id) => ({
        deliverableVersionId: id,
        generationJobId: "genjob_1",
        organizationId: "org_1",
      }));
    },
    async claimDeliverableValidation() {
      calls.push("claim");
      const scripted = claims[claimIndex];
      claimIndex += 1;
      return scripted ?? options.claim ?? { kind: "CLAIMED", claim: CLAIM };
    },
    async finalizeValid() {
      calls.push("finalizeValid");
      return options.finalizeValid ?? { kind: "FINALIZED", publication: PUBLICATION };
    },
    async finalizeInvalidMedia() {
      calls.push("finalizeInvalidMedia");
      return options.finalizeVerdict ?? { kind: "FINALIZED" };
    },
    async finalizeOffPlan() {
      calls.push("finalizeOffPlan");
      return options.finalizeVerdict ?? { kind: "FINALIZED" };
    },
    async finalizeIntegrityMismatch() {
      calls.push("finalizeIntegrityMismatch");
      return options.finalizeVerdict ?? { kind: "FINALIZED" };
    },
    async deferValidation() {
      calls.push("defer");
      return options.defer ?? { kind: "DEFERRED" };
    },
    async publishDeliverable() {
      calls.push("publish");
      return options.publish ?? { kind: "PUBLISHED_AND_CONSUMED" };
    },
    async findValidationByVersionId() {
      calls.push("find");
      return null;
    },
  };
  return { repository, calls, seen };
}

/** A validator that records what it was handed and answers from a script. */
function fakeValidator(answer: unknown | (() => never), calls: string[]) {
  const seen: { key?: unknown; receipt?: unknown } = {};
  return {
    validator: {
      async validateDeliverable(input: { deliverableKey: unknown; expectedReceipt: unknown }) {
        calls.push("validate");
        seen.key = input.deliverableKey;
        seen.receipt = input.expectedReceipt;
        if (typeof answer === "function") return (answer as () => never)();
        return answer;
      },
    },
    seen,
  };
}

function runnerFor(options: FakeOptions, answer: unknown | (() => never)) {
  const { repository, calls, seen } = fakeRepository(options);
  const { validator, seen: validatorSeen } = fakeValidator(answer, calls);
  let tick = 0;
  const runner = new DeliverableValidationRunner(
    {},
    {
      repository,
      validator,
      clock: () => {
        tick += 1;
        return 1_000 * tick;
      },
      leaseTokens: { next: () => "vlease_next" },
    },
  );
  return { runner, calls, seen, validatorSeen };
}

// ---------------------------------------------------------------------------

describe("the ordering the runner exists to guarantee", () => {
  it("claims, then validates outside any transaction, then finalizes, then publishes", async () => {
    const { runner, calls } = runnerFor({}, { kind: "VALID", facts: FACTS });
    expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({
      kind: "PUBLISHED_AND_CONSUMED",
    });
    // Four steps, four separate operations. The validator sits between two
    // database calls, and Transaction G is last: nothing holds a row lock or a
    // pooled connection across the object-store read and the inspector.
    expect(calls).toEqual(["claim", "validate", "finalizeValid", "publish"]);
  });

  it("hands the validator the canonical key and the frozen receipt, unchanged", async () => {
    const { runner, validatorSeen } = runnerFor({}, { kind: "VALID", facts: FACTS });
    await runner.runOne("org_1", "gdv_1", CONTEXT);
    expect(validatorSeen.key).toBe(KEY);
    expect(validatorSeen.receipt).toBe(RECEIPT);
  });

  it("publishes the target the finalize returned, not one it assembled", async () => {
    const other: DeliverableValidationPublicationTarget = {
      ...PUBLICATION,
      validationId: "gdval_other",
      validationVersion: 9,
    };
    const { repository, calls } = fakeRepository({
      finalizeValid: { kind: "FINALIZED", publication: other },
    });
    let published: DeliverableValidationPublicationTarget | null = null;
    const runner = new DeliverableValidationRunner(
      {},
      {
        repository: {
          ...repository,
          async publishDeliverable(input) {
            published = input.publication;
            return { kind: "PUBLISHED_AND_CONSUMED" };
          },
        },
        validator: {
          async validateDeliverable() {
            calls.push("validate");
            return { kind: "VALID", facts: FACTS };
          },
        },
        clock: () => 1_000,
        leaseTokens: { next: () => "vlease_next" },
      },
    );
    await runner.runOne("org_1", "gdv_1", CONTEXT);
    expect(published).toBe(other);
  });
});

describe("what each validator answer becomes", () => {
  it("publishes on VALID", async () => {
    const { runner, calls } = runnerFor({}, { kind: "VALID", facts: FACTS });
    expect((await runner.runOne("org_1", "gdv_1", CONTEXT)).kind).toBe("PUBLISHED_AND_CONSUMED");
    expect(calls).toContain("publish");
  });

  it("records INVALID_MEDIA and publishes nothing", async () => {
    const { runner, calls } = runnerFor(
      {},
      { kind: "INVALID_MEDIA", reason: "VIDEO_STREAM_MISSING" },
    );
    expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({ kind: "INVALID_MEDIA" });
    expect(calls).toEqual(["claim", "validate", "finalizeInvalidMedia"]);
  });

  it("records INTEGRITY_MISMATCH and publishes nothing", async () => {
    const { runner, calls } = runnerFor({}, { kind: "INTEGRITY_MISMATCH" });
    expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({
      kind: "INTEGRITY_MISMATCH",
    });
    expect(calls).toEqual(["claim", "validate", "finalizeIntegrityMismatch"]);
  });

  it("defers on RETRYABLE_FAILURE, writing no verdict and publishing nothing", async () => {
    const { runner, calls } = runnerFor({}, { kind: "RETRYABLE_FAILURE" });
    expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({ kind: "RELEASED" });
    // A storage hiccup must never become a permanent record that a customer's
    // deliverable is unusable, and it certainly must not publish one.
    expect(calls).toEqual(["claim", "validate", "defer"]);
  });

  it("reports LOST when the finalize matched no row, and does not publish", async () => {
    const { runner, calls } = runnerFor(
      { finalizeValid: { kind: "LEASE_LOST" } },
      { kind: "VALID", facts: FACTS },
    );
    expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({ kind: "LOST" });
    expect(calls).not.toContain("publish");
  });

  it("reports LOST when a terminal verdict matched no row", async () => {
    for (const answer of [
      { kind: "INVALID_MEDIA", reason: "PROBE_REJECTED" },
      { kind: "INTEGRITY_MISMATCH" },
    ]) {
      const { runner } = runnerFor({ finalizeVerdict: { kind: "LEASE_LOST" } }, answer);
      expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({ kind: "LOST" });
    }
  });

  it("reports LOST when a deferral matched no row", async () => {
    const { runner } = runnerFor({ defer: { kind: "LEASE_LOST" } }, { kind: "RETRYABLE_FAILURE" });
    expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({ kind: "LOST" });
  });

  it("carries a replayed verdict straight through to publication", async () => {
    const { runner, calls } = runnerFor(
      { finalizeValid: { kind: "ALREADY_FINALIZED", publication: PUBLICATION } },
      { kind: "VALID", facts: FACTS },
    );
    expect((await runner.runOne("org_1", "gdv_1", CONTEXT)).kind).toBe("PUBLISHED_AND_CONSUMED");
    expect(calls).toEqual(["claim", "validate", "finalizeValid", "publish"]);
  });
});

describe("a usable video that is not the planned one (ADR-0081)", () => {
  /** The runner, with the facts its off-plan verdict was handed. */
  function offPlanRunner(facts: ManagedOutputMediaFacts, finalizeVerdict?: FinalizeDeliverableVerdictOutcome) {
    const { repository, calls } = fakeRepository(finalizeVerdict === undefined ? {} : { finalizeVerdict });
    const seen: { facts?: unknown; claim?: unknown } = {};
    const runner = new DeliverableValidationRunner(
      {},
      {
        repository: {
          ...repository,
          async finalizeOffPlan(input) {
            seen.facts = input.facts;
            seen.claim = input.claim;
            return repository.finalizeOffPlan(input);
          },
        },
        validator: {
          async validateDeliverable() {
            calls.push("validate");
            return { kind: "VALID", facts };
          },
        },
        clock: () => 1_000,
        leaseTokens: { next: () => "vlease_next" },
      },
    );
    return { runner, calls, seen };
  }

  it("records another frame size as INVALID_MEDIA, and never a verdict or a publication", async () => {
    for (const facts of [
      { ...FACTS, videoWidth: 1280, videoHeight: 720 },
      { ...FACTS, videoWidth: 1080, videoHeight: 1920 },
      { ...FACTS, videoWidth: 1921 },
      { ...FACTS, videoHeight: 1079 },
    ]) {
      const { runner, calls, seen } = offPlanRunner(facts);
      expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({ kind: "INVALID_MEDIA" });
      expect(seen.facts).toEqual(facts);
      expect(calls).toEqual(["claim", "validate", "finalizeOffPlan"]);
    }
  });

  it("records another length as INVALID_MEDIA, beyond one frame either way", async () => {
    for (const durationMs of [10_035, 9_965, 11_000, 9_000, 1]) {
      const { runner, calls, seen } = offPlanRunner({ ...FACTS, durationMs });
      expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({ kind: "INVALID_MEDIA" });
      expect(seen.facts).toMatchObject({ durationMs });
      expect(calls).toEqual(["claim", "validate", "finalizeOffPlan"]);
    }
  });

  it("hands the repository the claim and the measured facts, never a reason", async () => {
    const facts = { ...FACTS, videoWidth: 1280, durationMs: 5_000 };
    const { runner, calls, seen } = offPlanRunner(facts);
    await runner.runOne("org_1", "gdv_1", CONTEXT);
    // The reason is the repository's to derive from its own read of the plan:
    // a permanent verdict is not taken on the runner's word.
    expect(seen).toEqual({ facts, claim: CLAIM });
    expect(calls).not.toContain("finalizeInvalidMedia");
  });

  it("publishes a video within one frame of the planned length", async () => {
    for (const durationMs of [10_034, 9_966, 10_000]) {
      const { runner, calls, seen } = offPlanRunner({ ...FACTS, durationMs });
      expect((await runner.runOne("org_1", "gdv_1", CONTEXT)).kind).toBe("PUBLISHED_AND_CONSUMED");
      expect(seen.facts).toBeUndefined();
      expect(calls).toEqual(["claim", "validate", "finalizeValid", "publish"]);
    }
  });

  it("judges against the claim's plan, not a fixed one", async () => {
    const square: DeliverableValidationClaim = {
      ...CLAIM,
      plannedMedia: { widthPx: 1080, heightPx: 1080, durationMs: 30_000, durationToleranceMs: 40 },
    };
    const { repository, calls } = fakeRepository({ claim: { kind: "CLAIMED", claim: square } });
    const runner = new DeliverableValidationRunner(
      {},
      {
        repository,
        validator: {
          async validateDeliverable() {
            calls.push("validate");
            return { kind: "VALID", facts: { ...FACTS, videoWidth: 1080, durationMs: 30_040 } };
          },
        },
        clock: () => 1_000,
        leaseTokens: { next: () => "vlease_next" },
      },
    );
    expect((await runner.runOne("org_1", "gdv_1", CONTEXT)).kind).toBe("PUBLISHED_AND_CONSUMED");
    // The fixed 1920x1080, 10-second fixture is off this plan.
    const off = runnerFor({ claim: { kind: "CLAIMED", claim: square } }, { kind: "VALID", facts: FACTS });
    expect(await off.runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({ kind: "INVALID_MEDIA" });
  });

  it("reports LOST when the refusal matched no row", async () => {
    const { runner, calls } = offPlanRunner({ ...FACTS, durationMs: 12_000 }, { kind: "LEASE_LOST" });
    expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({ kind: "LOST" });
    expect(calls).not.toContain("publish");
  });
});

describe("what each claim answer becomes", () => {
  it("publishes without re-validating when only the publication is outstanding", async () => {
    const { runner, calls } = runnerFor(
      { claim: { kind: "ALREADY_VALID", publication: PUBLICATION } },
      { kind: "VALID", facts: FACTS },
    );
    expect((await runner.runOne("org_1", "gdv_1", CONTEXT)).kind).toBe("PUBLISHED_AND_CONSUMED");
    // The bytes were proved once and the receipt is frozen. Re-reading a
    // hundreds-of-megabytes object to learn what is already durable would be
    // pure waste, and the verdict it reached cannot change.
    expect(calls).toEqual(["claim", "publish"]);
  });

  it("does nothing further for an ordinary refusal", async () => {
    for (const kind of ["NOT_CLAIMABLE", "ALREADY_TERMINAL", "NOT_ELIGIBLE", "NOT_FOUND"] as const) {
      const { runner, calls } = runnerFor({ claim: { kind } }, { kind: "VALID", facts: FACTS });
      expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({ kind });
      expect(calls).toEqual(["claim"]);
    }
  });
});

describe("every publication outcome reaches the caller unchanged", () => {
  it("distinguishes a first publication from a replacement and from a replay", async () => {
    for (const kind of [
      "PUBLISHED_AND_CONSUMED",
      "PUBLISHED_AS_REPLACEMENT",
      "ALREADY_PUBLISHED",
      "NOT_PUBLISHABLE",
    ] as const) {
      const { runner } = runnerFor({ publish: { kind } }, { kind: "VALID", facts: FACTS });
      // Collapsing these would leave a caller unable to say whether a customer's
      // unit was spent, which is the one thing it must be able to report.
      expect(await runner.runOne("org_1", "gdv_1", CONTEXT)).toEqual({ kind });
    }
  });
});

describe("a validator that misbehaves is not evidence about the video", () => {
  it("hands the lease back and raises a fixed defect when it throws", async () => {
    const { runner, calls } = runnerFor({}, () => {
      throw Object.assign(new Error("s3://bucket/org/org_1/secret key expired"), {
        code: "AccessDenied",
      });
    });
    await expect(runner.runOne("org_1", "gdv_1", CONTEXT)).rejects.toBeInstanceOf(
      DeliverableValidationDefect,
    );
    // Released rather than stranded in RUNNING until the lease expires, and no
    // verdict of any kind was written.
    expect(calls).toEqual(["claim", "validate", "defer"]);
  });

  it("lets no adapter text, code or cause escape with the defect", async () => {
    const { runner } = runnerFor({}, () => {
      throw Object.assign(new Error("s3://bucket/org/org_1/secret key expired"), {
        code: "AccessDenied",
      });
    });
    const error = await runner.runOne("org_1", "gdv_1", CONTEXT).catch((e: unknown) => e);
    const defect = error as DeliverableValidationDefect;
    expect(defect.code).toBe("VALIDATOR_FAILED");
    expect(JSON.stringify({ ...defect, text: defect.message })).not.toContain("s3://");
    expect(defect.message).not.toContain("AccessDenied");
    expect("cause" in defect && defect.cause !== undefined).toBe(false);
  });

  it("raises a fixed defect for a result outside the closed contract", async () => {
    for (const answer of [
      null,
      undefined,
      "VALID",
      { kind: "VALID" },
      { kind: "VALID", facts: { ...FACTS, durationMs: 0 } },
      { kind: "VALID", facts: FACTS, extra: 1 },
      { kind: "MAYBE" },
      { kind: "INVALID_MEDIA", reason: "SOMETHING_ELSE" },
      { kind: "INTEGRITY_MISMATCH", detail: "x" },
    ]) {
      const { runner, calls } = runnerFor({}, answer);
      const error = await runner.runOne("org_1", "gdv_1", CONTEXT).catch((e: unknown) => e);
      expect((error as DeliverableValidationDefect).code).toBe("VALIDATOR_RESULT_MALFORMED");
      expect(calls).toEqual(["claim", "validate", "defer"]);
    }
  });

  it("reads a hostile result exactly once, so it cannot change between checks", async () => {
    let reads = 0;
    const hostile = {
      get kind() {
        reads += 1;
        return reads === 1 ? "VALID" : "INTEGRITY_MISMATCH";
      },
      facts: FACTS,
    };
    const { runner, calls } = runnerFor({}, hostile);
    await runner.runOne("org_1", "gdv_1", CONTEXT);
    // Whatever the getter does afterwards, the dispatch acted on the single
    // parsed value rather than re-reading the adapter's object.
    expect(calls).toEqual(["claim", "validate", "finalizeValid", "publish"]);
  });

  it("still raises the defect when handing the lease back also fails", async () => {
    const { repository } = fakeRepository({});
    const runner = new DeliverableValidationRunner(
      {},
      {
        repository: {
          ...repository,
          async deferValidation() {
            throw new Error("connection reset");
          },
        },
        validator: {
          async validateDeliverable() {
            return { kind: "NONSENSE" };
          },
        },
        clock: () => 1_000,
        leaseTokens: { next: () => "vlease_next" },
      },
    );
    // A release failure must not replace the defect the caller needs to see.
    const error = await runner.runOne("org_1", "gdv_1", CONTEXT).catch((e: unknown) => e);
    expect((error as DeliverableValidationDefect).code).toBe("VALIDATOR_RESULT_MALFORMED");
  });
});

describe("one bounded pass", () => {
  it("refuses an unusable batch limit rather than sweeping a different number", async () => {
    const { runner, calls } = runnerFor({}, { kind: "VALID", facts: FACTS });
    for (const limit of [0, -1, 26, 5_000, 1.5, Number.NaN]) {
      await expect(runner.runOnce(limit, CONTEXT)).rejects.toThrow(/between 1 and 25/);
    }
    expect(calls).toEqual([]);
  });

  it("passes the bound to the query and attempts each candidate exactly once", async () => {
    const { runner, calls, seen } = runnerFor(
      { candidates: ["gdv_1", "gdv_2", "gdv_3"] },
      { kind: "RETRYABLE_FAILURE" },
    );
    const report = await runner.runOnce(3, CONTEXT);
    expect(seen.limit).toBe(3);
    expect(report.outcomes.map((o) => o.deliverableVersionId)).toEqual([
      "gdv_1",
      "gdv_2",
      "gdv_3",
    ]);
    // A row released here becomes eligible on a later pass, after its retry
    // delay — never immediately, in this loop.
    expect(calls.filter((call) => call === "claim")).toHaveLength(3);
    expect(report.claimed).toBe(3);
  });

  it("counts only the candidates it actually took work on", async () => {
    const { runner } = runnerFor(
      {
        candidates: ["gdv_1", "gdv_2", "gdv_3", "gdv_4"],
        claims: [
          { kind: "CLAIMED", claim: CLAIM },
          { kind: "NOT_CLAIMABLE" },
          { kind: "ALREADY_TERMINAL" },
          { kind: "ALREADY_VALID", publication: PUBLICATION },
        ],
      },
      { kind: "VALID", facts: FACTS },
    );
    const report = await runner.runOnce(4, CONTEXT);
    expect(report.outcomes.map((o) => o.outcome.kind)).toEqual([
      "PUBLISHED_AND_CONSUMED",
      "NOT_CLAIMABLE",
      "ALREADY_TERMINAL",
      "PUBLISHED_AND_CONSUMED",
    ]);
    expect(report.claimed).toBe(2);
  });
});

describe("one bad candidate never poisons the batch", () => {
  function sweepWith(throwOnPublish: (call: number) => unknown) {
    const { repository, calls } = fakeRepository({ candidates: ["gdv_1", "gdv_2", "gdv_3"] });
    let publishes = 0;
    const runner = new DeliverableValidationRunner(
      {},
      {
        repository: {
          ...repository,
          async publishDeliverable(input) {
            publishes += 1;
            const thrown = throwOnPublish(publishes);
            if (thrown !== undefined) throw thrown;
            return repository.publishDeliverable(input);
          },
        },
        validator: {
          async validateDeliverable() {
            return { kind: "VALID", facts: FACTS };
          },
        },
        clock: () => 1_000,
        leaseTokens: { next: () => "vlease_next" },
      },
    );
    return { runner, calls };
  }

  it("reports a defect as that candidate's outcome, with its code, and sweeps on", async () => {
    const { runner } = sweepWith((call) =>
      call === 2 ? new DeliverableValidationDefect("DISCLOSURE_NOT_DRAWN") : undefined,
    );
    const report = await runner.runOnce(3, CONTEXT);
    expect(report.outcomes).toEqual([
      { deliverableVersionId: "gdv_1", outcome: { kind: "PUBLISHED_AND_CONSUMED" } },
      {
        deliverableVersionId: "gdv_2",
        outcome: { kind: "FAILED", code: "DISCLOSURE_NOT_DRAWN" },
      },
      { deliverableVersionId: "gdv_3", outcome: { kind: "PUBLISHED_AND_CONSUMED" } },
    ]);
    expect(report.claimed).toBe(2);
  });

  it("reports a settlement defect with its code (ADR-0082)", async () => {
    // A terminal verdict raises it; thrown from this harness's one scripted call,
    // since the code kept is the sweep's choice whichever call raised it.
    const { runner } = sweepWith((call) =>
      call === 1 ? new DeliverableSettlementDefect("RESERVATION_NOT_SETTLEABLE") : undefined,
    );
    const report = await runner.runOnce(3, CONTEXT);
    expect(report.outcomes[0]).toEqual({
      deliverableVersionId: "gdv_1",
      outcome: { kind: "FAILED", code: "RESERVATION_NOT_SETTLEABLE" },
    });
  });

  it("keeps nothing of an error that is not one of its defects", async () => {
    const { runner } = sweepWith((call) =>
      call === 1 ? new Error("connection to db.internal:5432 reset") : undefined,
    );
    const report = await runner.runOnce(3, CONTEXT);
    expect(report.outcomes[0]).toEqual({
      deliverableVersionId: "gdv_1",
      outcome: { kind: "FAILED", code: null },
    });
    expect(JSON.stringify(report)).not.toContain("db.internal");
    expect(report.outcomes.slice(1).map((o) => o.outcome.kind)).toEqual([
      "PUBLISHED_AND_CONSUMED",
      "PUBLISHED_AND_CONSUMED",
    ]);
  });

  it("still throws from runOne, where the caller asked about one deliverable", async () => {
    const { runner } = sweepWith(() => new DeliverableValidationDefect("CLEAN_MASTER_NOT_RECORDED"));
    const error = await runner.runOne("org_1", "gdv_1", CONTEXT).catch((e: unknown) => e);
    expect((error as DeliverableValidationDefect).code).toBe("CLEAN_MASTER_NOT_RECORDED");
  });
});

describe("configuration is proved, not assumed", () => {
  it("refuses a lease or retry delay outside its bound at construction", () => {
    const { repository } = fakeRepository({});
    const deps = {
      repository,
      validator: { async validateDeliverable() { return { kind: "RETRYABLE_FAILURE" }; } },
      clock: () => 0,
      leaseTokens: { next: () => "vlease" },
    };
    expect(() => new DeliverableValidationRunner({ leaseMs: 1 }, deps)).toThrow(
      /Deliverable validation lease/,
    );
    expect(() => new DeliverableValidationRunner({ retryDelayMs: 1 }, deps)).toThrow(
      /Deliverable validation retry delay/,
    );
    expect(() => new DeliverableValidationRunner({ leaseMs: 60_000 }, deps)).not.toThrow();
  });
});
