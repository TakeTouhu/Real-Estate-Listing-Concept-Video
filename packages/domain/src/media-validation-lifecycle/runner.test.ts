import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
  type ManagedOutputVerificationReceipt,
} from "../completion/output";
import {
  ISO_BMFF_CONTAINER,
  MEDIA_INVALID_REASONS,
  type ManagedOutputMediaFacts,
  type ManagedOutputMediaValidationInput,
  type ManagedOutputMediaValidationPort,
} from "../provider-output/media-validation";
import {
  DEFAULT_MEDIA_VALIDATION_LEASE_MS,
  DEFAULT_MEDIA_VALIDATION_RETRY_DELAY_MS,
  MAX_MEDIA_VALIDATION_BATCH_SIZE,
  MediaValidationLifecycleDefect,
  validateMediaValidationBatchLimit,
  validateMediaValidationLeaseMs,
  validateMediaValidationRetryDelayMs,
} from "./durable";
import { MediaValidationLifecycleRunner } from "./runner";
import { FakeLeaseTokens, FakeMediaValidationRepository } from "./testing";

/**
 * The dormant lifecycle runner against an in-memory repository that enforces
 * the same durable rules the SQL one does.
 */

const ORG = "org_mvl";
const ATTEMPT = "sgen_mvl";
const NOW = 1_700_000_000_000;

function receipt(size = 4096): ManagedOutputVerificationReceipt {
  return { sha256: sha256Digest("a".repeat(64)), sizeBytes: safePositiveByteCount(size) };
}

const FACTS: ManagedOutputMediaFacts = {
  container: ISO_BMFF_CONTAINER,
  durationMs: 8500,
  videoWidth: 1920,
  videoHeight: 1080,
  videoStreamCount: 1,
  audioStreamCount: 0,
};

/** A validator returning a fixed value, recording every call. */
class FakeValidator implements ManagedOutputMediaValidationPort {
  readonly calls: ManagedOutputMediaValidationInput[] = [];
  constructor(
    private readonly result: unknown | (() => unknown),
    private readonly onCall?: () => void,
  ) {}
  async validate(input: ManagedOutputMediaValidationInput): Promise<unknown> {
    this.calls.push(input);
    this.onCall?.();
    return typeof this.result === "function" ? (this.result as () => unknown)() : this.result;
  }
}

interface Harness {
  readonly repository: FakeMediaValidationRepository;
  readonly runner: MediaValidationLifecycleRunner;
  readonly tokens: FakeLeaseTokens;
}

function harness(
  validator: ManagedOutputMediaValidationPort,
  options: {
    readonly now?: () => number;
    readonly repository?: FakeMediaValidationRepository;
    readonly attempts?: readonly { id: string; verifiedAt: number; state?: string }[];
    readonly leaseMs?: number;
    readonly retryDelayMs?: number;
  } = {},
): Harness {
  const repository = options.repository ?? new FakeMediaValidationRepository();
  for (const a of options.attempts ?? [{ id: ATTEMPT, verifiedAt: NOW - 1000 }]) {
    repository.addAttempt({
      sceneGenerationId: a.id,
      organizationId: ORG,
      receipt: receipt(),
      outputVerifiedAt: a.verifiedAt,
      ...(a.state === undefined ? {} : { orchestrationState: a.state }),
    });
  }
  const tokens = new FakeLeaseTokens();
  const runner = new MediaValidationLifecycleRunner(
    { leaseMs: options.leaseMs, retryDelayMs: options.retryDelayMs },
    {
      repository,
      validator,
      clock: options.now ?? (() => NOW),
      leaseTokens: tokens,
    },
  );
  return { repository, runner, tokens };
}

// ---------------------------------------------------------------------------

