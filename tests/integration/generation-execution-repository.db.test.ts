import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPrismaSceneGenerationExecutionRepository,
  createPrismaSceneGenerationRepository,
} from "@app/database";
import {
  PREFLIGHT_REFUSAL_REASONS,
  SCENE_GENERATION_STATES,
  type MediaAssetStatus,
  type PreparedSourceIdentity,
  type SceneGenerationState,
  preflightFailureStateFor,
} from "@app/domain";

/**
 * The system-scoped execution boundary against live PostgreSQL.
 *
 * This is the *only* behavioural suite for that boundary, by decision. There is
 * no in-memory double: nothing in production consumes the port yet, and every
 * property worth asserting about it — ordering, state filtering, tenant
 * resolution through the `VideoProject` join, and above all whether two
 * concurrent callers can both win a claim — is decided by the database rather
 * than by any interface it satisfies. A single-threaded double could only ever
 * show that a second *sequential* call is refused, which is not the question
 * that decides whether a provider gets paid twice.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG_A = "org_itest_ex_a";
const ORG_B = "org_itest_ex_b";
const PROP_A = "prp_itest_ex_a";
const PROP_B = "prp_itest_ex_b";
const PROJECT_A = "vpr_itest_ex_a";
const PROJECT_B = "vpr_itest_ex_b";
/** Every seeded generation names this asset; the claim resolves it from the row. */
const ASSET = "ast_itest_ex";
const ASSET_B = "ast_itest_ex_b";
const KEY = `org/${ORG_A}/a/${ASSET}/normalized.jpg`;
/** Canonical digests: 64 lowercase hex, the shape `sha256Hex` emits. */
const DIGEST = "a".repeat(64);
const OTHER_DIGEST = `b${"a".repeat(63)}`;

/** What preflight would have handed the claim for a healthy seeded asset. */
const IDENTITY: PreparedSourceIdentity = {
  storageKey: KEY,
  mimeType: "image/jpeg",
  sha256: DIGEST,
};

const prisma = new PrismaClient();
const execution = createPrismaSceneGenerationExecutionRepository(prisma);
const tenantFacing = createPrismaSceneGenerationRepository(prisma);

/**
 * Insert a row directly: admission is not this suite's subject.
 *
 * `updatedAt` is settable because Prisma honours an explicit value even on an
 * `@updatedAt` field, which lets a test pin a known-old timestamp and then
 * prove the claim moved it — without a sleep, and without depending on how
 * fast the seed and the claim happen to land.
 */
function seedGeneration(
  id: string,
  state: SceneGenerationState,
  videoProjectId: string,
  createdAt?: Date,
  updatedAt?: Date,
  /**
   * Execution-history columns, for preservation tests.
   *
   * The first attempt at a generation has all of these null, so a preservation
   * test seeded from the default path would pass even if the adapter cleared
   * them — null compares equal to null. A future explicit requeue policy can
   * bring a row back to `QUEUED` carrying real history, and that is the row
   * whose fields must survive.
   */
  history?: {
    providerPredictionId?: string;
    submittedAt?: Date;
    lastPolledAt?: Date;
    outputStorageKey?: string;
    normalizedErrorCode?: string;
    normalizedErrorMessage?: string;
  },
) {
  return prisma.sceneGeneration.create({
    data: {
      id,
      ...history,
      videoProjectId,
      sourceStoryboardSceneId: "scn_itest_ex",
      assetId: "ast_itest_ex",
      sourceAnalysisRevision: 1,
      requestHash: `sha256:${id}`,
      providerName: "fake",
      providerModelId: "fake/image-to-video",
      requestCompiledPrompt: '{"preservation":[],"sceneFacts":{},"userCustomization":null}',
      requestDurationSeconds: 5,
      requestCameraMotion: "SLOW_PAN_LEFT",
      requestAspectRatio: "16:9",
      requestResolution: "1080p",
      requestRenderedPrompt: `frozen:${id}`,
      state,
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    },
  });
}

async function seedTenant(organizationId: string, propertyId: string, projectId: string) {
  await prisma.organization.create({
    data: { id: organizationId, name: organizationId, slug: organizationId },
  });
  await prisma.property.create({
    data: {
      id: propertyId,
      organizationId,
      name: "Fixture",
      propertyType: "APARTMENT",
      createdBy: "usr_itest_ex",
    },
  });
  await prisma.videoProject.create({
    data: {
      id: projectId,
      organizationId,
      propertyId,
      name: "Walkthrough",
      durationSeconds: 12,
      aspectRatio: "16:9",
      targetOutputResolution: "1080p",
      createdBy: "usr_itest_ex",
    },
  });
}

/**
 * The source asset every seeded generation points at.
 *
 * Phase 4C-3A-2b is the first milestone where this row has to exist:
 * `SceneGeneration.assetId` carries no foreign key, so earlier suites could name
 * an asset that was never created. The claim now locks and classifies it, so an
 * absent row is `ASSET_NOT_FOUND` rather than an incidental detail.
 */
function seedAsset(
  id: string,
  organizationId: string,
  propertyId: string,
  overrides: {
    status?: MediaAssetStatus;
    storageKey?: string;
    mimeType?: string | null;
    sha256?: string | null;
    deletionRequestedAt?: Date | null;
  } = {},
) {
  return prisma.mediaAsset.create({
    data: {
      id,
      organizationId,
      propertyId,
      storageKey: overrides.storageKey ?? `org/${organizationId}/a/${id}/normalized.jpg`,
      originalFilename: "kitchen.jpg",
      mimeType: overrides.mimeType === undefined ? "image/jpeg" : overrides.mimeType,
      sha256: overrides.sha256 === undefined ? DIGEST : overrides.sha256,
      status: overrides.status ?? "READY",
      deletionRequestedAt: overrides.deletionRequestedAt ?? null,
      createdBy: "usr_itest_ex",
    },
  });
}

