/**
 * The composition-execution runner: what it calls, in what order, and — most of
 * this suite — what it refuses to call.
 *
 * Every dependency is a recording fake, and all of them write to one shared
 * log, so the order of the master, the disclosure and the video is asserted
 * directly. The interesting assertions are negative ones: that a deterministic
 * refusal reaches the database having touched no adapter at all, that a
 * transient failure is never recorded as a terminal one, and that the
 * customer's video is only ever made from a copy of the stored master. Those
 * mistakes are invisible in a passing happy path and expensive in production.
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
  ApplyDisclosureInput,
  BlockCompositionInput,
  BlockCompositionOutcome,
  ClaimCompositionWorkOutcome,
  CleanMasterInspector,
  CleanMasterStore,
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
  FetchCleanMasterOutcome,
  FinalizeCompositionInput,
  FinalizeCompositionOutcome,
  InspectCleanMasterOutcome,
  LocalCleanMasterCopy,
  MaterializeCompositionSourcesOutcome,
  ProbeCleanMasterOutcome,
  ProbeDeliverableOutputOutcome,
  PublishCleanMasterOutcome,
  PublishDeliverableOutcome,
} from "./ports";
import { managedGenerationOutputKey, safePositiveByteCount, sha256Digest } from "../completion/output";
import { managedCleanMasterKey } from "../clean-master/key";
import type { ManagedCleanMasterKey } from "../clean-master/key";
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

const OUTPUT_KEY = managedDeliverableOutputKey({ organizationId: ORG, deliverableVersionId: VERSION });
const MASTER_KEY = managedCleanMasterKey({ organizationId: ORG, deliverableVersionId: VERSION });

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
    outputStorageKey: OUTPUT_KEY,
    disclosureMode: "THROUGHOUT",
    cleanMasterStorageKey: MASTER_KEY,
    requestedDurationSeconds: seconds,
    ...overrides,
    scenes,
  };
}

// ---------------------------------------------------------------------------
// Recording fakes, all writing to one log
// ---------------------------------------------------------------------------

/** The order every adapter was reached in, across all of them. */
type Log = string[];

/** A clock that moves on every read, so each instant the runner takes is its own. */
class TickingClock {
  #now = NOW;
  read = (): number => {
    this.#now += 1_000;
    return this.#now;
  };
}

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
  log: Log = [];

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
    this.log.push("finalize");
    this.finalized.push(input);
    return this.script.finalize ?? { kind: "FINALIZED" };
  }

  async deferComposition(input: DeferCompositionInput): Promise<DeferCompositionOutcome> {
    this.log.push(`defer ${input.retryCode}`);
    this.deferred.push(input);
    return this.script.defer ?? { kind: "DEFERRED" };
  }

  async blockComposition(input: BlockCompositionInput): Promise<BlockCompositionOutcome> {
    this.log.push(`block ${input.blockCode}`);
    this.blocked.push(input);
    return this.script.block ?? { kind: "BLOCKED" };
  }

  async findCompositionByVersionId(): Promise<DeliverableCompositionRecord | null> {
    return null;
  }
}

/** The private directory a materialization is pretending to own. */
const TEMP_DIR = "/tmp/vta-compose-fake";
const TEMP_OUTPUT = `${TEMP_DIR}/output.mp4`;

class FakeMaterializer implements DeliverableCompositionSourceMaterializer {
  calls = 0;
  released = 0;
  log: Log = [];

  constructor(private readonly outcome: MaterializeCompositionSourcesOutcome | null = null) {}

  async materialize(input: {
    readonly organizationId: string;
    readonly scenes: readonly CompositionSceneInput[];
  }): Promise<MaterializeCompositionSourcesOutcome> {
    this.calls += 1;
    this.log.push("materialize");
    if (this.outcome !== null) return this.outcome;
    return {
      kind: "MATERIALIZED",
      sources: input.scenes.map((one, index) => ({
        position: one.position,
        localPath: `${TEMP_DIR}/input-${String(index).padStart(4, "0")}`,
      })),
      outputPath: TEMP_OUTPUT,
      release: async () => {
        this.released += 1;
        this.log.push("release scenes");
      },
    };
  }
}

class FakeComposer implements DeliverableMediaComposer {
  readonly masterInputs: ComposeDeliverableInput[] = [];
  readonly disclosureInputs: ApplyDisclosureInput[] = [];
  /** The clock's instants when the master was encoded and the disclosure laid. */
  encodedAt: number | null = null;
  disclosedAt: number | null = null;
  log: Log = [];
  /** Reads the clock: each encode takes time. */
  tick: () => number = () => 0;

  constructor(
    private readonly master: ComposeDeliverableOutcome = { kind: "SUCCESS" },
    private readonly disclosure: ComposeDeliverableOutcome = { kind: "SUCCESS" },
  ) {}

  // Never called: the customer's video is made only from the Clean Master.
  async compose(): Promise<ComposeDeliverableOutcome> {
    throw new Error("the runner must never compose a video without its disclosure");
  }