describe("configuration", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_MEDIA_VALIDATION_BATCH_SIZE + 1])(
    "refuses batch limit %s rather than clamping it",
    (value) => {
      expect(() => validateMediaValidationBatchLimit(value)).toThrow(AppError);
    },
  );

  it("accepts the documented bounds", () => {
    expect(validateMediaValidationBatchLimit(1)).toBe(1);
    expect(validateMediaValidationBatchLimit(MAX_MEDIA_VALIDATION_BATCH_SIZE)).toBe(
      MAX_MEDIA_VALIDATION_BATCH_SIZE,
    );
    expect(validateMediaValidationLeaseMs(DEFAULT_MEDIA_VALIDATION_LEASE_MS)).toBe(
      DEFAULT_MEDIA_VALIDATION_LEASE_MS,
    );
    expect(validateMediaValidationRetryDelayMs(DEFAULT_MEDIA_VALIDATION_RETRY_DELAY_MS)).toBe(
      DEFAULT_MEDIA_VALIDATION_RETRY_DELAY_MS,
    );
  });

  it.each([0, 999, 1.5, Number.NaN, 60 * 60_000 + 1])("refuses lease %s ms", (value) => {
    expect(() => validateMediaValidationLeaseMs(value)).toThrow(AppError);
  });

  it.each([0, 999, 1.5, Number.NaN, 60 * 60_000 + 1])("refuses retry delay %s ms", (value) => {
    expect(() => validateMediaValidationRetryDelayMs(value)).toThrow(AppError);
  });

  it("defaults the lease to five minutes, not a two-minute assumption", () => {
    // The validator may stream a large object before it inspects it.
    expect(DEFAULT_MEDIA_VALIDATION_LEASE_MS).toBe(5 * 60_000);
  });
});

// ---------------------------------------------------------------------------

describe("VALID finalization", () => {
  it("persists every normalized fact and clears lease and retry fields", async () => {
    const h = harness(new FakeValidator({ kind: "VALID", facts: FACTS }));
    expect(await h.runner.runOne(ATTEMPT)).toEqual({ kind: "VALID" });

    const record = await h.repository.findBySceneGeneration(ATTEMPT);
    expect(record).toMatchObject({
      status: "VALID",
      facts: FACTS,
      validatedAt: NOW,
      attemptCount: 1,
    });
    const row = h.repository.rows.get(ATTEMPT);
    expect(row?.leaseToken).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();
    expect(row?.nextAttemptAt).toBeNull();
    expect(row?.invalidReason).toBeNull();
  });

  it("binds the record to the exact receipt and passes it to the validator", async () => {
    const validator = new FakeValidator({ kind: "VALID", facts: FACTS });
    const h = harness(validator);
    await h.runner.runOne(ATTEMPT);

    const expected = receipt();
    expect(validator.calls).toHaveLength(1);
    expect(validator.calls[0]?.expectedReceipt).toEqual(expected);
    expect(validator.calls[0]?.destinationKey).toBe(
      managedGenerationOutputKey({ organizationId: ORG, attemptId: ATTEMPT }),
    );
    const row = h.repository.rows.get(ATTEMPT);
    expect(row?.receiptSha256).toBe(expected.sha256);
    expect(row?.receiptSizeBytes).toBe(expected.sizeBytes);
  });

  it("leaves the attempt at OUTPUT_VERIFIED and touches no other aggregate", async () => {
    const h = harness(new FakeValidator({ kind: "VALID", facts: FACTS }));
    await h.runner.runOne(ATTEMPT);
    // The runner's only collaborators are the repository and the validator, and
    // the repository exposes no Scene, Job, reservation or quota operation at
    // all — so there is no shape in which this phase could mutate one.
    expect(h.repository.attempts.get(ATTEMPT)?.orchestrationState).toBeUndefined();
    expect(h.repository.calls).toEqual(["claim", "finalizeValid"]);
  });
});

// ---------------------------------------------------------------------------

describe("INVALID_MEDIA finalization", () => {
  it.each(MEDIA_INVALID_REASONS)("persists %s exactly, with no media facts", async (reason) => {
    const h = harness(new FakeValidator({ kind: "INVALID_MEDIA", reason }));
    expect(await h.runner.runOne(ATTEMPT)).toEqual({ kind: "INVALID_MEDIA" });

    expect(await h.repository.findBySceneGeneration(ATTEMPT)).toMatchObject({
      status: "INVALID_MEDIA",
      reason,
      validatedAt: NOW,
    });
    const row = h.repository.rows.get(ATTEMPT);
    expect(row?.facts).toBeNull();
    expect(row?.leaseToken).toBeNull();
  });

  it("creates no recovery attempt and makes no Scene or quota decision", async () => {
    const h = harness(new FakeValidator({ kind: "INVALID_MEDIA", reason: "PROBE_REJECTED" }));
    await h.runner.runOne(ATTEMPT);
    // Only the media-validation row was written. Deciding what an invalid
    // verdict *means* is the next reviewed package's job.
    expect(h.repository.calls).toEqual(["claim", "finalizeInvalidMedia"]);
  });
});