async function cleanup(): Promise<void> {
  const organizationId = { in: [ORG_A, ORG_B] };
  await prisma.sceneGeneration.deleteMany({ where: { videoProject: { organizationId } } });
  await prisma.mediaAsset.deleteMany({ where: { organizationId } });
  await prisma.videoProject.deleteMany({ where: { organizationId } });
  await prisma.property.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await seedTenant(ORG_A, PROP_A, PROJECT_A);
  await seedTenant(ORG_B, PROP_B, PROJECT_B);
  await seedAsset(ASSET, ORG_A, PROP_A, { storageKey: KEY });
});

afterAll(async () => {
  if (HAS_DB) await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("findNextQueuedForPreparation against PostgreSQL", () => {
  it("resolves organizationId through the VideoProject join", async () => {
    await seedGeneration("gen_ex_b", "QUEUED", PROJECT_B);

    const candidate = await execution.findNextQueuedForPreparation();

    expect(candidate!.generation.id).toBe("gen_ex_b");
    // The row itself has no organizationId column; this value came from the
    // parent project, which is the only authority for it.
    expect(candidate!.organizationId).toBe(ORG_B);
  });

  it("agrees with the tenant-facing repository about who owns the row", async () => {
    // The two ports must never disagree: one resolves the tenant, the other is
    // addressed by it. If they diverged, execution would act on a row the
    // customer-facing side would refuse to show that same customer.
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A);

    const { organizationId, generation } = (await execution.findNextQueuedForPreparation())!;
    const asTenantSees = await tenantFacing.findById(organizationId, generation.id);

    expect(asTenantSees).not.toBeNull();
    expect(asTenantSees!.id).toBe(generation.id);
    // And the other tenant genuinely cannot see it.
    expect(await tenantFacing.findById(ORG_B, generation.id)).toBeNull();
  });

  it("scans across tenants, oldest first", async () => {
    await seedGeneration("gen_ex_new", "QUEUED", PROJECT_A, new Date("2026-08-18T03:00:00.000Z"));
    await seedGeneration("gen_ex_old", "QUEUED", PROJECT_B, new Date("2026-08-18T01:00:00.000Z"));

    const candidate = await execution.findNextQueuedForPreparation();

    expect(candidate!.generation.id).toBe("gen_ex_old");
    expect(candidate!.organizationId).toBe(ORG_B);
  });

  it("breaks a same-instant tie deterministically by id", async () => {
    // Two rows written in the same millisecond must still have a defined order,
    // or repeated scans could keep returning one and starve the other. This is
    // a property of the `ORDER BY`, so it is asked of the database that runs it.
    const same = new Date("2026-08-18T01:00:00.000Z");
    await seedGeneration("gen_ex_tie_b", "QUEUED", PROJECT_A, same);
    await seedGeneration("gen_ex_tie_a", "QUEUED", PROJECT_A, same);

    expect((await execution.findNextQueuedForPreparation())!.generation.id).toBe("gen_ex_tie_a");
  });

  it.each(SCENE_GENERATION_STATES.filter((s) => s !== "QUEUED"))(
    "never offers a %s row",
    async (state: SceneGenerationState) => {
      await seedGeneration("gen_ex_other", state, PROJECT_A);
      expect(await execution.findNextQueuedForPreparation()).toBeNull();
    },
  );

  it("writes nothing", async () => {
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A);
    const before = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } });

    await execution.findNextQueuedForPreparation();

    const after = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } });
    // `updatedAt` included: a stray write would move it even if state did not.
    expect(after).toEqual(before);
  });

  it("carries the frozen prompt and the immutable snapshot through the join", async () => {
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A);

    const { generation } = (await execution.findNextQueuedForPreparation())!;

    expect(generation.requestRenderedPrompt).toBe("frozen:gen_ex_a");
    expect(generation.requestCompiledPrompt).not.toBeNull();
    expect(generation.requestHash).toBe("sha256:gen_ex_a");
  });
});