  async composeCleanMaster(input: ComposeDeliverableInput): Promise<ComposeDeliverableOutcome> {
    this.log.push("encode master");
    this.masterInputs.push(input);
    this.encodedAt = this.tick();
    return this.master;
  }

  async applyDisclosure(input: ApplyDisclosureInput): Promise<ComposeDeliverableOutcome> {
    this.log.push("apply disclosure");
    this.disclosureInputs.push(input);
    this.disclosedAt = this.tick();
    return this.disclosure;
  }
}

class FakePublisher implements DeliverableOutputPublisher {
  calls = 0;
  probes = 0;
  readonly publishedPaths: string[] = [];
  readonly publishedKeys: string[] = [];
  log: Log = [];

  constructor(
    private readonly outcome: PublishDeliverableOutcome = {
      kind: "PUBLISHED",
      sha256: sha256Digest("b".repeat(64)),
      sizeBytes: safePositiveByteCount(4_096),
    },
    /** What the canonical key already holds. Absent unless a test says so. */
    private readonly existing: ProbeDeliverableOutputOutcome = { kind: "ABSENT" },
  ) {}

  async probeExistingOutput(): Promise<ProbeDeliverableOutputOutcome> {
    this.probes += 1;
    this.log.push("probe video");
    return this.existing;
  }

  async publish(input: { readonly key: string; readonly localPath: string }): Promise<PublishDeliverableOutcome> {
    this.calls += 1;
    this.log.push("publish video");
    this.publishedPaths.push(input.localPath);
    this.publishedKeys.push(input.key);
    return this.outcome;
  }
}

/** The private directory the store's copy is pretending to live in. */
const COPY_DIR = "/tmp/vta-clean-master-fake";
const MASTER_SHA = sha256Digest("d".repeat(64));
const MASTER_BYTES = safePositiveByteCount(8_192);

interface StoreScript {
  readonly probe?: ProbeCleanMasterOutcome;
  readonly fetch?: "ABSENT" | "COPIED" | "TOO_LARGE" | "RETRYABLE_FAILURE";
  readonly publish?: "COPIED" | "TOO_LARGE" | "RETRYABLE_FAILURE";
  /** The receipt of the master a copy holds: another attempt's, if a test says so. */
  readonly stored?: { readonly sha256: string; readonly sizeBytes: number };
}

class FakeCleanMasterStore implements CleanMasterStore {
  probes = 0;
  fetches = 0;
  readonly publishedPaths: string[] = [];
  readonly keys: ManagedCleanMasterKey[] = [];
  released = 0;
  log: Log = [];

  constructor(private readonly script: StoreScript = {}) {}

  #copy(): LocalCleanMasterCopy {
    return {
      cleanMasterPath: `${COPY_DIR}/clean-master`,
      sha256: sha256Digest(this.script.stored?.sha256 ?? MASTER_SHA),
      sizeBytes: safePositiveByteCount(this.script.stored?.sizeBytes ?? MASTER_BYTES),
      outputPath: `${COPY_DIR}/output`,
      release: async () => {
        this.released += 1;
        this.log.push("release copy");
      },
    };
  }

  async probe(input: { readonly key: ManagedCleanMasterKey }): Promise<ProbeCleanMasterOutcome> {
    this.probes += 1;
    this.keys.push(input.key);
    this.log.push("probe master");
    return this.script.probe ?? { kind: "STORED", sha256: MASTER_SHA, sizeBytes: MASTER_BYTES };
  }

  async fetch(input: { readonly key: ManagedCleanMasterKey }): Promise<FetchCleanMasterOutcome> {
    this.fetches += 1;
    this.keys.push(input.key);
    this.log.push("fetch master");
    const kind = this.script.fetch ?? "ABSENT";
    return kind === "COPIED" ? { kind, copy: this.#copy() } : { kind };
  }

  async publish(input: {
    readonly key: ManagedCleanMasterKey;
    readonly localPath: string;
  }): Promise<PublishCleanMasterOutcome> {
    this.publishedPaths.push(input.localPath);
    this.keys.push(input.key);
    this.log.push("store master");
    const kind = this.script.publish ?? "COPIED";
    return kind === "COPIED" ? { kind, copy: this.#copy() } : { kind };
  }
}

const PROFILE_RASTER: InspectCleanMasterOutcome = {
  kind: "RASTER",
  raster: { widthPx: 1920, heightPx: 1080, frameRateNumerator: 30, frameRateDenominator: 1 },
};

class FakeInspector implements CleanMasterInspector {
  readonly paths: string[] = [];
  log: Log = [];

  constructor(private readonly outcome: InspectCleanMasterOutcome = PROFILE_RASTER) {}

  async inspect(input: { readonly localPath: string }): Promise<InspectCleanMasterOutcome> {
    this.paths.push(input.localPath);
    this.log.push("inspect master");
    return this.outcome;
  }
}

interface Harness {
  readonly repository: FakeRepository;
  readonly materializer: FakeMaterializer;
  readonly composer: FakeComposer;
  readonly publisher: FakePublisher;
  readonly store: FakeCleanMasterStore;
  readonly inspector: FakeInspector;
  readonly log: Log;
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
  store?: FakeCleanMasterStore;
  inspector?: FakeInspector;
} = {}): Harness {
  const log: Log = [];
  const clock = new TickingClock();
  const repository = parts.repository ?? new FakeRepository();
  const materializer = parts.materializer ?? new FakeMaterializer();
  const composer = parts.composer ?? new FakeComposer();
  const publisher = parts.publisher ?? new FakePublisher();
  const store = parts.store ?? new FakeCleanMasterStore();
  const inspector = parts.inspector ?? new FakeInspector();
  for (const fake of [repository, materializer, composer, publisher, store, inspector]) fake.log = log;
  composer.tick = () => clock.read();
  const runner = new DeliverableCompositionRunner({
    repository,
    materializer,
    composer,
    publisher,
    cleanMasterStore: store,
    cleanMasterInspector: inspector,
    clock: clock.read,
    context: CONTEXT,
  });
  return {
    repository,
    materializer,
    composer,
    publisher,
    store,
    inspector,
    log,
    run: () => runner.runOnce(5),
  };
}