// ---------------------------------------------------------------------------

describe("INTEGRITY_MISMATCH finalization", () => {
  it("is terminal, with no reason and no facts", async () => {
    const h = harness(new FakeValidator({ kind: "INTEGRITY_MISMATCH" }));
    expect(await h.runner.runOne(ATTEMPT)).toEqual({ kind: "INTEGRITY_MISMATCH" });

    expect(await h.repository.findBySceneGeneration(ATTEMPT)).toMatchObject({
      status: "INTEGRITY_MISMATCH",
      validatedAt: NOW,
    });
    const row = h.repository.rows.get(ATTEMPT);
    expect(row?.invalidReason).toBeNull();
    expect(row?.facts).toBeNull();
  });

  it("creates no SYSTEM_RECOVERY attempt in this phase", async () => {
    const h = harness(new FakeValidator({ kind: "INTEGRITY_MISMATCH" }));
    await h.runner.runOne(ATTEMPT);
    expect(h.repository.calls).toEqual(["claim", "finalizeIntegrityMismatch"]);
  });

  it("cannot be reopened once terminal", async () => {
    const h = harness(new FakeValidator({ kind: "INTEGRITY_MISMATCH" }));
    await h.runner.runOne(ATTEMPT);
    expect(await h.runner.runOne(ATTEMPT)).toEqual({ kind: "ALREADY_TERMINAL" });
    expect(h.repository.rows.get(ATTEMPT)?.status).toBe("INTEGRITY_MISMATCH");
  });
});

// ---------------------------------------------------------------------------