describe.skipIf(!HAS_DB)("claimPreparedForSubmission against PostgreSQL", () => {
  it("moves QUEUED to SUBMITTING against a matching source", async () => {
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A);

    const outcome = await execution.claimPreparedForSubmission("gen_ex_a", IDENTITY);

    expect(outcome.kind).toBe("CLAIMED");
    if (outcome.kind !== "CLAIMED") return;
    expect(outcome.claim.generation.state).toBe("SUBMITTING");
    expect(outcome.claim.organizationId).toBe(ORG_A);
    const persisted = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } });
    expect(persisted!.state).toBe("SUBMITTING");
  });

  it("gives exactly one winner when two callers race for the same row", async () => {
    // The assertion this whole suite exists for. Two concurrent claims, one
    // licence to spend money.
    await seedGeneration("gen_ex_race", "QUEUED", PROJECT_A);

    const results = await Promise.all([
      execution.claimPreparedForSubmission("gen_ex_race", IDENTITY),
      execution.claimPreparedForSubmission("gen_ex_race", IDENTITY),
    ]);

    expect(results.filter((r) => r.kind === "CLAIMED")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "NOT_CLAIMABLE")).toHaveLength(1);
    // And the loser said nothing about the source, which was fine throughout.
    expect(results.filter((r) => r.kind === "SOURCE_INVALID")).toHaveLength(0);
    const persisted = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_race" } });
    expect(persisted!.state).toBe("SUBMITTING");
  });

  it("gives exactly one winner under wider contention", async () => {
    // Two is the minimum interesting case; eight makes an accidental pass far
    // less likely if the predicate were ever dropped from the update.
    await seedGeneration("gen_ex_race8", "QUEUED", PROJECT_A);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        execution.claimPreparedForSubmission("gen_ex_race8", IDENTITY),
      ),
    );

    expect(results.filter((r) => r.kind === "CLAIMED")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "NOT_CLAIMABLE")).toHaveLength(7);
  });

  it("serializes two generations sharing one asset, and both may claim", async () => {
    // They contend on the same `media_assets` row and nothing else, so the lock
    // orders them without either being refused: two independently QUEUED rows
    // are two independent licences. A deadlock here would surface as a failure
    // rather than a hang, because PostgreSQL detects and aborts one side.
    await seedGeneration("gen_ex_sh1", "QUEUED", PROJECT_A);
    await seedGeneration("gen_ex_sh2", "QUEUED", PROJECT_A);

    const results = await Promise.all([
      execution.claimPreparedForSubmission("gen_ex_sh1", IDENTITY),
      execution.claimPreparedForSubmission("gen_ex_sh2", IDENTITY),
    ]);

    expect(results.filter((r) => r.kind === "CLAIMED")).toHaveLength(2);
    for (const id of ["gen_ex_sh1", "gen_ex_sh2"]) {
      expect((await prisma.sceneGeneration.findUnique({ where: { id } }))!.state).toBe("SUBMITTING");
    }
  });

  it.each(SCENE_GENERATION_STATES.filter((s) => s !== "QUEUED"))(
    "refuses a %s row as NOT_CLAIMABLE and leaves every column untouched",
    async (state: SceneGenerationState) => {
      // Whole-row preservation, not just `state`: a refusal that still wrote
      // some other column — `updatedAt` above all, which a later abandonment
      // sweep reads — would make rows nobody is working on look freshly active.
      await seedGeneration("gen_ex_state", state, PROJECT_A);
      const before = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_state" } });

      const outcome = await execution.claimPreparedForSubmission("gen_ex_state", IDENTITY);

      // NOT_CLAIMABLE, never a source verdict: the row is not this caller's to
      // judge, and the source was never even looked at.
      expect(outcome).toEqual({ kind: "NOT_CLAIMABLE" });
      const after = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_state" } });
      expect(after).toEqual(before);
    },
  );

  it("returns NOT_CLAIMABLE for an id that does not exist", async () => {
    expect(await execution.claimPreparedForSubmission("gen_ex_missing", IDENTITY)).toEqual({
      kind: "NOT_CLAIMABLE",
    });
  });

  it("advances updatedAt, mutates state, and touches nothing else", async () => {
    // The row is seeded with a known-old `updatedAt` on purpose. Without one,
    // seed and claim can land inside the same clock tick, so an `updatedAt`
    // that never moved would still compare equal and the assertion below would
    // pass while proving nothing. A fixed past timestamp makes it discriminating
    // and deterministic — no sleep, no dependence on how fast the suite runs.
    //
    // The history columns are seeded non-null for the same reason: null
    // compares equal to null, so a claim that cleared them would pass against a
    // default-seeded row.
    const seededUpdatedAt = new Date("2020-01-01T00:00:00.000Z");
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A, undefined, seededUpdatedAt, {
      providerPredictionId: "prd_history",
      submittedAt: new Date("2020-01-01T00:00:00.000Z"),
      lastPolledAt: new Date("2020-01-02T00:00:00.000Z"),
      outputStorageKey: "org/out/history.mp4",
      normalizedErrorCode: "ASSET_NOT_READY",
      normalizedErrorMessage: "historical diagnostic",
    });

    const before = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } }))!;
    // Guards the guard: if Prisma ever stopped honouring an explicit value on an
    // `@updatedAt` field, the fixture would silently stop pinning anything and
    // this test would quietly go back to proving nothing.
    expect(before.updatedAt).toEqual(seededUpdatedAt);
    expect(before.normalizedErrorCode).toBe("ASSET_NOT_READY");

    await execution.claimPreparedForSubmission("gen_ex_a", IDENTITY);

    const after = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } }))!;
    expect(after.state).toBe("SUBMITTING");
    // Strictly greater, not merely different: the claim must move the row
    // forward in time. `updatedAt` is what a later milestone's abandonment
    // sweep will read to decide a `SUBMITTING` row has been stranded, so a
    // claim that failed to advance it would make a live claim look stale.
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    // And nothing else moved — including the execution history a future
    // explicit requeue policy may legitimately have left on the row.
    expect({ ...after, state: before.state, updatedAt: before.updatedAt }).toEqual(before);
  });

  it("claims a row belonging to whichever tenant owns it", async () => {
    await seedAsset(ASSET_B, ORG_B, PROP_B);
    await prisma.sceneGeneration.create({
      data: {
        id: "gen_ex_b",
        videoProjectId: PROJECT_B,
        sourceStoryboardSceneId: "scn_itest_ex",
        assetId: ASSET_B,
        sourceAnalysisRevision: 1,
        requestHash: "sha256:gen_ex_b",
        providerName: "fake",
        providerModelId: "fake/image-to-video",
        requestCompiledPrompt: '{"preservation":[],"sceneFacts":{},"userCustomization":null}',
        requestDurationSeconds: 5,
        requestCameraMotion: "SLOW_PAN_LEFT",
        requestAspectRatio: "16:9",
        requestResolution: "1080p",
        requestRenderedPrompt: "frozen:gen_ex_b",
        state: "QUEUED",
      },
    });

    const outcome = await execution.claimPreparedForSubmission("gen_ex_b", {
      storageKey: `org/${ORG_B}/a/${ASSET_B}/normalized.jpg`,
      mimeType: "image/jpeg",
      sha256: DIGEST,
    });

    expect(outcome.kind).toBe("CLAIMED");
    if (outcome.kind !== "CLAIMED") return;
    expect(outcome.claim.organizationId).toBe(ORG_B);
    // And nothing leaked into the other tenant's view.
    expect(await tenantFacing.findById(ORG_A, "gen_ex_b")).toBeNull();
  });

  // There is deliberately no test here racing a claim against
  // `tenantFacing.update(..., { state: "CANCELLED" })`.
  //
  // An earlier revision had one, and it was removed because it modelled the
  // wrong thing. `SceneGenerationRepository.update` carries no state predicate
  // — it persists what it is asked to persist — so it is not a safe
  // cancellation, and a test that raced against it could only assert that the
  // row ended in *either* state. That assertion holds no matter what the
  // adapter does, and worse, it read as though unconditional cancellation were
  // a supported competitor to the claim. It is not: an unconditional write that
  // lands after the claim commits will overwrite `SUBMITTING` regardless of any
  // transaction here.
  //
  // The real requirement is on the future writer, not on this adapter, so it is
  // recorded where a future writer will meet it: `docs/decisions/TODO.md` makes
  // an expected-state predicate a hard prerequisite for any competing
  // transition. What this adapter guarantees, and all it guarantees, is proven
  // above and below.

  it("leaves other rows alone while claiming one", async () => {
    await seedGeneration("gen_ex_1", "QUEUED", PROJECT_A, new Date("2026-08-18T01:00:00.000Z"));
    await seedGeneration("gen_ex_2", "QUEUED", PROJECT_A, new Date("2026-08-18T02:00:00.000Z"));

    await execution.claimPreparedForSubmission("gen_ex_1", IDENTITY);

    const other = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_2" } });
    expect(other!.state).toBe("QUEUED");
    // The next scan offers the remaining one, so a claim advances the queue.
    expect((await execution.findNextQueuedForPreparation())!.generation.id).toBe("gen_ex_2");
  });

});