/** True when nothing beyond the claim reached an adapter or the database. */
function untouched(h: Harness): boolean {
  return (
    h.log.length === 0 &&
    h.materializer.calls === 0 &&
    h.store.keys.length === 0 &&
    h.inspector.paths.length === 0 &&
    h.publisher.calls === 0 &&
    h.publisher.probes === 0
  );
}

// ---------------------------------------------------------------------------
// A. The happy path: the master, then the video from the stored master
// ---------------------------------------------------------------------------

describe("A — a deliverable with nothing stored is composed master first, then finalized", () => {
  it("encodes and stores the master, then makes the video from its copy, in this order", async () => {
    const h = harness();
    const report = await h.run();
    expect(h.log).toEqual([
      "probe video",
      "fetch master",
      "materialize",
      "encode master",
      "store master",
      "release scenes",
      "inspect master",
      "apply disclosure",
      "publish video",
      "finalize",
      "release copy",
    ]);
    expect(report.finalized).toBe(1);
    expect(report.blocked).toBe(0);
    expect(report.deferred).toBe(0);
  });

  it("hands the master encode one clip per scene, in plan order, at the frozen durations", async () => {
    // Distinct durations, so a clip paired with another scene's would show.
    const claim = claimOf({ scenes: [scene(1, 4), scene(2, 6), scene(3, 5)] });
    const h = harness({ repository: new FakeRepository({ claim: { kind: "CLAIMED", claim } }) });
    await h.run();
    const input = h.composer.masterInputs[0]!;
    expect(input.clips.map((clip) => clip.durationSeconds)).toEqual([4, 6, 5]);
    expect(input.clips.map((clip) => clip.localPath)).toEqual([
      `${TEMP_DIR}/input-0000`,
      `${TEMP_DIR}/input-0001`,
      `${TEMP_DIR}/input-0002`,
    ]);
    expect(input.profile).toEqual(PROFILE);
  });

  it("stores the master from where it was encoded, at the claim's master key", async () => {
    const h = harness();
    await h.run();
    expect(h.composer.masterInputs[0]!.outputPath).toBe(TEMP_OUTPUT);
    expect(h.store.publishedPaths).toEqual([TEMP_OUTPUT]);
    expect(h.store.keys).toEqual([MASTER_KEY, MASTER_KEY]);
  });

  it("lays the version's disclosure over the stored master's copy, never the encoded file", async () => {
    const h = harness();
    await h.run();
    expect(h.inspector.paths).toEqual([`${COPY_DIR}/clean-master`]);
    expect(h.composer.disclosureInputs).toEqual([
      {
        cleanMasterPath: `${COPY_DIR}/clean-master`,
        profile: PROFILE,
        disclosureMode: "THROUGHOUT",
        outputPath: `${COPY_DIR}/output`,
      },
    ]);
  });

  it("publishes the disclosed video at the claim's output key, from the copy's directory", async () => {
    const h = harness();
    await h.run();
    expect(h.publisher.publishedKeys).toEqual([OUTPUT_KEY]);
    expect(h.publisher.publishedPaths).toEqual([`${COPY_DIR}/output`]);
  });

  it("finalizes with the video's receipt and the stored master's, proven before the disclosure", async () => {
    const h = harness();
    await h.run();
    const finalize = h.repository.finalized[0]!;
    expect(finalize.outputSha256).toBe(sha256Digest("b".repeat(64)));
    expect(finalize.outputSizeBytes).toBe(4_096);
    const master = finalize.cleanMaster!;
    expect({ sha256: master.sha256, sizeBytes: master.sizeBytes }).toEqual({
      sha256: MASTER_SHA,
      sizeBytes: MASTER_BYTES,
    });
    // The master's instant is the one clock read between its encode and the
    // disclosure: when the store answered. The finalize's is the video's.
    expect(master.verifiedAt).toBe(h.composer.encodedAt! + 1_000);
    expect(h.composer.disclosedAt).toBe(master.verifiedAt + 1_000);
    expect(finalize.verifiedAt).toBe(h.composer.disclosedAt! + 1_000);
  });

  it("releases each directory once on the success path", async () => {
    const h = harness();
    await h.run();
    expect(h.materializer.released).toBe(1);
    expect(h.store.released).toBe(1);
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

  it("blocks with SOURCE_BYTES_LIMIT_EXCEEDED and touches nothing else", async () => {
    const h = harness({
      repository: new FakeRepository({ claim: { kind: "CLAIMED", claim: oversized } }),
    });
    const report = await h.run();
    expect(h.log).toEqual(["block SOURCE_BYTES_LIMIT_EXCEEDED"]);
    expect(report.blocked).toBe(1);
    expect(report.deferred).toBe(0);
  });
});

describe("C — a duration-invariant mismatch is blocked, never redistributed", () => {
  it("blocks with DURATION_INVARIANT_MISMATCH, short or long, and touches nothing else", async () => {
    for (const requested of [1, 30, 999]) {
      const h = harness({
        repository: new FakeRepository({
          claim: {
            kind: "CLAIMED",
            claim: claimOf({ scenes: [scene(1, 5), scene(2, 5)], requestedDurationSeconds: requested }),
          },
        }),
      });
      const report = await h.run();
      expect(h.log).toEqual(["block DURATION_INVARIANT_MISMATCH"]);
      expect(report.blocked).toBe(1);
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
// D–J. Each adapter's failures, sorted into block and retry
// ---------------------------------------------------------------------------

describe("D — the scenes: an integrity mismatch is terminal, a read failure is not", () => {
  it("blocks with SOURCE_INTEGRITY_MISMATCH and encodes nothing", async () => {
    const h = harness({ materializer: new FakeMaterializer({ kind: "INTEGRITY_MISMATCH" }) });
    const report = await h.run();
    expect(h.log).toEqual(["probe video", "fetch master", "materialize", "block SOURCE_INTEGRITY_MISMATCH"]);
    expect(report.blocked).toBe(1);
  });

  it("defers a read failure with SOURCE_READ_RETRYABLE", async () => {
    const h = harness({ materializer: new FakeMaterializer({ kind: "RETRYABLE_FAILURE" }) });
    const report = await h.run();
    expect(h.log).toEqual(["probe video", "fetch master", "materialize", "defer SOURCE_READ_RETRYABLE"]);
    expect(report.deferred).toBe(1);
    expect(report.blocked).toBe(0);
  });
});

describe("E — the master's encode: a failure is always retryable", () => {
  it("defers with COMPOSER_RETRYABLE, stores nothing and releases the scenes", async () => {
    const h = harness({ composer: new FakeComposer({ kind: "RETRYABLE_FAILURE" }) });
    const report = await h.run();
    expect(h.log).toEqual([
      "probe video",
      "fetch master",
      "materialize",
      "encode master",
      "defer COMPOSER_RETRYABLE",
      "release scenes",
    ]);
    expect(report.deferred).toBe(1);
  });
});

describe("F — storing the master: oversized blocks, transient defers, first-wins is followed", () => {
  it("blocks an oversized master with CLEAN_MASTER_SIZE_LIMIT_EXCEEDED, laying no disclosure", async () => {
    const h = harness({ store: new FakeCleanMasterStore({ publish: "TOO_LARGE" }) });
    const report = await h.run();
    expect(h.log).toEqual([
      "probe video",
      "fetch master",
      "materialize",
      "encode master",
      "store master",
      "block CLEAN_MASTER_SIZE_LIMIT_EXCEEDED",
      "release scenes",
    ]);
    expect(report.blocked).toBe(1);
  });

  it("defers a failed store with OUTPUT_PUBLISH_RETRYABLE", async () => {
    const h = harness({ store: new FakeCleanMasterStore({ publish: "RETRYABLE_FAILURE" }) });
    const report = await h.run();
    expect(h.repository.deferred.map((one) => one.retryCode)).toEqual(["OUTPUT_PUBLISH_RETRYABLE"]);
    expect(h.composer.disclosureInputs).toHaveLength(0);
    expect(h.materializer.released).toBe(1);
    expect(report.deferred).toBe(1);
  });

  it("makes the video from another attempt's stored master, and records that master", async () => {
    const other = { sha256: "e".repeat(64), sizeBytes: 7_777 };
    const h = harness({ store: new FakeCleanMasterStore({ stored: other }) });
    await h.run();
    const master = h.repository.finalized[0]!.cleanMaster!;
    expect({ sha256: master.sha256, sizeBytes: master.sizeBytes }).toEqual(other);
    expect(h.composer.disclosureInputs[0]!.cleanMasterPath).toBe(`${COPY_DIR}/clean-master`);
  });
});

describe("G — a master already stored is reused, never encoded again", () => {
  it("fetches it and makes the video from its copy, fetching no scene", async () => {
    const h = harness({ store: new FakeCleanMasterStore({ fetch: "COPIED" }) });
    const report = await h.run();
    expect(h.log).toEqual([
      "probe video",
      "fetch master",
      "inspect master",
      "apply disclosure",
      "publish video",
      "finalize",
      "release copy",
    ]);
    const master = h.repository.finalized[0]!.cleanMaster!;
    expect({ sha256: master.sha256, sizeBytes: master.sizeBytes }).toEqual({
      sha256: MASTER_SHA,
      sizeBytes: MASTER_BYTES,
    });
    // Read when the fetch answered: after the pass's and the claim's reads.
    expect(master.verifiedAt).toBe(NOW + 3_000);
    expect(h.composer.disclosedAt).toBe(master.verifiedAt + 1_000);
    expect(report.finalized).toBe(1);
  });

  it("blocks a stored oversized master with CLEAN_MASTER_SIZE_LIMIT_EXCEEDED, fetching no scene", async () => {
    const h = harness({ store: new FakeCleanMasterStore({ fetch: "TOO_LARGE" }) });
    await h.run();
    expect(h.log).toEqual(["probe video", "fetch master", "block CLEAN_MASTER_SIZE_LIMIT_EXCEEDED"]);
  });

  it("defers an unreadable master key rather than encoding one that may exist", async () => {
    const h = harness({ store: new FakeCleanMasterStore({ fetch: "RETRYABLE_FAILURE" }) });
    await h.run();
    expect(h.log).toEqual(["probe video", "fetch master", "defer OUTPUT_PUBLISH_RETRYABLE"]);
  });
});

describe("H — the master's copy is checked before the disclosure is laid over it", () => {
  const AFTER_STORE = ["probe video", "fetch master", "materialize", "encode master", "store master", "release scenes", "inspect master"];

  it("defers with COMPOSER_RETRYABLE when the inspector cannot run", async () => {
    const h = harness({ inspector: new FakeInspector({ kind: "RETRYABLE_FAILURE" }) });
    await h.run();
    expect(h.log).toEqual([...AFTER_STORE, "defer COMPOSER_RETRYABLE", "release copy"]);
  });

  it("blocks an unusable master with CLEAN_MASTER_UNUSABLE", async () => {
    const h = harness({ inspector: new FakeInspector({ kind: "UNUSABLE" }) });
    const report = await h.run();
    expect(h.log).toEqual([...AFTER_STORE, "block CLEAN_MASTER_UNUSABLE", "release copy"]);
    expect(report.blocked).toBe(1);
  });

  it("blocks a master of another size or frame rate with CLEAN_MASTER_UNUSABLE", async () => {
    for (const raster of [
      { widthPx: 1280, heightPx: 720, frameRateNumerator: 30, frameRateDenominator: 1 },
      { widthPx: 1080, heightPx: 1920, frameRateNumerator: 30, frameRateDenominator: 1 },
      { widthPx: 1920, heightPx: 1080, frameRateNumerator: 25, frameRateDenominator: 1 },
      { widthPx: 1920, heightPx: 1080, frameRateNumerator: 30000, frameRateDenominator: 1001 },
    ]) {
      const h = harness({ inspector: new FakeInspector({ kind: "RASTER", raster }) });
      await h.run();
      expect(h.repository.blocked.map((one) => one.blockCode)).toEqual(["CLEAN_MASTER_UNUSABLE"]);
      expect(h.composer.disclosureInputs).toHaveLength(0);
    }
  });

  it("compares with the claim's own profile, whatever its size", async () => {
    const resolved = resolveCompositionProfile({
      targetAspectRatio: "9:16",
      targetOutputResolution: "720p",
    });
    if (resolved.kind !== "RESOLVED") throw new Error("fixture profile must resolve");
    const claim = claimOf({ profile: resolved.profile });
    const portrait = { widthPx: 720, heightPx: 1280, frameRateNumerator: 30, frameRateDenominator: 1 };
    const fits = harness({
      repository: new FakeRepository({ claim: { kind: "CLAIMED", claim } }),
      inspector: new FakeInspector({ kind: "RASTER", raster: portrait }),
    });
    await fits.run();
    expect(fits.repository.finalized).toHaveLength(1);
    expect(fits.composer.disclosureInputs[0]!.profile).toEqual(resolved.profile);
    // The fixture's 1080p landscape master is refused for this claim.
    const other = harness({ repository: new FakeRepository({ claim: { kind: "CLAIMED", claim } }) });
    await other.run();
    expect(other.repository.blocked.map((one) => one.blockCode)).toEqual(["CLEAN_MASTER_UNUSABLE"]);
  });

  it("accepts the profile's raster written as an unreduced fraction", async () => {
    const h = harness({
      inspector: new FakeInspector({
        kind: "RASTER",
        raster: { widthPx: 1920, heightPx: 1080, frameRateNumerator: 60, frameRateDenominator: 2 },
      }),
    });
    await h.run();
    expect(h.repository.finalized).toHaveLength(1);
  });
});

describe("I — laying the disclosure: a failure is always retryable", () => {
  it("defers with COMPOSER_RETRYABLE and publishes no video", async () => {
    const h = harness({ composer: new FakeComposer({ kind: "SUCCESS" }, { kind: "RETRYABLE_FAILURE" }) });
    const report = await h.run();
    expect(h.log.slice(-3)).toEqual(["apply disclosure", "defer COMPOSER_RETRYABLE", "release copy"]);
    expect(h.publisher.calls).toBe(0);
    expect(report.deferred).toBe(1);
  });
});

describe("J — publishing the video separates a transient failure from an oversized output", () => {
  it("blocks an oversized video with OUTPUT_SIZE_LIMIT_EXCEEDED", async () => {
    const h = harness({ publisher: new FakePublisher({ kind: "OUTPUT_TOO_LARGE" }) });
    const report = await h.run();
    expect(h.log.slice(-3)).toEqual(["publish video", "block OUTPUT_SIZE_LIMIT_EXCEEDED", "release copy"]);
    expect(report.blocked).toBe(1);
  });

  it("defers a transient publication failure with OUTPUT_PUBLISH_RETRYABLE", async () => {
    const h = harness({ publisher: new FakePublisher({ kind: "RETRYABLE_FAILURE" }) });
    const report = await h.run();
    expect(h.log.slice(-3)).toEqual(["publish video", "defer OUTPUT_PUBLISH_RETRYABLE", "release copy"]);
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
// K–M. Claim outcomes, lease loss and batch isolation
// ---------------------------------------------------------------------------

describe("K — every non-claim outcome touches nothing", () => {
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
      expect(untouched(h)).toBe(true);
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

describe("L — a lost lease is reported, never retried in place", () => {
  it("reports LEASE_LOST from finalize, and still releases the copy", async () => {
    const h = harness({ repository: new FakeRepository({ finalize: { kind: "LEASE_LOST" } }) });
    const report = await h.run();
    expect(report.leaseLost).toBe(1);
    expect(report.finalized).toBe(0);
    expect(h.store.released).toBe(1);
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

  it("reports LEASE_LOST from a defer that lost the race", async () => {
    const h = harness({
      store: new FakeCleanMasterStore({ fetch: "RETRYABLE_FAILURE" }),
      repository: new FakeRepository({ defer: { kind: "LEASE_LOST" } }),
    });
    const report = await h.run();
    expect(report.leaseLost).toBe(1);
    expect(report.deferred).toBe(0);
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

describe("M — one bad candidate never poisons the batch", () => {
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

// ---------------------------------------------------------------------------
// N. Paths are the adapters', and both directories go on every exit
// ---------------------------------------------------------------------------

describe("N — files go exactly where their owners put them, and never outlive the attempt", () => {
  it("encodes the master wherever the materializer says, with no rule of its own", async () => {
    // A different random directory each run is exactly the production case; the
    // runner must not hold any opinion about what the path looks like.
    const elsewhere = "/tmp/vta-compose-9f2a1c/output.mp4";
    const h = harness({
      materializer: new FakeMaterializer({
        kind: "MATERIALIZED",
        sources: [{ position: 1, localPath: "/tmp/vta-compose-9f2a1c/input-0000" }],
        outputPath: elsewhere,
        release: async () => undefined,
      }),
    });
    await h.run();
    expect(h.composer.masterInputs[0]!.outputPath).toBe(elsewhere);
    expect(h.store.publishedPaths).toEqual([elsewhere]);
  });

  it("derives no path from any identifier the claim carries", async () => {
    const h = harness();
    await h.run();
    const used = [
      h.composer.masterInputs[0]!.outputPath,
      h.composer.disclosureInputs[0]!.cleanMasterPath,
      h.composer.disclosureInputs[0]!.outputPath,
      ...h.publisher.publishedPaths,
    ];
    for (const path of used) {
      for (const identity of [ORG, JOB, VERSION, "gdcmp_1", "clease_1", "deliverables", "internal"]) {
        expect(`${path} ${identity}: ${path.includes(identity)}`).toBe(`${path} ${identity}: false`);
      }
    }
  });

  it("releases the scenes and the copy once each, on every exit path", async () => {
    const cases: { name: string; h: Harness; scenes: number; copy: number }[] = [
      { name: "finalize", h: harness(), scenes: 1, copy: 1 },
      {
        name: "master encode failure",
        h: harness({ composer: new FakeComposer({ kind: "RETRYABLE_FAILURE" }) }),
        scenes: 1,
        copy: 0,
      },
      {
        name: "oversized master",
        h: harness({ store: new FakeCleanMasterStore({ publish: "TOO_LARGE" }) }),
        scenes: 1,
        copy: 0,
      },
      { name: "unusable master", h: harness({ inspector: new FakeInspector({ kind: "UNUSABLE" }) }), scenes: 1, copy: 1 },
      {
        name: "disclosure failure",
        h: harness({ composer: new FakeComposer({ kind: "SUCCESS" }, { kind: "RETRYABLE_FAILURE" }) }),
        scenes: 1,
        copy: 1,
      },
      {
        name: "publish failure",
        h: harness({ publisher: new FakePublisher({ kind: "RETRYABLE_FAILURE" }) }),
        scenes: 1,
        copy: 1,
      },
      {
        name: "stored master reused",
        h: harness({ store: new FakeCleanMasterStore({ fetch: "COPIED" }) }),
        scenes: 0,
        copy: 1,
      },
      {
        name: "lost lease at finalize",
        h: harness({ repository: new FakeRepository({ finalize: { kind: "LEASE_LOST" } }) }),
        scenes: 1,
        copy: 1,
      },
    ];
    for (const one of cases) {
      await one.h.run();
      expect(`${one.name}: ${one.h.materializer.released} ${one.h.store.released}`).toBe(
        `${one.name}: ${one.scenes} ${one.copy}`,
      );
    }
  });

  it("releases both even when an adapter throws, and counts the attempt failed", async () => {
    class ThrowingPublisher extends FakePublisher {
      override async publish(): Promise<PublishDeliverableOutcome> {
        throw new Error("adapter defect");
      }
    }
    class ThrowingInspector extends FakeInspector {
      override async inspect(): Promise<InspectCleanMasterOutcome> {
        throw new Error("inspector defect");
      }
    }
    // A missing disclosure image, for one, is the composer's CONFIGURATION_ERROR.
    class ThrowingOverlay extends FakeComposer {
      override async applyDisclosure(): Promise<ComposeDeliverableOutcome> {
        throw new Error("disclosure image missing");
      }
    }
    for (const h of [
      harness({ publisher: new ThrowingPublisher() }),
      harness({ inspector: new ThrowingInspector() }),
      harness({ composer: new ThrowingOverlay() }),
    ]) {
      const report = await h.run();
      expect(report.failed).toBe(1);
      expect(h.materializer.released).toBe(1);
      expect(h.store.released).toBe(1);
    }
  });

  it("releases the scenes when the master's encode throws, holding no copy", async () => {
    class ThrowingEncoder extends FakeComposer {
      override async composeCleanMaster(): Promise<ComposeDeliverableOutcome> {
        throw new Error("encoder defect");
      }
    }
    const h = harness({ composer: new ThrowingEncoder() });
    const report = await h.run();
    expect(report.failed).toBe(1);
    expect(h.materializer.released).toBe(1);
    expect(h.store.publishedPaths).toHaveLength(0);
  });

  it("releases the scenes when the master's store throws", async () => {
    class ThrowingStore extends FakeCleanMasterStore {
      override async publish(): Promise<PublishCleanMasterOutcome> {
        throw new Error("store defect");
      }
    }
    const h = harness({ store: new ThrowingStore() });
    const report = await h.run();
    expect(report.failed).toBe(1);
    expect(h.materializer.released).toBe(1);
  });

  it("keeps the attempt's answer when a release fails, however it fails", async () => {
    const rejects = (): Promise<void> => Promise.reject(new Error("rmdir failed"));
    const throws = (): Promise<void> => {
      throw new Error("rmdir failed before returning a promise");
    };
    class LeakyMaterializer extends FakeMaterializer {
      constructor(private readonly failing: () => Promise<void>) {
        super();
      }
      override async materialize(
        input: Parameters<FakeMaterializer["materialize"]>[0],
      ): Promise<MaterializeCompositionSourcesOutcome> {
        const outcome = await super.materialize(input);
        return outcome.kind === "MATERIALIZED" ? { ...outcome, release: this.failing } : outcome;
      }
    }
    class LeakyStore extends FakeCleanMasterStore {
      constructor(private readonly failing: () => Promise<void>) {
        super();
      }
      override async publish(
        input: Parameters<FakeCleanMasterStore["publish"]>[0],
      ): Promise<PublishCleanMasterOutcome> {
        const outcome = await super.publish(input);
        return outcome.kind === "COPIED"
          ? { ...outcome, copy: { ...outcome.copy, release: this.failing } }
          : outcome;
      }
    }
    for (const [scenes, copy] of [
      [rejects, throws],
      [throws, rejects],
    ] as const) {
      const h = harness({ materializer: new LeakyMaterializer(scenes), store: new LeakyStore(copy) });
      const report = await h.run();
      expect(report.finalized).toBe(1);
      expect(report.failed).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// O. A stored video is finalized with its master, never encoded again
// ---------------------------------------------------------------------------

describe("O — a video already stored is finalized against both stored receipts", () => {
  const RECEIPT = {
    kind: "PUBLISHED" as const,
    sha256: sha256Digest("7".repeat(64)),
    sizeBytes: safePositiveByteCount(123_456),
  };

  function existing(outcome: ProbeDeliverableOutputOutcome, store?: FakeCleanMasterStore) {
    return harness({ publisher: new FakePublisher(undefined, outcome), ...(store ? { store } : {}) });
  }

  it("probes the video's key on every claim, before anything else", async () => {
    const h = harness();
    await h.run();
    expect(h.log[0]).toBe("probe video");
  });

  it("reads the master's receipt and finalizes with both, encoding nothing", async () => {
    const h = existing(RECEIPT);
    const report = await h.run();
    expect(h.log).toEqual(["probe video", "probe master", "finalize"]);
    expect(h.store.keys).toEqual([MASTER_KEY]);
    const finalize = h.repository.finalized[0]!;
    expect(finalize.outputSha256).toBe(RECEIPT.sha256);
    expect(finalize.outputSizeBytes).toBe(RECEIPT.sizeBytes);
    const master = finalize.cleanMaster!;
    expect({ sha256: master.sha256, sizeBytes: master.sizeBytes }).toEqual({
      sha256: MASTER_SHA,
      sizeBytes: MASTER_BYTES,
    });
    // Read when the probe answered; the finalize reads the clock next.
    expect(master.verifiedAt).toBe(NOW + 3_000);
    expect(finalize.verifiedAt).toBe(NOW + 4_000);
    expect(report.finalized).toBe(1);
  });

  it("blocks a stored oversized master with CLEAN_MASTER_SIZE_LIMIT_EXCEEDED", async () => {
    const h = existing(RECEIPT, new FakeCleanMasterStore({ probe: { kind: "TOO_LARGE" } }));
    await h.run();
    expect(h.log).toEqual(["probe video", "probe master", "block CLEAN_MASTER_SIZE_LIMIT_EXCEEDED"]);
  });

  it("defers an unreadable master key with OUTPUT_PUBLISH_RETRYABLE", async () => {
    const h = existing(RECEIPT, new FakeCleanMasterStore({ probe: { kind: "RETRYABLE_FAILURE" } }));
    await h.run();
    expect(h.log).toEqual(["probe video", "probe master", "defer OUTPUT_PUBLISH_RETRYABLE"]);
  });

  it("treats a stored video without its master as a defect, writing nothing", async () => {
    const h = existing(RECEIPT, new FakeCleanMasterStore({ probe: { kind: "ABSENT" } }));
    const report = await h.run();
    expect(h.log).toEqual(["probe video", "probe master"]);
    expect(report.failed).toBe(1);
    expect(report.claimed).toBe(0);
  });

  it("reports a replayed finalize as already-finalized, and a lost lease as one", async () => {
    const already = harness({
      repository: new FakeRepository({ finalize: { kind: "ALREADY_FINALIZED" } }),
      publisher: new FakePublisher(undefined, RECEIPT),
    });
    expect((await already.run()).alreadyFinalized).toBe(1);
    const lost = harness({
      repository: new FakeRepository({ finalize: { kind: "LEASE_LOST" } }),
      publisher: new FakePublisher(undefined, RECEIPT),
    });
    expect((await lost.run()).leaseLost).toBe(1);
    expect(lost.composer.masterInputs).toHaveLength(0);
  });

  it("defers an unreadable video key rather than treating it as absent", async () => {
    // An unreadable object is not permission to spend a download and an encode.
    const h = existing({ kind: "RETRYABLE_FAILURE" });
    const report = await h.run();
    expect(h.log).toEqual(["probe video", "defer OUTPUT_PUBLISH_RETRYABLE"]);
    expect(report.deferred).toBe(1);
  });

  it("blocks an existing oversized video without trying to replace it", async () => {
    const h = existing({ kind: "OUTPUT_TOO_LARGE" });
    const report = await h.run();
    expect(h.log).toEqual(["probe video", "block OUTPUT_SIZE_LIMIT_EXCEEDED"]);
    expect(report.blocked).toBe(1);
  });

  it("probes after the deterministic refusals, so a bad plan costs no read", async () => {
    const h = harness({
      repository: new FakeRepository({
        claim: {
          kind: "CLAIMED",
          claim: claimOf({ scenes: [scene(1, 5), scene(2, 5)], requestedDurationSeconds: 30 }),
        },
      }),
      publisher: new FakePublisher(undefined, RECEIPT),
    });
    await h.run();
    expect(h.log).toEqual(["block DURATION_INVARIANT_MISMATCH"]);
  });

  it("lets a reclaimed worker converge after a stale worker published", async () => {
    // Worker one stores the master and the video, then loses the lease; worker
    // two finds both rather than encoding either again.
    const stale = harness({
      repository: new FakeRepository({ finalize: { kind: "LEASE_LOST" } }),
    });
    expect((await stale.run()).leaseLost).toBe(1);
    expect(stale.publisher.calls).toBe(1);

    const reclaimed = existing(RECEIPT);
    expect((await reclaimed.run()).finalized).toBe(1);
    expect(reclaimed.materializer.calls).toBe(0);
    expect(reclaimed.composer.masterInputs).toHaveLength(0);
    expect(reclaimed.composer.disclosureInputs).toHaveLength(0);
  });
});

describe("P — the report is counts only", () => {
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
      cleanMasterStore: h.store,
      cleanMasterInspector: h.inspector,
      clock: () => NOW,
      context: CONTEXT,
    });
    for (const bad of [0, -1, 1.5, 26, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runner.runOnce(bad)).rejects.toThrow();
    }
    expect(h.repository.claims).toBe(0);
  });
});