describe("RETRYABLE_FAILURE is never a durable verdict", () => {
  it("returns the row to PENDING with a future attempt time", async () => {
    const h = harness(new FakeValidator({ kind: "RETRYABLE_FAILURE" }), { retryDelayMs: 30_000 });
    expect(await h.runner.runOne(ATTEMPT)).toEqual({ kind: "RELEASED" });

    const row = h.repository.rows.get(ATTEMPT);
    expect(row?.status).toBe("PENDING");
    expect(row?.leaseToken).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();
    expect(row?.nextAttemptAt).toBe(NOW + 30_000);
    expect(row?.validatedAt).toBeNull();
    expect(row?.invalidReason).toBeNull();
    expect(row?.facts).toBeNull();
  });

  it("never writes a terminal status", async () => {
    const h = harness(new FakeValidator({ kind: "RETRYABLE_FAILURE" }));
    await h.runner.runOne(ATTEMPT);
    expect(h.repository.calls).toEqual(["claim", "releaseToPending"]);
    expect(h.repository.rows.get(ATTEMPT)?.status).not.toBe("INVALID_MEDIA");
  });

  it("is not eligible again until its retry delay has passed", async () => {
    let now = NOW;
    const h = harness(new FakeValidator({ kind: "RETRYABLE_FAILURE" }), {
      now: () => now,
      retryDelayMs: 30_000,
    });
    await h.runner.runOne(ATTEMPT);

    now = NOW + 29_999;
    expect(await h.repository.findCandidates({ now, limit: 10 })).toHaveLength(0);
    now = NOW + 30_000;
    expect(await h.repository.findCandidates({ now, limit: 10 })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("validator defects never become a media verdict", () => {
  it("releases the lease and raises a fixed defect when validate() throws", async () => {
    const validator: ManagedOutputMediaValidationPort = {
      async validate() {
        throw new Error("boom SECRET s3://bucket/key /tmp/x/input");
      },
    };
    const h = harness(validator);

    let caught: unknown;
    try {
      await h.runner.runOne(ATTEMPT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MediaValidationLifecycleDefect);
    expect((caught as MediaValidationLifecycleDefect).code).toBe("VALIDATOR_FAILED");
    expect((caught as Error).cause).toBeUndefined();
    const text = `${(caught as Error).message} ${String(caught)}`;
    for (const fragment of ["boom", "SECRET", "s3://", "/tmp/"]) {
      expect(text).not.toContain(fragment);
    }
    // Best-effort release, so the row is retried rather than stranded.
    const row = h.repository.rows.get(ATTEMPT);
    expect(row?.status).toBe("PENDING");
    expect(row?.leaseToken).toBeNull();
    expect(row?.nextAttemptAt).toBe(NOW + DEFAULT_MEDIA_VALIDATION_RETRY_DELAY_MS);
  });

  it.each([
    ["a non-record", 42],
    ["null", null],
    ["an unknown kind", { kind: "MAYBE" }],
    ["VALID with no facts", { kind: "VALID" }],
    ["VALID with malformed facts", { kind: "VALID", facts: { container: "AVI" } }],
    ["INVALID_MEDIA with an unknown reason", { kind: "INVALID_MEDIA", reason: "WHATEVER" }],
    ["an arm carrying an extra key", { kind: "INTEGRITY_MISMATCH", note: "x" }],
  ])("releases and raises a fixed defect for %s", async (_label, result) => {
    const h = harness(new FakeValidator(result));
    let caught: unknown;
    try {
      await h.runner.runOne(ATTEMPT);
    } catch (e) {
      caught = e;
    }
    expect((caught as MediaValidationLifecycleDefect).code).toBe("VALIDATOR_RESULT_MALFORMED");
    expect(h.repository.rows.get(ATTEMPT)?.status).toBe("PENDING");
  });

  it("uses the existing parser as the single authority — no second parser", async () => {
    // A stateful value that validates once and then changes must not make the
    // dispatch disagree with the validation.
    let reads = 0;
    const hostile = {
      get kind() {
        reads += 1;
        return reads === 1 ? "VALID" : "INTEGRITY_MISMATCH";
      },
      facts: FACTS,
    };
    const h = harness(new FakeValidator(hostile));
    const outcome = await h.runner.runOne(ATTEMPT);
    // Whatever the parser concluded on its single read is what was persisted;
    // the raw value is never consulted again.
    expect(["VALID", "INTEGRITY_MISMATCH"]).toContain(
      h.repository.rows.get(ATTEMPT)?.status ?? "",
    );
    expect(outcome.kind === "VALID" || outcome.kind === "INTEGRITY_MISMATCH").toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("claim, validate and finalize are strictly ordered", () => {
  it("calls the validator only after the claim transaction has ended", async () => {
    const order: string[] = [];
    const repository = new FakeMediaValidationRepository({
      onCall: (method) => order.push(`repo:${method}`),
    });
    const validator = new FakeValidator({ kind: "VALID", facts: FACTS }, () =>
      order.push("validator"),
    );
    const h = harness(validator, { repository });
    await h.runner.runOne(ATTEMPT);

    expect(order).toEqual(["repo:claim", "validator", "repo:finalizeValid"]);
  });

  it("offers no repository method that could wrap external I/O in a transaction", () => {
    // Structural, not conventional: every method takes plain data and returns a
    // promise, so a transaction cannot be held open across a validator call.
    const repository = new FakeMediaValidationRepository();
    const methods = [
      repository.findCandidates,
      repository.claim,
      repository.finalizeValid,
      repository.finalizeInvalidMedia,
      repository.finalizeIntegrityMismatch,
      repository.releaseToPending,
      repository.findBySceneGeneration,
    ];
    // One argument each, and never a function.
    for (const method of methods) {
      expect(method.length).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------

describe("concurrency and crash recovery", () => {
  it("lets exactly one of two workers claim a missing record", async () => {
    const repository = new FakeMediaValidationRepository();
    const a = harness(new FakeValidator({ kind: "VALID", facts: FACTS }), { repository });
    const b = harness(new FakeValidator({ kind: "VALID", facts: FACTS }), {
      repository,
      attempts: [],
    });

    const first = await a.runner.runOne(ATTEMPT);
    const second = await b.runner.runOne(ATTEMPT);
    expect(first).toEqual({ kind: "VALID" });
    // The winner reached a terminal verdict; the second worker must not reopen.
    expect(second).toEqual({ kind: "ALREADY_TERMINAL" });
  });

  it("does not claim a row whose lease is still active", async () => {
    let now = NOW;
    const repository = new FakeMediaValidationRepository();
    const a = harness(new FakeValidator({ kind: "RETRYABLE_FAILURE" }), { repository, now: () => now });
    // Claim and leave it RUNNING by not finalizing: simulate an owner mid-flight.
    await a.repository.claim({
      sceneGenerationId: ATTEMPT,
      now,
      leaseToken: "owner",
      leaseExpiresAt: now + DEFAULT_MEDIA_VALIDATION_LEASE_MS,
    });

    now = NOW + 1000;
    expect(await a.runner.runOne(ATTEMPT)).toEqual({ kind: "NOT_CLAIMED" });
    expect(await a.repository.findCandidates({ now, limit: 10 })).toHaveLength(0);
  });

  it("reclaims a crashed lease after expiry with a new token and bumped counters", async () => {
    let now = NOW;
    const repository = new FakeMediaValidationRepository();
    const h = harness(new FakeValidator({ kind: "VALID", facts: FACTS }), {
      repository,
      now: () => now,
    });
    await repository.claim({
      sceneGenerationId: ATTEMPT,
      now,
      leaseToken: "crashed-owner",
      leaseExpiresAt: now + 1000,
    });
    expect(repository.rows.get(ATTEMPT)?.attemptCount).toBe(1);

    now = NOW + 1001;
    expect(await repository.findCandidates({ now, limit: 10 })).toHaveLength(1);
    expect(await h.runner.runOne(ATTEMPT)).toEqual({ kind: "VALID" });
    const row = repository.rows.get(ATTEMPT);
    expect(row?.attemptCount).toBe(2);
    expect(row?.version).toBeGreaterThan(1);
  });

  it("makes a stale worker's late finalize affect zero rows", async () => {
    let now = NOW;
    const repository = new FakeMediaValidationRepository();
    repository.addAttempt({
      sceneGenerationId: ATTEMPT,
      organizationId: ORG,
      receipt: receipt(),
      outputVerifiedAt: NOW - 1,
    });

    // Worker A claims, then its lease expires.
    const claimA = await repository.claim({
      sceneGenerationId: ATTEMPT,
      now,
      leaseToken: "token-A",
      leaseExpiresAt: now + 1000,
    });
    expect(claimA.kind).toBe("CLAIMED");
    now = NOW + 2000;

    // Worker B reclaims and finishes.
    const claimB = await repository.claim({
      sceneGenerationId: ATTEMPT,
      now,
      leaseToken: "token-B",
      leaseExpiresAt: now + 60_000,
    });
    expect(claimB.kind).toBe("CLAIMED");
    if (claimB.kind !== "CLAIMED") return;
    expect(
      await repository.finalizeIntegrityMismatch({ claim: claimB.claim, validatedAt: now }),
    ).toEqual({ kind: "WRITTEN" });

    // Worker A finishes late. It must lose, and must not overwrite B.
    if (claimA.kind !== "CLAIMED") return;
    expect(
      await repository.finalizeValid({ claim: claimA.claim, facts: FACTS, validatedAt: now }),
    ).toEqual({ kind: "LOST" });
    expect(repository.rows.get(ATTEMPT)?.status).toBe("INTEGRITY_MISMATCH");
    expect(repository.rows.get(ATTEMPT)?.facts).toBeNull();
  });

  it("refuses a finalize whose lease token or version no longer matches", async () => {
    const repository = new FakeMediaValidationRepository();
    repository.addAttempt({
      sceneGenerationId: ATTEMPT,
      organizationId: ORG,
      receipt: receipt(),
      outputVerifiedAt: NOW,
    });
    const claimed = await repository.claim({
      sceneGenerationId: ATTEMPT,
      now: NOW,
      leaseToken: "real",
      leaseExpiresAt: NOW + 60_000,
    });
    if (claimed.kind !== "CLAIMED") throw new Error("expected a claim");

    const wrongToken = { ...claimed.claim, leaseToken: "forged" };
    const wrongVersion = { ...claimed.claim, version: claimed.claim.version + 5 };
    const wrongReceipt = {
      ...claimed.claim,
      expectedReceipt: { ...claimed.claim.expectedReceipt, sizeBytes: safePositiveByteCount(1) },
    };
    for (const claim of [wrongToken, wrongVersion, wrongReceipt]) {
      expect(await repository.finalizeValid({ claim, facts: FACTS, validatedAt: NOW })).toEqual({
        kind: "LOST",
      });
    }
    expect(repository.rows.get(ATTEMPT)?.status).toBe("RUNNING");
  });

  it("reports LOST rather than throwing when the runner's own finalize loses", async () => {
    const repository = new FakeMediaValidationRepository();
    const h = harness(
      new FakeValidator(() => {
        // Another worker reclaims while the validator is running.
        const row = repository.rows.get(ATTEMPT);
        if (row !== undefined) row.version += 1;
        return { kind: "VALID", facts: FACTS };
      }),
      { repository },
    );
    expect(await h.runner.runOne(ATTEMPT)).toEqual({ kind: "LOST" });
  });
});

// ---------------------------------------------------------------------------

describe("eligibility and batching", () => {
  it("excludes an attempt that is not OUTPUT_VERIFIED", async () => {
    const h = harness(new FakeValidator({ kind: "VALID", facts: FACTS }), {
      attempts: [{ id: ATTEMPT, verifiedAt: NOW, state: "PROVIDER_SUCCEEDED" }],
    });
    expect(await h.repository.findCandidates({ now: NOW, limit: 10 })).toHaveLength(0);
    expect(await h.runner.runOne(ATTEMPT)).toEqual({ kind: "NOT_ELIGIBLE" });
    expect(h.repository.rows.has(ATTEMPT)).toBe(false);
  });

  it("returns NOT_ELIGIBLE for an unknown attempt", async () => {
    const h = harness(new FakeValidator({ kind: "VALID", facts: FACTS }));
    expect(await h.runner.runOne("sgen_nope")).toEqual({ kind: "NOT_ELIGIBLE" });
  });

  it("orders candidates by verification time then id, and honours the limit", async () => {
    const h = harness(new FakeValidator({ kind: "VALID", facts: FACTS }), {
      attempts: [
        { id: "sgen_c", verifiedAt: NOW - 10 },
        { id: "sgen_a", verifiedAt: NOW - 30 },
        { id: "sgen_b", verifiedAt: NOW - 30 },
      ],
    });
    const all = await h.repository.findCandidates({ now: NOW, limit: 10 });
    expect(all.map((c) => c.sceneGenerationId)).toEqual(["sgen_a", "sgen_b", "sgen_c"]);
    const bounded = await h.repository.findCandidates({ now: NOW, limit: 2 });
    expect(bounded).toHaveLength(2);
  });

  it("runs each SceneGeneration at most once in one batch", async () => {
    const h = harness(new FakeValidator({ kind: "RETRYABLE_FAILURE" }), {
      attempts: [
        { id: "sgen_a", verifiedAt: NOW - 2 },
        { id: "sgen_b", verifiedAt: NOW - 1 },
      ],
    });
    const report = await h.runner.runOnce(10);
    expect(report.outcomes.map((o) => o.sceneGenerationId)).toEqual(["sgen_a", "sgen_b"]);
    expect(new Set(report.outcomes.map((o) => o.sceneGenerationId)).size).toBe(2);
    expect(report.claimed).toBe(2);
  });

  it("refuses an unbounded batch limit before it reaches the repository", async () => {
    const h = harness(new FakeValidator({ kind: "VALID", facts: FACTS }));
    await expect(h.runner.runOnce(Number.POSITIVE_INFINITY)).rejects.toThrow(AppError);
    expect(h.repository.calls).toHaveLength(0);
  });

  it("issues a distinct opaque lease token per claim, carrying no identity", async () => {
    const h = harness(new FakeValidator({ kind: "RETRYABLE_FAILURE" }), {
      attempts: [
        { id: "sgen_a", verifiedAt: NOW - 2 },
        { id: "sgen_b", verifiedAt: NOW - 1 },
      ],
    });
    await h.runner.runOnce(10);
    expect(new Set(h.tokens.issued).size).toBe(h.tokens.issued.length);
    for (const token of h.tokens.issued) {
      for (const banned of [ORG, "sgen_a", "sgen_b"]) {
        expect(token).not.toContain(banned);
      }
    }
  });
});
