import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPrismaSceneGenerationExecutionRepository,
  createPrismaSceneGenerationRepository,
} from "@app/database";
import {
  PREFLIGHT_REFUSAL_REASONS,
  SCENE_GENERATION_STATES,
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
      resolution: "1080p",
      createdBy: "usr_itest_ex",
    },
  });
}

async function cleanup(): Promise<void> {
  const organizationId = { in: [ORG_A, ORG_B] };
  await prisma.sceneGeneration.deleteMany({ where: { videoProject: { organizationId } } });
  await prisma.videoProject.deleteMany({ where: { organizationId } });
  await prisma.property.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await seedTenant(ORG_A, PROP_A, PROJECT_A);
  await seedTenant(ORG_B, PROP_B, PROJECT_B);
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

describe.skipIf(!HAS_DB)("claimQueuedForSubmission against PostgreSQL", () => {
  it("moves QUEUED to SUBMITTING and returns the post-claim row", async () => {
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A);

    const claimed = await execution.claimQueuedForSubmission("gen_ex_a");

    expect(claimed!.generation.state).toBe("SUBMITTING");
    expect(claimed!.organizationId).toBe(ORG_A);
    const persisted = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } });
    expect(persisted!.state).toBe("SUBMITTING");
  });

  it("gives exactly one winner when two callers race for the same row", async () => {
    // The assertion this whole suite exists for. Two concurrent claims, one
    // licence to spend money.
    await seedGeneration("gen_ex_race", "QUEUED", PROJECT_A);

    const results = await Promise.all([
      execution.claimQueuedForSubmission("gen_ex_race"),
      execution.claimQueuedForSubmission("gen_ex_race"),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    const persisted = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_race" } });
    expect(persisted!.state).toBe("SUBMITTING");
  });

  it("gives exactly one winner under wider contention", async () => {
    // Two is the minimum interesting case; eight makes an accidental pass far
    // less likely if the predicate were ever dropped from the update.
    await seedGeneration("gen_ex_race8", "QUEUED", PROJECT_A);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => execution.claimQueuedForSubmission("gen_ex_race8")),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it.each(SCENE_GENERATION_STATES.filter((s) => s !== "QUEUED"))(
    "refuses a %s row and leaves every column of it untouched",
    async (state: SceneGenerationState) => {
      // Whole-row preservation, not just `state`: a refusal that still wrote
      // some other column — `updatedAt` above all, which a later abandonment
      // sweep reads — would make rows nobody is working on look freshly active.
      await seedGeneration("gen_ex_state", state, PROJECT_A);
      const before = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_state" } });

      const claimed = await execution.claimQueuedForSubmission("gen_ex_state");

      expect(claimed).toBeNull();
      const after = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_state" } });
      expect(after).toEqual(before);
    },
  );

  it("returns null for an id that does not exist", async () => {
    expect(await execution.claimQueuedForSubmission("gen_ex_missing")).toBeNull();
  });

  it("advances updatedAt, mutates state, and touches nothing else", async () => {
    // The row is seeded with a known-old `updatedAt` on purpose. Without one,
    // seed and claim can land inside the same clock tick, so an `updatedAt`
    // that never moved would still compare equal and the assertion below would
    // pass while proving nothing. A fixed past timestamp makes it discriminating
    // and deterministic — no sleep, no dependence on how fast the suite runs.
    const seededUpdatedAt = new Date("2020-01-01T00:00:00.000Z");
    await seedGeneration("gen_ex_a", "QUEUED", PROJECT_A, undefined, seededUpdatedAt);

    const before = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } }))!;
    // Guards the guard: if Prisma ever stopped honouring an explicit value on an
    // `@updatedAt` field, the fixture would silently stop pinning anything and
    // this test would quietly go back to proving nothing.
    expect(before.updatedAt).toEqual(seededUpdatedAt);

    await execution.claimQueuedForSubmission("gen_ex_a");

    const after = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_a" } }))!;
    expect(after.state).toBe("SUBMITTING");
    // Strictly greater, not merely different: the claim must move the row
    // forward in time. `updatedAt` is what a later milestone's abandonment
    // sweep will read to decide a `SUBMITTING` row has been stranded, so a
    // claim that failed to advance it would make a live claim look stale.
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    // And nothing else moved. A claim that rewrote a snapshot field would change
    // what a later milestone submits, under a requestHash that still validated.
    expect({ ...after, state: before.state, updatedAt: before.updatedAt }).toEqual(before);
  });

  it("claims a row belonging to whichever tenant owns it", async () => {
    await seedGeneration("gen_ex_b", "QUEUED", PROJECT_B);

    const claimed = await execution.claimQueuedForSubmission("gen_ex_b");

    expect(claimed!.organizationId).toBe(ORG_B);
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
  // above — a won claim returns the row this caller moved to `SUBMITTING`, and
  // a lost claim returns `null`.

  it("leaves other rows alone while claiming one", async () => {
    await seedGeneration("gen_ex_1", "QUEUED", PROJECT_A, new Date("2026-08-18T01:00:00.000Z"));
    await seedGeneration("gen_ex_2", "QUEUED", PROJECT_A, new Date("2026-08-18T02:00:00.000Z"));

    await execution.claimQueuedForSubmission("gen_ex_1");

    const other = await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_2" } });
    expect(other!.state).toBe("QUEUED");
    // The next scan offers the remaining one, so a claim advances the queue.
    expect((await execution.findNextQueuedForPreparation())!.generation.id).toBe("gen_ex_2");
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
      execution.claimQueuedForSubmission("gen_ex_mixed"),
      execution.failQueuedPreflight("gen_ex_mixed", "ASSET_NOT_READY"),
    ]);

    expect([claimed, failed].filter((r) => r !== null)).toHaveLength(1);
    const persisted = (await prisma.sceneGeneration.findUnique({ where: { id: "gen_ex_mixed" } }))!;

    if (claimed !== null) {
      expect(failed).toBeNull();
      expect(persisted.state).toBe("SUBMITTING");
      // No refusal was recorded against a row someone may now be paying for.
      expect(persisted.normalizedErrorCode).toBeNull();
    } else {
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
