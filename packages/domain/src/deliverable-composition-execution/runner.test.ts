/**
 * The composition-execution runner: what it calls, in what order, and — most of
 * this suite — what it refuses to call.
 *
 * Every dependency is a recording fake. The interesting assertions are negative
 * ones: that a deterministic refusal reaches the database having touched no
 * adapter at all, and that a transient failure is never recorded as a terminal
 * one. Those two mistakes are invisible in a passing happy path and expensive
 * in production — the first burns a worker downloading gigabytes to rediscover
 * arithmetic, and the second builds an automatic retry loop nobody is told
 * about.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_DELIVERABLE_COMPOSITION_SOURCE_BYTES,
  managedDeliverableOutputKey,
} from "./durable";
import { resolveCompositionProfile } from "./profile";
import { DeliverableCompositionRunner } from "./runner";
import type { DeliverableCompositionReport } from "./runner";
import type {
  BlockCompositionInput,
  BlockCompositionOutcome,
  ClaimCompositionWorkOutcome,
  ComposeDeliverableInput,
  ComposeDeliverableOutcome,
  CompositionSceneInput,
  DeferCompositionInput,
  DeferCompositionOutcome,
  DeliverableCompositionCandidate,
  DeliverableCompositionClaim,
  DeliverableCompositionRecord,
  DeliverableCompositionRepository,
  DeliverableCompositionSourceMaterializer,
  DeliverableMediaComposer,
  DeliverableOutputPublisher,
  FinalizeCompositionInput,
  FinalizeCompositionOutcome,
  MaterializeCompositionSourcesOutcome,
  PublishDeliverableOutcome,
} from "./ports";
import { managedGenerationOutputKey, safePositiveByteCount, sha256Digest } from "../completion/output";
import type { TransitionContext } from "../orchestration/ports";

const ORG = "org_1";
const JOB = "job_1";
const VERSION = "gdv_1";
const NOW = 1_700_000_000_000;

const PROFILE = (() => {
  const resolved = resolveCompositionProfile({
    targetAspectRatio: "16:9",
    targetOutputResolution: "1080p",
  });
  if (resolved.kind !== "RESOLVED") throw new Error("fixture profile must resolve");
  return resolved.profile;
})();

function scene(position: number, durationSeconds: number, sizeBytes = 1_000): CompositionSceneInput {
  return {
    position,
    generationSceneId: `gs_${position}`,
    sceneGenerationAttemptId: `sg_${position}`,
    sourceStorageKey: managedGenerationOutputKey({
      organizationId: ORG,
      attemptId: `sg_${position}`,
    }),
    sourceSha256: sha256Digest("a".repeat(64)),
    sourceSizeBytes: safePositiveByteCount(sizeBytes),
    durationSeconds,
  };
}

function claimOf(overrides: Partial<DeliverableCompositionClaim> = {}): DeliverableCompositionClaim {
  const scenes = overrides.scenes ?? [scene(1, 5), scene(2, 5)];
  let seconds = 0;
  for (const one of scenes) seconds += one.durationSeconds;
  return {
    organizationId: ORG,
    generationJobId: JOB,
    deliverableVersionId: VERSION,
    compositionId: "gdcmp_1",
    leaseToken: "clease_1",
    version: 1,
    attemptCount: 1,
    profile: PROFILE,
    outputStorageKey: managedDeliverableOutputKey({
      organizationId: ORG,
      deliverableVersionId: VERSION,
    }),
    requestedDurationSeconds: seconds,
    ...overrides,
    scenes,
  };
}

// ---------------------------------------------------------------------------
// Recording fakes
// ---------------------------------------------------------------------------

interface RepositoryScript {
  readonly claim?: ClaimCompositionWorkOutcome;
  readonly finalize?: FinalizeCompositionOutcome;
  readonly defer?: DeferCompositionOutcome;
  readonly block?: BlockCompositionOutcome;
  readonly candidates?: readonly DeliverableCompositionCandidate[];
}

class FakeRepository implements DeliverableCompositionRepository {
  readonly finalized: FinalizeCompositionInput[] = [];
  readonly deferred: DeferCompositionInput[] = [];
  readonly blocked: BlockCompositionInput[] = [];
  claims = 0;

  constructor(private readonly script: RepositoryScript = {}) {}

  async findCompositionCandidates(): Promise<readonly DeliverableCompositionCandidate[]> {
    return (
      this.script.candidates ?? [
        { deliverableVersionId: VERSION, generationJobId: JOB, organizationId: ORG },
      ]
    );
  }

  async claimCompositionWork(): Promise<ClaimCompositionWorkOutcome> {
    this.claims += 1;
    return this.script.claim ?? { kind: "CLAIMED", claim: claimOf() };
  }

  async finalizeComposition(input: FinalizeCompositionInput): Promise<FinalizeCompositionOutcome> {
    this.finalized.push(input);
    return this.script.finalize ?? { kind: "FINALIZED" };
  }

  async deferComposition(input: DeferCompositionInput): Promise<DeferCompositionOutcome> {
    this.deferred.push(input);
    return this.script.defer ?? { kind: "DEFERRED" };
  }

  async blockComposition(input: BlockCompositionInput): Promise<BlockCompositionOutcome> {
    this.blocked.push(input);
    return this.script.block ?? { kind: "BLOCKED" };
  }

  async findCompositionByVersionId(): Promise<DeliverableCompositionRecord | null> {
    return null;
  }
}

class FakeMaterializer implements DeliverableCompositionSourceMaterializer {
  calls = 0;
  released = 0;

  constructor(private readonly outcome: MaterializeCompositionSourcesOutcome | null = null) {}

  async materialize(input: {
    readonly organizationId: string;
    readonly scenes: readonly CompositionSceneInput[];
  }): Promise<MaterializeCompositionSourcesOutcome> {
    this.calls += 1;
    if (this.outcome !== null) return this.outcome;
    return {
      kind: "MATERIALIZED",
      sources: input.scenes.map((one, index) => ({
        position: one.position,
        localPath: `/tmp/vta-compose-x/input-${index}`,
      })),
      release: async () => {
        this.released += 1;
      },
    };
  }
}

class FakeComposer implements DeliverableMediaComposer {
  readonly inputs: ComposeDeliverableInput[] = [];

  constructor(private readonly outcome: ComposeDeliverableOutcome = { kind: "SUCCESS" }) {}

  async compose(input: ComposeDeliverableInput): Promise<ComposeDeliverableOutcome> {
    this.inputs.push(input);
    return this.outcome;
  }
}

class FakePublisher implements DeliverableOutputPublisher {
  calls = 0;

  constructor(
    private readonly outcome: PublishDeliverableOutcome = {
      kind: "PUBLISHED",
      sha256: sha256Digest("b".repeat(64)),
      sizeBytes: safePositiveByteCount(4_096),
    },
  ) {}

  async publish(): Promise<PublishDeliverableOutcome> {
    this.calls += 1;
    return this.outcome;
  }
}

interface Harness {
  readonly repository: FakeRepository;
  readonly materializer: FakeMaterializer;
  readonly composer: FakeComposer;
  readonly publisher: FakePublisher;
  run(): Promise<DeliverableCompositionReport>;
}

const CONTEXT = (organizationId: string): TransitionContext => ({
  eventType: "test",
  actorType: "SYSTEM",
  actorUserId: null,
  reasonCode: "TEST",
  correlationId: `corr_${organizationId}`,
  causationId: null,
  metadata: {},
});

function harness(parts: {
  repository?: FakeRepository;
  materializer?: FakeMaterializer;
  composer?: FakeComposer;
  publisher?: FakePublisher;
} = {}): Harness {
  const repository = parts.repository ?? new FakeRepository();
  const materializer = parts.materializer ?? new FakeMaterializer();
  const composer = parts.composer ?? new FakeComposer();
  const publisher = parts.publisher ?? new FakePublisher();
  const runner = new DeliverableCompositionRunner({
    repository,
    materializer,
    composer,
    publisher,
    clock: () => NOW,
    context: CONTEXT,
    outputPathFor: () => "/tmp/vta-compose-x/output.mp4",
  });
  return {
    repository,
    materializer,
    composer,
    publisher,
    run: () => runner.runOnce(5),
  };
}

// ---------------------------------------------------------------------------
// A. The happy path
// ---------------------------------------------------------------------------

describe("A — a claimable deliverable is composed, published and finalized", () => {
  it("calls each adapter once, in order, and finalizes with the published receipt", async () => {
    const h = harness();
    const report = await h.run();

    expect(h.materializer.calls).toBe(1);
    expect(h.composer.inputs).toHaveLength(1);
    expect(h.publisher.calls).toBe(1);
    expect(h.repository.finalized).toHaveLength(1);
    expect(h.repository.deferred).toHaveLength(0);
    expect(h.repository.blocked).toHaveLength(0);
    expect(report.finalized).toBe(1);
    expect(report.blocked).toBe(0);
    expect(report.deferred).toBe(0);
  });

  it("hands the composer one clip per scene, in plan order, at the frozen durations", async () => {
    const h = harness();
    await h.run();
    const input = h.composer.inputs[0]!;
    expect(input.clips.map((clip) => clip.durationSeconds)).toEqual([5, 5]);
    expect(input.clips.map((clip) => clip.localPath)).toEqual([
      "/tmp/vta-compose-x/input-0",
      "/tmp/vta-compose-x/input-1",
    ]);
    expect(input.profile).toEqual(PROFILE);
  });

  it("releases the temporary directory on the success path too", async () => {
    const h = harness();
    await h.run();
    expect(h.materializer.released).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B–C. Deterministic refusals, decided before any adapter runs
// ---------------------------------------------------------------------------

describe("B — an over-budget plan is blocked before a single byte moves", () => {
  const oversized = claimOf({
    scenes: [
      scene(1, 5, MAX_DELIVERABLE_COMPOSITION_SOURCE_BYTES),
      scene(2, 5, MAX_DELIVERABLE_COMPOSITION_SOURCE_BYTES),
    ],
  });

  it("blocks with SOURCE_BYTES_LIMIT_EXCEEDED", async () => {
    const h = harness({
      repository: new FakeRepository({ claim: { kind: "CLAIMED", claim: oversized } }),
    });
    const report = await h.run();
    expect(h.repository.blocked.map((one) => one.blockCode)).toEqual([
      "SOURCE_BYTES_LIMIT_EXCEEDED",
    ]);
    expect(report.blocked).toBe(1);
    expect(report.deferred).toBe(0);
  });

  it("calls the materializer, composer and publisher zero times", async () => {
    const h = harness({
      repository: new FakeRepository({ claim: { kind: "CLAIMED", claim: oversized } }),
    });
    await h.run();
    expect(h.materializer.calls).toBe(0);
    expect(h.composer.inputs).toHaveLength(0);
    expect(h.publisher.calls).toBe(0);
  });

  it("never records the overrun as a retry", async () => {
    const h = harness({
      repository: new FakeRepository({ claim: { kind: "CLAIMED", claim: oversized } }),
    });
    await h.run();
    expect(h.repository.deferred).toHaveLength(0);
  });
});

describe("C — a duration-invariant mismatch is blocked, never redistributed", () => {
  const mismatched = claimOf({ scenes: [scene(1, 5), scene(2, 5)], requestedDurationSeconds: 30 });

  it("blocks with DURATION_INVARIANT_MISMATCH and runs no adapter", async () => {
    const h = harness({
      repository: new FakeRepository({ claim: { kind: "CLAIMED", claim: mismatched } }),
    });
    const report = await h.run();
    expect(h.repository.blocked.map((one) => one.blockCode)).toEqual([
      "DURATION_INVARIANT_MISMATCH",
    ]);
    expect(h.materializer.calls).toBe(0);
    expect(h.composer.inputs).toHaveLength(0);
    expect(h.publisher.calls).toBe(0);
    expect(report.blocked).toBe(1);
  });

  it("is refused in both directions — short and long", async () => {
    for (const requested of [1, 999]) {
      const h = harness({
        repository: new FakeRepository({
          claim: {
            kind: "CLAIMED",
            claim: claimOf({ scenes: [scene(1, 5), scene(2, 5)], requestedDurationSeconds: requested }),
          },
        }),
      });
      await h.run();
      expect(h.repository.blocked.map((one) => one.blockCode)).toEqual([
        "DURATION_INVARIANT_MISMATCH",
      ]);
    }
  });

  it("checks the budget first, so a plan violating both always records one code", async () => {
    const both = claimOf({
      scenes: [
        scene(1, 5, MAX_DELIVERABLE_COMPOSITION_SOURCE_BYTES),
        scene(2, 5, MAX_DELIVERABLE_COMPOSITION_SOURCE_BYTES),
      ],
      requestedDurationSeconds: 999,
    });
    const h = harness({
      repository: new FakeRepository({ claim: { kind: "CLAIMED", claim: both } }),
    });
    await h.run();
    expect(h.repository.blocked.map((one) => one.blockCode)).toEqual([
      "SOURCE_BYTES_LIMIT_EXCEEDED",
    ]);
  });

  it("accepts an exactly-matching total", async () => {
    const h = harness({
      repository: new FakeRepository({
        claim: {
          kind: "CLAIMED",
          claim: claimOf({ scenes: [scene(1, 7), scene(2, 8)], requestedDurationSeconds: 15 }),
        },
      }),
    });
    await h.run();
    expect(h.repository.blocked).toHaveLength(0);
    expect(h.repository.finalized).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D–F. Failures from the adapters, sorted into block and retry
// ---------------------------------------------------------------------------

describe("D — a source integrity mismatch is terminal, a source read failure is not", () => {
  it("blocks with SOURCE_INTEGRITY_MISMATCH and never composes", async () => {
    const h = harness({ materializer: new FakeMaterializer({ kind: "INTEGRITY_MISMATCH" }) });
    const report = await h.run();
    expect(h.repository.blocked.map((one) => one.blockCode)).toEqual(["SOURCE_INTEGRITY_MISMATCH"]);
    expect(h.repository.deferred).toHaveLength(0);
    expect(h.composer.inputs).toHaveLength(0);
    expect(h.publisher.calls).toBe(0);
    expect(report.blocked).toBe(1);
  });

  it("defers a read failure with SOURCE_READ_RETRYABLE", async () => {
    const h = harness({ materializer: new FakeMaterializer({ kind: "RETRYABLE_FAILURE" }) });
    const report = await h.run();
    expect(h.repository.deferred.map((one) => one.retryCode)).toEqual(["SOURCE_READ_RETRYABLE"]);
    expect(h.repository.blocked).toHaveLength(0);
    expect(report.deferred).toBe(1);
    expect(report.blocked).toBe(0);
  });
});

describe("E — a composer failure is always retryable", () => {
  it("defers with COMPOSER_RETRYABLE and never blocks", async () => {
    const h = harness({ composer: new FakeComposer({ kind: "RETRYABLE_FAILURE" }) });
    const report = await h.run();
    expect(h.repository.deferred.map((one) => one.retryCode)).toEqual(["COMPOSER_RETRYABLE"]);
    expect(h.repository.blocked).toHaveLength(0);
    expect(h.publisher.calls).toBe(0);
    expect(report.deferred).toBe(1);
  });

  it("releases the temporary directory anyway", async () => {
    const h = harness({ composer: new FakeComposer({ kind: "RETRYABLE_FAILURE" }) });
    await h.run();
    expect(h.materializer.released).toBe(1);
  });
});

describe("F — publication separates a transient failure from an oversized output", () => {
  it("blocks an oversized output with OUTPUT_SIZE_LIMIT_EXCEEDED", async () => {
    const h = harness({ publisher: new FakePublisher({ kind: "OUTPUT_TOO_LARGE" }) });
    const report = await h.run();
    expect(h.repository.blocked.map((one) => one.blockCode)).toEqual(["OUTPUT_SIZE_LIMIT_EXCEEDED"]);
    expect(h.repository.deferred).toHaveLength(0);
    expect(h.repository.finalized).toHaveLength(0);
    expect(report.blocked).toBe(1);
  });

  it("defers a transient publication failure with OUTPUT_PUBLISH_RETRYABLE", async () => {
    const h = harness({ publisher: new FakePublisher({ kind: "RETRYABLE_FAILURE" }) });
    const report = await h.run();
    expect(h.repository.deferred.map((one) => one.retryCode)).toEqual(["OUTPUT_PUBLISH_RETRYABLE"]);
    expect(h.repository.blocked).toHaveLength(0);
    expect(report.deferred).toBe(1);
  });

  it("finalizes against the receipt the publisher read back, not the local file", async () => {
    const receipt = {
      kind: "PUBLISHED" as const,
      sha256: sha256Digest("c".repeat(64)),
      sizeBytes: safePositiveByteCount(9_999),
    };
    const h = harness({ publisher: new FakePublisher(receipt) });
    await h.run();
    const finalize = h.repository.finalized[0]!;
    expect(finalize.outputSha256).toBe(receipt.sha256);
    expect(finalize.outputSizeBytes).toBe(receipt.sizeBytes);
  });
});

// ---------------------------------------------------------------------------
// G–J. Claim outcomes, lease loss and batch isolation
// ---------------------------------------------------------------------------

describe("G — every non-claim outcome touches nothing", () => {
  const cases: { kind: ClaimCompositionWorkOutcome; counted: keyof DeliverableCompositionReport }[] = [
    { kind: { kind: "NOT_CLAIMABLE" }, counted: "notClaimable" },
    { kind: { kind: "ALREADY_VERIFIED" }, counted: "notClaimable" },
    { kind: { kind: "NOT_FOUND" }, counted: "notClaimable" },
    { kind: { kind: "UNSUPPORTED_TARGET" }, counted: "unsupportedTarget" },
  ];

  for (const one of cases) {
    it(`runs no adapter and writes nothing for ${one.kind.kind}`, async () => {
      const h = harness({ repository: new FakeRepository({ claim: one.kind }) });
      const report = await h.run();
      expect(h.materializer.calls).toBe(0);
      expect(h.composer.inputs).toHaveLength(0);
      expect(h.publisher.calls).toBe(0);
      expect(h.repository.blocked).toHaveLength(0);
      expect(h.repository.deferred).toHaveLength(0);
      expect(h.repository.finalized).toHaveLength(0);
      expect(report[one.counted]).toBe(1);
    });
  }

  it("counts an unsupported target apart from an ordinary refusal", async () => {
    const h = harness({
      repository: new FakeRepository({ claim: { kind: "UNSUPPORTED_TARGET" } }),
    });
    const report = await h.run();
    expect(report.unsupportedTarget).toBe(1);
    expect(report.notClaimable).toBe(0);
    expect(report.failed).toBe(0);
  });
});

describe("H — a lost lease is reported, never retried in place", () => {
  it("reports LEASE_LOST from finalize", async () => {
    const h = harness({ repository: new FakeRepository({ finalize: { kind: "LEASE_LOST" } }) });
    const report = await h.run();
    expect(report.leaseLost).toBe(1);
    expect(report.finalized).toBe(0);
  });

  it("reports LEASE_LOST from a block that lost the race", async () => {
    const h = harness({
      repository: new FakeRepository({
        claim: { kind: "CLAIMED", claim: claimOf({ requestedDurationSeconds: 99 }) },
        block: { kind: "LEASE_LOST" },
      }),
    });
    const report = await h.run();
    expect(report.leaseLost).toBe(1);
    expect(report.blocked).toBe(0);
  });

  it("treats an already-blocked replay as blocked, not as a lost lease", async () => {
    const h = harness({
      repository: new FakeRepository({
        claim: { kind: "CLAIMED", claim: claimOf({ requestedDurationSeconds: 99 }) },
        block: { kind: "ALREADY_BLOCKED" },
      }),
    });
    const report = await h.run();
    expect(report.blocked).toBe(1);
    expect(report.leaseLost).toBe(0);
  });

  it("reports an already-finalized replay apart from a fresh finalize", async () => {
    const h = harness({
      repository: new FakeRepository({ finalize: { kind: "ALREADY_FINALIZED" } }),
    });
    const report = await h.run();
    expect(report.alreadyFinalized).toBe(1);
    expect(report.finalized).toBe(0);
  });
});

describe("I — one bad candidate never poisons the batch", () => {
  it("records the failure and keeps sweeping", async () => {
    class ThrowingOnce extends FakeRepository {
      override async claimCompositionWork(): Promise<ClaimCompositionWorkOutcome> {
        this.claims += 1;
        if (this.claims === 1) throw new Error("defect");
        return { kind: "CLAIMED", claim: claimOf() };
      }
    }
    const repository = new ThrowingOnce({
      candidates: [
        { deliverableVersionId: "gdv_a", generationJobId: JOB, organizationId: ORG },
        { deliverableVersionId: "gdv_b", generationJobId: JOB, organizationId: ORG },
      ],
    });
    const h = harness({ repository });
    const report = await h.run();
    expect(report.considered).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.finalized).toBe(1);
  });
});

describe("J — the report is counts only", () => {
  it("carries no identifier, key, receipt or path", async () => {
    const h = harness();
    const report = await h.run();
    const serialized = JSON.stringify(report);
    for (const secret of [ORG, JOB, VERSION, "gdcmp_1", "clease_1", "/tmp/"]) {
      expect(`${secret}: ${serialized.includes(secret)}`).toBe(`${secret}: false`);
    }
    expect(Object.values(report).every((value) => typeof value === "number")).toBe(true);
  });

  it("claims nothing when discovery returns nothing", async () => {
    const h = harness({ repository: new FakeRepository({ candidates: [] }) });
    const report = await h.run();
    expect(report).toEqual({
      considered: 0,
      claimed: 0,
      finalized: 0,
      alreadyFinalized: 0,
      deferred: 0,
      blocked: 0,
      leaseLost: 0,
      notClaimable: 0,
      unsupportedTarget: 0,
      failed: 0,
    });
  });

  it("refuses an unusable batch limit rather than clamping it", async () => {
    const h = harness();
    const runner = new DeliverableCompositionRunner({
      repository: h.repository,
      materializer: h.materializer,
      composer: h.composer,
      publisher: h.publisher,
      clock: () => NOW,
      context: CONTEXT,
      outputPathFor: () => "/tmp/x/output.mp4",
    });
    for (const bad of [0, -1, 1.5, 26, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runner.runOnce(bad)).rejects.toThrow();
    }
    expect(h.repository.claims).toBe(0);
  });
});