describe.skipIf(!HAS_DB)("the locked source decides SOURCE_INVALID", () => {
  /** Run a claim against an asset mutated into some unusable shape. */
  async function claimWithAsset(
    id: string,
    assetOverrides: Parameters<typeof seedAsset>[3],
    identity: PreparedSourceIdentity = IDENTITY,
  ) {
    await prisma.mediaAsset.update({
      where: { id: ASSET },
      data: { ...assetOverrides, storageKey: assetOverrides?.storageKey ?? KEY },
    });
    await seedGeneration(id, "QUEUED", PROJECT_A);
    const before = (await prisma.sceneGeneration.findUnique({ where: { id } }))!;
    const outcome = await execution.claimPreparedForSubmission(id, identity);
    const after = (await prisma.sceneGeneration.findUnique({ where: { id } }))!;
    // Every refusal below is read-only. Whole-row equality including
    // `updatedAt`: SOURCE_INVALID happens before any generation write, and
    // parking the row is a separate decision this method does not make.
    expect(after).toEqual(before);
    return outcome;
  }

  it("refuses an asset whose deletion has been requested", async () => {
    const outcome = await claimWithAsset("gen_ex_del", {
      deletionRequestedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(outcome).toEqual({ kind: "SOURCE_INVALID", reason: "ASSET_UNRECOVERABLE" });
  });

  it.each<[MediaAssetStatus, string]>([
    ["PROCESSING", "ASSET_NOT_READY"],
    ["FAILED", "ASSET_UPLOAD_FAILED"],
    ["QUARANTINED", "ASSET_UNRECOVERABLE"],
  ])("maps a locked %s row to %s", async (status, reason) => {
    // Representative of each bucket rather than all ten: the exhaustive status
    // mapping is a pure domain property already proven in
    // `execution-source.test.ts`, and repeating it here would only re-test the
    // classifier through a slower boundary.
    const outcome = await claimWithAsset(`gen_ex_st_${status}`, { status });
    expect(outcome).toEqual({ kind: "SOURCE_INVALID", reason });
  });

  it("refuses when the durable key no longer matches the prepared one", async () => {
    const outcome = await claimWithAsset("gen_ex_key", {
      storageKey: `org/${ORG_A}/a/${ASSET}/normalized-v2.jpg`,
    });
    expect(outcome).toEqual({ kind: "SOURCE_INVALID", reason: "ASSET_SOURCE_CHANGED" });
  });

  it("refuses when only the digest differs, under an unchanged key and MIME", async () => {
    // The case the whole prepared-source contract exists for.
    // `buildAssetStorageKey` is deterministic, so a re-processed JPEG reuses the
    // same key with the same MIME type and different bytes: key and MIME
    // equality passes straight over it, and only the digest sees the change.
    const outcome = await claimWithAsset("gen_ex_hash", { sha256: OTHER_DIGEST });
    expect(outcome).toEqual({ kind: "SOURCE_INVALID", reason: "ASSET_SOURCE_CHANGED" });
  });

  it.each([
    ["missing", null],
    ["malformed", "not-a-canonical-digest"],
  ])("refuses a READY row whose digest is %s", async (label, sha256) => {
    // Classified on its own terms, not flattened into "changed": the locked row
    // is not a *different* identifiable source, it is one that cannot be
    // identified at all.
    const outcome = await claimWithAsset(`gen_ex_dig_${label}`, { sha256 });
    expect(outcome).toEqual({ kind: "SOURCE_INVALID", reason: "ASSET_SOURCE_UNIDENTIFIABLE" });
  });

  it("refuses a non-JPEG on its own terms rather than as a source change", async () => {
    // Only two independently *usable* identities ever reach equality, so a MIME
    // change that makes the locked row unusable is owned by the classifier
    // (ADR-0029 ordering) and never forced into ASSET_SOURCE_CHANGED.
    const outcome = await claimWithAsset("gen_ex_mime", { mimeType: "image/png" });
    expect(outcome).toEqual({ kind: "SOURCE_INVALID", reason: "ASSET_FORMAT_UNSUPPORTED" });
  });

  it("cannot see an asset belonging to another organization", async () => {
    // `organizationId` is in the locking predicate, so a foreign row is never
    // loaded — and absent and foreign are therefore indistinguishable, which is
    // the tenant guarantee rather than a limitation of the message.
    await seedAsset(ASSET_B, ORG_B, PROP_B);
    await prisma.sceneGeneration.create({
      data: {
        id: "gen_ex_foreign",
        videoProjectId: PROJECT_A,
        sourceStoryboardSceneId: "scn_itest_ex",
        assetId: ASSET_B,
        sourceAnalysisRevision: 1,
        requestHash: "sha256:gen_ex_foreign",
        providerName: "fake",
        providerModelId: "fake/image-to-video",
        requestCompiledPrompt: '{"preservation":[],"sceneFacts":{},"userCustomization":null}',
        requestDurationSeconds: 5,
        requestCameraMotion: "SLOW_PAN_LEFT",
        requestAspectRatio: "16:9",
        requestResolution: "1080p",
        requestRenderedPrompt: "frozen:gen_ex_foreign",
        state: "QUEUED",
      },
    });

    const outcome = await execution.claimPreparedForSubmission("gen_ex_foreign", IDENTITY);

    expect(outcome).toEqual({ kind: "SOURCE_INVALID", reason: "ASSET_NOT_FOUND" });
    // The foreign asset is untouched and undescribed.
    expect((await prisma.mediaAsset.findUnique({ where: { id: ASSET_B } }))!.status).toBe("READY");
  });

  it("refuses when the generation names an asset that does not exist", async () => {
    await prisma.mediaAsset.delete({ where: { id: ASSET } });
    await seedGeneration("gen_ex_noasset", "QUEUED", PROJECT_A);

    const outcome = await execution.claimPreparedForSubmission("gen_ex_noasset", IDENTITY);

    expect(outcome).toEqual({ kind: "SOURCE_INVALID", reason: "ASSET_NOT_FOUND" });
  });
});

/**
 * The two properties the asset row lock exists for, proven deterministically.
 *
 * Both need the claim held open at an exact point: after it has taken the
 * `FOR NO KEY UPDATE` lock, before it commits. There is no production hook for
 * that, and there must not be — a pause seam on the one method that issues
 * licences to spend money is worse than a weaker test.
 *
 * Instead the barrier is entirely test-owned. `createPrismaSceneGenerationExecutionRepository`
 * already takes a `PrismaClient`, so a test can hand it an **extended** client
 * whose `sceneGeneration.updateMany` interceptor waits on a promise this file
 * controls. That interception point is reached only after the lock statement has
 * returned, so arriving there *is* the proof that the lock is held — no sleeping
 * and hoping.
 *
 * Prisma 5.22's `$extends` query interceptors were verified to fire for calls
 * made on the interactive-transaction client before this harness was written;
 * if they did not, the barrier would silently never engage and these tests would
 * pass without proving anything.
 */
describe.skipIf(!HAS_DB)("the asset row lock serializes the claim", () => {
  /** Clients created per test, disconnected in `afterEach` whatever happens. */
  let extra: PrismaClient[] = [];

  function client(): PrismaClient {
    const created = new PrismaClient();
    extra.push(created);
    return created;
  }

  afterEach(async () => {
    await Promise.all(extra.map((c) => c.$disconnect()));
    extra = [];
  });

  /**
   * A claim whose generation compare-and-swap pauses until the returned
   * `release` is called. Reaching `atBarrier` proves the asset lock is held.
   */
  function pausableClaim(generationId: string, identity: PreparedSourceIdentity) {
    let release!: () => void;
    let arrive!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    const atBarrier = new Promise<void>((r) => {
      arrive = r;
    });

    const extended = client().$extends({
      query: {
        sceneGeneration: {
          async updateMany({ args, query }) {
            arrive();
            await released;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const outcome = createPrismaSceneGenerationExecutionRepository(
      extended,
    ).claimPreparedForSubmission(generationId, identity);

    return { outcome, atBarrier, release };
  }

  it("blocks a real deletion request while the claim holds the lock", async () => {
    await seedGeneration("gen_ex_lock", "QUEUED", PROJECT_A);
    const { outcome, atBarrier, release } = pausableClaim("gen_ex_lock", IDENTITY);
    await atBarrier;

    // The genuine `requestDeletion` write shape, on its own connection, with a
    // short lock timeout so a real conflict surfaces as an error rather than a
    // hang. 55P03 is `lock_not_available`.
    const deleter = client();
    let deletionFailure: { code?: string } | null = null;
    try {
      await deleter.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '400ms'`);
        await tx.mediaAsset.update({
          where: { id: ASSET, organizationId: ORG_A, deletionRequestedAt: null },
          data: { status: "DELETION_PENDING", deletionRequestedAt: new Date() },
        });
      });
    } catch (error) {
      deletionFailure = error as { code?: string };
    }

    // The whole point: deletion could not proceed while the claim held the row.
    expect(deletionFailure).not.toBeNull();
    expect(String(deletionFailure)).toMatch(/lock timeout|55P03|canceling statement/i);

    release();
    const claimed = await outcome;
    expect(claimed.kind).toBe("CLAIMED");

    // And once the claim has committed, deletion proceeds normally — the lock
    // ordered the two, it did not forbid the second.
    const after = await deleter.mediaAsset.update({
      where: { id: ASSET, organizationId: ORG_A, deletionRequestedAt: null },
      data: { status: "DELETION_PENDING", deletionRequestedAt: new Date() },
    });
    expect(after.status).toBe("DELETION_PENDING");

    // A deletion landing after the licence was issued does not revoke it.
    // There is no post-claim cancellation, by design.
    expect((await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_lock" } }))!.state).toBe(
      "SUBMITTING",
    );
  });

  /**
   * Block until **this claim** is provably waiting behind **that holder**.
   *
   * An earlier version asked only `SELECT count(*) FROM pg_locks WHERE NOT
   * granted`, which review correctly rejected: it is server-wide and
   * uncorrelated, so any unrelated waiter — another database on a shared
   * PostgreSQL server, a leftover session from another suite — satisfies it
   * immediately. The test would then park the generation *before* the claimant
   * had even completed its initial read, and the claim would answer
   * `NOT_CLAIMABLE` from that first check. It would pass with the post-lock
   * re-read removed, which is the one thing it exists to prove.
   *
   * The condition is now correlated on three axes at once:
   *
   * - `datname = current_database()`, so another database cannot satisfy it;
   * - the holder's own backend pid appears in `pg_blocking_pids(waiter)`, so it
   *   must be *this* holder the waiter is behind;
   * - the waiter's current query is the claim's asset lock — matched on
   *   `media_assets` and `FOR NO KEY UPDATE` rather than on exact text, because
   *   the statement is multi-line and whitespace is not a contract.
   *
   * Polling is only the mechanism for re-asking; the condition decides when the
   * test proceeds, and the attempt limit makes a broken harness fail rather than
   * hang.
   */
  async function waitUntilClaimBlockedBy(observer: PrismaClient, holderPid: number): Promise<void> {
    // The observer must be its own client. Asking through a pool that a blocked
    // transaction is already holding a connection from can queue behind it, and
    // the poll would then wait on the very thing it is trying to observe.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const blocked = await observer.$queryRaw<{ pid: number }[]>`
        SELECT a.pid
          FROM pg_stat_activity AS a
         WHERE a.datname = current_database()
           AND a.wait_event_type = 'Lock'
           AND ${holderPid}::int = ANY(pg_blocking_pids(a.pid))
           AND a.query LIKE '%media_assets%'
           AND a.query LIKE '%FOR NO KEY UPDATE%'`;
      if (blocked.length > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the claim never blocked on the holder's MediaAsset lock");
  }

  it("answers NOT_CLAIMABLE, not a stale source verdict, when the generation moves while it waits", async () => {
    // The precedence property. This claimant observes `QUEUED`, then blocks on
    // the asset lock. While it waits, a **real** execution transition parks the
    // row, and the source is simultaneously made invalid. Without the post-lock
    // re-read the claimant would report `SOURCE_INVALID` — a verdict about the
    // source of work that is no longer anyone's to do.
    await seedGeneration("gen_ex_prec", "QUEUED", PROJECT_A);
    // Break the source up front, before anything holds the row. It has to be
    // broken *before* the holder takes the lock: an update afterwards would
    // block on that same row, and the test would wait on itself. The claim's
    // initial read never looks at the asset, so this changes nothing it sees
    // until after the lock — which is exactly the interleaving under test.
    await prisma.mediaAsset.update({ where: { id: ASSET }, data: { sha256: OTHER_DIGEST } });

    // A separate transaction takes the asset row first, so the claim must wait.
    // Its acquisition is awaited rather than assumed: starting both and hoping
    // the holder wins would make this test decide the wrong thing at random.
    const holder = client();
    let acquired!: (pid: number) => void;
    let releaseHold!: () => void;
    // The holder's backend pid, read on the same connection that holds the lock
    // so it identifies exactly the transaction the claimant must wait behind.
    const holderPid = new Promise<number>((r) => {
      acquired = r;
    });
    const held = new Promise<void>((r) => {
      releaseHold = r;
    });
    const holding = holder.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "media_assets"
           WHERE "id" = ${ASSET} AND "organizationId" = ${ORG_A}
           FOR NO KEY UPDATE`;
        const [self] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        acquired(self!.pid);
        await held;
      },
      { timeout: 20000 },
    );
    const blockingPid = await holderPid;

    // Now the claim: it reads QUEUED, then blocks on the lock above. Proceeding
    // only once PostgreSQL reports *this* claim blocked behind *that* holder is
    // what makes the interleaving deterministic — and what makes the post-lock
    // re-read the thing actually under test.
    const claiming = execution.claimPreparedForSubmission("gen_ex_prec", IDENTITY);
    await waitUntilClaimBlockedBy(client(), blockingPid);

    // Move the generation with a real execution transition. It writes only
    // `scene_generations`, so it does not contend for the asset row.
    const parked = await execution.failQueuedPreflight("gen_ex_prec", "ASSET_NOT_READY");
    expect(parked).not.toBeNull();

    releaseHold();
    await holding;

    // NOT_CLAIMABLE wins. The source genuinely is invalid — a stale evaluation
    // would answer SOURCE_INVALID / ASSET_SOURCE_CHANGED here — but saying so
    // would be reporting on work another actor already finished with.
    expect(await claiming).toEqual({ kind: "NOT_CLAIMABLE" });
    const persisted = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_prec" } }))!;
    expect(persisted.state).toBe("FAILED_RETRYABLE");
    expect(persisted.normalizedErrorCode).toBe("ASSET_NOT_READY");
  });
});

describe.skipIf(!HAS_DB)("failQueuedPreflight against PostgreSQL", () => {
  it("parks a retryable refusal in FAILED_RETRYABLE with its exact reason", async () => {
    await seedGeneration("gen_ex_fr", "QUEUED", PROJECT_A);

    const failed = await execution.failQueuedPreflight("gen_ex_fr", "ASSET_NOT_READY");

    expect(failed!.generation.state).toBe("FAILED_RETRYABLE");
    expect(failed!.organizationId).toBe(ORG_A);
    const persisted = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_fr" } }))!;
    expect(persisted.state).toBe("FAILED_RETRYABLE");
    // The exact reason, unprefixed and untransformed: the durable code is the
    // same closed vocabulary the domain switches on, so a later reader does not
    // need a translation table to interpret it.
    expect(persisted.normalizedErrorCode).toBe("ASSET_NOT_READY");
    expect(persisted.normalizedErrorMessage).toBeNull();
  });

  it("parks a terminal refusal in FAILED_TERMINAL with its exact reason", async () => {
    await seedGeneration("gen_ex_ft", "QUEUED", PROJECT_A);

    const failed = await execution.failQueuedPreflight("gen_ex_ft", "ASSET_UNRECOVERABLE");

    expect(failed!.generation.state).toBe("FAILED_TERMINAL");
    const persisted = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_ft" } }))!;
    expect(persisted.state).toBe("FAILED_TERMINAL");
    expect(persisted.normalizedErrorCode).toBe("ASSET_UNRECOVERABLE");
    expect(persisted.normalizedErrorMessage).toBeNull();
  });

  it.each(PREFLIGHT_REFUSAL_REASONS)(
    "parks %s in the state the domain derives for it",
    async (reason) => {
      // Every reason against the real database, not just one of each kind, and
      // driven by the vocabulary itself — so Phase 4C-3A-2a's fourteenth reason
      // is covered here without a case being added for it. The adapter derives
      // the target internally, so this is the only place the full
      // reason-to-column mapping is observable end to end.
      await seedGeneration("gen_ex_all", "QUEUED", PROJECT_A);

      const failed = await execution.failQueuedPreflight("gen_ex_all", reason);

      expect(failed!.generation.state).toBe(preflightFailureStateFor(reason));
      const persisted = (await prisma.sceneGeneration.findUnique({
        where: { id: "gen_ex_all" },
      }))!;
      expect(persisted.state).toBe(preflightFailureStateFor(reason));
      expect(persisted.normalizedErrorCode).toBe(reason);
    },
  );

  it("clears a stale diagnostic message rather than leaving it beside a fresh code", async () => {
    // Representation A, proven rather than inherited from admission defaults.
    // The row is seeded *with* a message, as a row returned to QUEUED by a
    // future explicit requeue policy would carry. Omitting the null write would
    // leave that message next to this refusal's code, and the pair would
    // describe two different failures while reading as authoritative.
    await seedGeneration("gen_ex_stale", "QUEUED", PROJECT_A, undefined, undefined, {
      normalizedErrorCode: "PROVIDER",
      normalizedErrorMessage: "the provider reported a transient failure",
    });

    const failed = await execution.failQueuedPreflight("gen_ex_stale", "STORAGE_UNAVAILABLE");

    expect(failed!.generation.normalizedErrorMessage).toBeNull();
    const persisted = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_stale" } }))!;
    expect(persisted.normalizedErrorCode).toBe("STORAGE_UNAVAILABLE");
    expect(persisted.normalizedErrorMessage).toBeNull();
  });

  it("advances updatedAt, and changes only the three fields it owns", async () => {
    // Same known-old-timestamp fixture as the claim, for the same reason: seed
    // and write can land in one clock tick, and an `updatedAt` that never moved
    // would still compare equal.
    //
    // The row carries real execution history on purpose. A first attempt has
    // every one of those columns null, so a seed from the default path would
    // let an adapter that cleared them pass — null equals null.
    const seededUpdatedAt = new Date("2020-01-01T00:00:00.000Z");
    await seedGeneration("gen_ex_pres", "QUEUED", PROJECT_A, undefined, seededUpdatedAt, {
      providerPredictionId: "pred_prior_attempt",
      submittedAt: new Date("2020-01-01T00:00:00.000Z"),
      lastPolledAt: new Date("2020-01-01T00:05:00.000Z"),
      outputStorageKey: "generations/prior-output.mp4",
      normalizedErrorMessage: "an earlier failure",
    });

    const before = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_pres" } }))!;
    // Guards the guard, exactly as the claim's test does.
    expect(before.updatedAt).toEqual(seededUpdatedAt);

    await execution.failQueuedPreflight("gen_ex_pres", "SIGNED_SOURCE_URL_UNUSABLE");

    const after = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_pres" } }))!;
    expect(after.state).toBe("FAILED_RETRYABLE");
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    // Everything the park does *not* own, still exactly as it was. The prior
    // prediction id and submittedAt matter most: they record what a provider
    // was actually paid for, and clearing them as a side effect of parking
    // would erase the evidence of a charge.
    expect(after.providerPredictionId).toBe("pred_prior_attempt");
    expect(after.submittedAt).toEqual(before.submittedAt);
    expect(after.lastPolledAt).toEqual(before.lastPolledAt);
    expect(after.outputStorageKey).toBe("generations/prior-output.mp4");
    expect(after.requestHash).toBe(before.requestHash);
    expect(after.requestRenderedPrompt).toBe(before.requestRenderedPrompt);
    expect(after.createdAt).toEqual(before.createdAt);

    // And the whole row, normalized only on the four fields a successful park
    // is allowed to move.
    expect({
      ...after,
      state: before.state,
      normalizedErrorCode: before.normalizedErrorCode,
      normalizedErrorMessage: before.normalizedErrorMessage,
      updatedAt: before.updatedAt,
    }).toEqual(before);
  });

  it.each(SCENE_GENERATION_STATES.filter((s) => s !== "QUEUED"))(
    "refuses a %s row and leaves every column of it untouched",
    async (state: SceneGenerationState) => {
      // The same whole-row standard the claim is held to, and for a sharper
      // reason here: a park that overwrote a SUBMITTING or PROCESSING row would
      // mark work a provider is currently billing for as never submitted.
      await seedGeneration("gen_ex_fstate", state, PROJECT_A, undefined, undefined, {
        providerPredictionId: "pred_untouchable",
        submittedAt: new Date("2020-02-02T00:00:00.000Z"),
      });
      const before = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_fstate" } });

      const failed = await execution.failQueuedPreflight("gen_ex_fstate", "ASSET_NOT_FOUND");

      expect(failed).toBeNull();
      const after = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_fstate" } });
      expect(after).toEqual(before);
    },
  );

  it("returns null for an id that does not exist", async () => {
    // No preliminary existence read: the CAS predicate matches nothing and the
    // caller gets the ordinary lost result, indistinguishable from a lost race.
    expect(await execution.failQueuedPreflight("gen_ex_missing", "ASSET_NOT_FOUND")).toBeNull();
  });

  it("gives exactly one winner when two different refusals race", async () => {
    // First database writer wins. There is deliberately no reason priority:
    // with two refusals both true of one row, either is a correct record, and
    // inventing an order would mean the durable reason depended on a rule
    // nothing else in the system knows about.
    await seedGeneration("gen_ex_frace", "QUEUED", PROJECT_A);

    const results = await Promise.all([
      execution.failQueuedPreflight("gen_ex_frace", "ASSET_NOT_READY"),
      execution.failQueuedPreflight("gen_ex_frace", "ASSET_UNRECOVERABLE"),
    ]);

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);

    // The durable row agrees with whichever caller was told it won — the
    // property that makes a returned result trustworthy at all.
    const winner = winners[0]!;
    const persisted = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_frace" } }))!;
    expect(persisted.state).toBe(winner.generation.state);
    expect(persisted.normalizedErrorCode).toBe(winner.generation.normalizedErrorCode);
    // The two reasons park in different states, so this also proves the loser's
    // write did not land underneath the winner's.
    expect(persisted.normalizedErrorCode).toBe(
      persisted.state === "FAILED_RETRYABLE" ? "ASSET_NOT_READY" : "ASSET_UNRECOVERABLE",
    );
  });

  it("gives exactly one winner under wider contention", async () => {
    await seedGeneration("gen_ex_frace8", "QUEUED", PROJECT_A);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        execution.failQueuedPreflight("gen_ex_frace8", "STORAGE_UNAVAILABLE"),
      ),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("gives exactly one winner when a park races a claim", async () => {
    // R1, and the reason both methods carry the identical `state = 'QUEUED'`
    // predicate. The two outcomes are not symmetric in consequence: if the
    // claim wins, a licence to spend money exists and the park must not be able
    // to overwrite it; if the park wins, no licence exists at all.
    await seedGeneration("gen_ex_mixed", "QUEUED", PROJECT_A);

    const [claimed, failed] = await Promise.all([
      execution.claimPreparedForSubmission("gen_ex_mixed", IDENTITY),
      execution.failQueuedPreflight("gen_ex_mixed", "ASSET_NOT_READY"),
    ]);

    expect([claimed.kind === "CLAIMED", failed !== null].filter(Boolean)).toHaveLength(1);
    const persisted = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_mixed" } }))!;

    if (claimed.kind === "CLAIMED") {
      expect(failed).toBeNull();
      expect(persisted.state).toBe("SUBMITTING");
      // No refusal was recorded against a row someone may now be paying for.
      expect(persisted.normalizedErrorCode).toBeNull();
    } else {
      // The loser says NOT_CLAIMABLE, never a source verdict: the source was
      // usable, and what it lost to was a competing transition.
      expect(claimed).toEqual({ kind: "NOT_CLAIMABLE" });
      expect(failed).not.toBeNull();
      expect(persisted.state).toBe("FAILED_RETRYABLE");
      expect(persisted.normalizedErrorCode).toBe("ASSET_NOT_READY");
      // And no submission licence was issued for it.
      expect(persisted.submittedAt).toBeNull();
      expect(persisted.providerPredictionId).toBeNull();
    }
  });

  it("resolves organizationId through the VideoProject join, with no tenant input", async () => {
    await seedGeneration("gen_ex_ftenant", "QUEUED", PROJECT_B);

    const failed = await execution.failQueuedPreflight("gen_ex_ftenant", "ASSET_NOT_FOUND");

    expect(failed!.organizationId).toBe(ORG_B);
    // The method never named an organization, and the row stays invisible to
    // the other tenant's scoped reads.
    expect(await tenantFacing.findById(ORG_A, "gen_ex_ftenant")).toBeNull();
    expect((await tenantFacing.findById(ORG_B, "gen_ex_ftenant"))!.state).toBe("FAILED_TERMINAL");
  });

  it("leaves other rows alone while parking one", async () => {
    await seedGeneration("gen_ex_f1", "QUEUED", PROJECT_A, new Date("2026-08-18T01:00:00.000Z"));
    await seedGeneration("gen_ex_f2", "QUEUED", PROJECT_A, new Date("2026-08-18T02:00:00.000Z"));

    await execution.failQueuedPreflight("gen_ex_f1", "ASSET_OBJECT_MISSING");

    const other = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_f2" } }))!;
    expect(other.state).toBe("QUEUED");
    expect(other.normalizedErrorCode).toBeNull();
    // A parked row leaves the queue, so the scan moves on to the next one.
    expect((await execution.findNextQueuedForPreparation())!.generation.id).toBe("gen_ex_f2");
  });
});
