import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaSceneGenerationRepository } from "@app/database";
import {
  ACTIVE_SCENE_GENERATION_STATES,
  ActiveGenerationConflictError,
  SceneGenerationNotFoundError,
  type NewSceneGeneration,
  type SceneGenerationState,
} from "@app/domain";

/**
 * The scene-generation repository against live PostgreSQL.
 *
 * Phase 4A-2a proved what the *database* guarantees. This suite proves what the
 * *adapter* does with it: that tenant scope is carried by the query, that the
 * two neutral errors mean what they say, and — the part most easily got wrong —
 * that only the active-request collision becomes a conflict while every other
 * database failure propagates untouched.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG_A = "org_itest_gr_a";
const ORG_B = "org_itest_gr_b";
const PROP_A = "prp_itest_gr_a";
const PROP_B = "prp_itest_gr_b";
const PROJECT_A = "vpr_itest_gr_a";
const PROJECT_A2 = "vpr_itest_gr_a2";
const PROJECT_B = "vpr_itest_gr_b";
const HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const prisma = new PrismaClient();
const repo = createPrismaSceneGenerationRepository(prisma);

function generation(id: string, overrides: Partial<NewSceneGeneration> = {}): NewSceneGeneration {
  return {
    id,
    videoProjectId: PROJECT_A,
    sourceStoryboardSceneId: "scn_itest_gr",
    assetId: "ast_itest_gr",
    sourceAnalysisRevision: 1,
    requestHash: HASH,
    providerName: "fake",
    providerModelId: "fake/image-to-video",
    requestCompiledPrompt: '{"preservation":[],"sceneFacts":{},"userCustomization":null}',
    requestDurationSeconds: 5,
    requestCameraMotion: "SLOW_PAN",
    requestAspectRatio: "16:9",
    requestResolution: "1080p",
    state: "QUEUED",
    providerPredictionId: null,
    submittedAt: null,
    lastPolledAt: null,
    normalizedErrorCode: null,
    normalizedErrorMessage: null,
    outputStorageKey: null,
    ...overrides,
  };
}

function seedProject(organizationId: string, propertyId: string, projectId: string) {
  return prisma.videoProject.create({
    data: {
      id: projectId,
      organizationId,
      propertyId,
      name: "Walkthrough",
      durationSeconds: 12,
      aspectRatio: "16:9",
      resolution: "1080p",
      createdBy: "usr_itest_gr",
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
      createdBy: "usr_itest_gr",
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
      createdBy: "usr_itest_gr",
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

/** Capture a rejection without letting a resolved promise pass silently. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the operation to reject, but it resolved");
    },
    (error: unknown) => error,
  );
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await seedTenant(ORG_A, PROP_A, PROJECT_A);
  await seedTenant(ORG_B, PROP_B, PROJECT_B);
  // A second project in the SAME organization, so "scoped per project" is
  // distinguishable from "scoped per tenant".
  await seedProject(ORG_A, PROP_A, PROJECT_A2);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("create and mapping", () => {
  it("returns the full mapped entity", async () => {
    const created = await repo.create(
      ORG_A,
      generation("gen_map", {
        state: "PROCESSING",
        providerPredictionId: "pred_abc",
        submittedAt: new Date("2026-08-09T10:00:00.000Z"),
        outputStorageKey: "org/a/generations/gen_map.mp4",
      }),
    );

    expect(created.id).toBe("gen_map");
    expect(created.videoProjectId).toBe(PROJECT_A);
    expect(created.sourceStoryboardSceneId).toBe("scn_itest_gr");
    expect(created.assetId).toBe("ast_itest_gr");
    expect(created.sourceAnalysisRevision).toBe(1);
    expect(created.requestHash).toBe(HASH);
    expect(created.providerName).toBe("fake");
    expect(created.providerModelId).toBe("fake/image-to-video");
    expect(created.state).toBe("PROCESSING");
    expect(created.providerPredictionId).toBe("pred_abc");
    expect(created.submittedAt).toEqual(new Date("2026-08-09T10:00:00.000Z"));
    expect(created.outputStorageKey).toBe("org/a/generations/gen_map.mp4");
  });

  it("round-trips the nullable execution fields", async () => {
    const created = await repo.create(ORG_A, generation("gen_nulls"));
    expect(created.providerPredictionId).toBeNull();
    expect(created.submittedAt).toBeNull();
    expect(created.lastPolledAt).toBeNull();
    expect(created.normalizedErrorCode).toBeNull();
    expect(created.normalizedErrorMessage).toBeNull();
    expect(created.outputStorageKey).toBeNull();
  });

  it("takes createdAt and updatedAt from persistence", async () => {
    // The caller cannot supply either — they are absent from NewSceneGeneration.
    const created = await repo.create(ORG_A, generation("gen_ts"));
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
    expect(created.createdAt.getTime()).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("create is bounded by the caller's organization", () => {
  // Review found the first version of `create` trusting `input.videoProjectId`
  // outright. Two things were wrong with that, and the second is the worse one:
  // a caller could write into another tenant's project, and could then *read*
  // that tenant's state back — a colliding request would answer
  // ActiveGenerationConflictError, disclosing that the other organization has an
  // attempt in flight for that exact request.

  it("accepts a project the caller's organization owns", async () => {
    const created = await repo.create(ORG_A, generation("gen_own"));
    expect(created.videoProjectId).toBe(PROJECT_A);
  });

  it("refuses a project belonging to another organization", async () => {
    const error = await rejectionOf(
      repo.create(ORG_A, generation("gen_cross", { videoProjectId: PROJECT_B })),
    );
    expect(error).toBeInstanceOf(SceneGenerationNotFoundError);
  });

  it("refuses a nonexistent project with the SAME error", async () => {
    const foreign = (await rejectionOf(
      repo.create(ORG_A, generation("gen_cross", { videoProjectId: PROJECT_B })),
    )) as Error;
    const unknown = (await rejectionOf(
      repo.create(ORG_A, generation("gen_unknown", { videoProjectId: "vpr_never_existed" })),
    )) as Error;

    expect(unknown).toBeInstanceOf(SceneGenerationNotFoundError);
    // Same type and same message, so a caller cannot tell "that project is
    // someone else's" from "that project does not exist".
    expect(unknown.name).toBe(foreign.name);
    expect(unknown.message).toBe(foreign.message);
  });

  it("writes nothing when the project is not the caller's", async () => {
    await rejectionOf(repo.create(ORG_A, generation("gen_cross", { videoProjectId: PROJECT_B })));
    expect(await prisma.sceneGeneration.count({ where: { id: "gen_cross" } })).toBe(0);
    expect(await prisma.sceneGeneration.count({ where: { videoProjectId: PROJECT_B } })).toBe(0);
  });

  it("does not disclose another tenant's active generation through a conflict", async () => {
    // The disclosure this defect enabled. B has an active attempt for hash X;
    // A asks for the same project and hash. A must learn nothing — not even
    // that a conflict exists.
    await repo.create(ORG_B, generation("gen_b_active", { videoProjectId: PROJECT_B }));

    const error = await rejectionOf(
      repo.create(ORG_A, generation("gen_probe", { videoProjectId: PROJECT_B })),
    );

    expect(error).toBeInstanceOf(SceneGenerationNotFoundError);
    expect(error).not.toBeInstanceOf(ActiveGenerationConflictError);
    // B's row is untouched and still the only one.
    expect(await prisma.sceneGeneration.count({ where: { videoProjectId: PROJECT_B } })).toBe(1);
  });

  it("leaks no project id, organization, or database detail when refusing", async () => {
    const error = (await rejectionOf(
      repo.create(ORG_A, generation("gen_cross", { videoProjectId: PROJECT_B })),
    )) as Error;
    const text = `${error.name} ${error.message}`;
    expect(text).not.toContain(PROJECT_B);
    expect(text).not.toContain(ORG_A);
    expect(text).not.toContain(ORG_B);
    expect(text).not.toContain("Prisma");
    expect(text).not.toContain("video_projects");
  });
});

describe.skipIf(!HAS_DB)("tenant-scoped reads", () => {
  beforeEach(async () => {
    await repo.create(ORG_A, generation("gen_read"));
  });

  it("finds an attempt for its owning organization", async () => {
    const found = await repo.findById(ORG_A, "gen_read");
    expect(found?.id).toBe("gen_read");
  });

  it("returns null for another organization, and for an unknown id", async () => {
    const foreign = await repo.findById(ORG_B, "gen_read");
    const unknown = await repo.findById(ORG_B, "gen_never_existed");
    // Identical answers: an attempt cannot be probed for from outside its tenant.
    expect(foreign).toBeNull();
    expect(unknown).toBeNull();
    expect(foreign).toEqual(unknown);
  });

  it("returns null for an unknown id inside the owning organization too", async () => {
    expect(await repo.findById(ORG_A, "gen_never_existed")).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("findActiveByRequestIdentity", () => {
  it.each(["QUEUED", "SUBMITTING", "PROCESSING", "FAILED_RETRYABLE", "SUBMISSION_UNKNOWN"] as const)(
    "finds an attempt that is %s",
    async (state: SceneGenerationState) => {
      await repo.create(ORG_A, generation("gen_active", { state }));
      const found = await repo.findActiveByRequestIdentity(ORG_A, PROJECT_A, HASH);
      expect(found?.id).toBe("gen_active");
      expect(found?.state).toBe(state);
    },
  );

  it.each(["SUCCEEDED", "FAILED_TERMINAL", "CANCELLED"] as const)(
    "does not return an attempt that is %s",
    async (state: SceneGenerationState) => {
      await repo.create(ORG_A, generation("gen_done", { state }));
      expect(await repo.findActiveByRequestIdentity(ORG_A, PROJECT_A, HASH)).toBeNull();
    },
  );

  it("cannot see another tenant's active attempt", async () => {
    await repo.create(ORG_A, generation("gen_mine"));
    expect(await repo.findActiveByRequestIdentity(ORG_B, PROJECT_A, HASH)).toBeNull();
  });

  it("is not disturbed by the same request hash in another tenant", async () => {
    await repo.create(ORG_A, generation("gen_a", { videoProjectId: PROJECT_A }));
    await repo.create(ORG_B, generation("gen_b", { id: "gen_b", videoProjectId: PROJECT_B }));

    expect((await repo.findActiveByRequestIdentity(ORG_A, PROJECT_A, HASH))?.id).toBe("gen_a");
    expect((await repo.findActiveByRequestIdentity(ORG_B, PROJECT_B, HASH))?.id).toBe("gen_b");
  });

  it("returns null for a request hash nobody has attempted", async () => {
    await repo.create(ORG_A, generation("gen_a"));
    expect(await repo.findActiveByRequestIdentity(ORG_A, PROJECT_A, "sha256:other")).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("findLatestSucceededByRequestIdentity", () => {
  // The narrow history query, and the only one this repository has. It exists
  // so an identical already-succeeded request does not automatically become a
  // second billable attempt. Terminal states release the active identity, so
  // findActiveByRequestIdentity provably cannot see these rows.

  it("returns a succeeded attempt for the owning organization", async () => {
    await repo.create(ORG_A, generation("gen_ok", { state: "SUCCEEDED" }));
    const found = await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH);
    expect(found?.id).toBe("gen_ok");
    expect(found?.state).toBe("SUCCEEDED");
  });

  it("cannot be seen by another organization", async () => {
    await repo.create(ORG_A, generation("gen_ok", { state: "SUCCEEDED" }));
    expect(await repo.findLatestSucceededByRequestIdentity(ORG_B, PROJECT_A, HASH)).toBeNull();
  });

  it("returns null for an unknown project or an unattempted request hash", async () => {
    await repo.create(ORG_A, generation("gen_ok", { state: "SUCCEEDED" }));
    expect(
      await repo.findLatestSucceededByRequestIdentity(ORG_A, "vpr_never_existed", HASH),
    ).toBeNull();
    expect(
      await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, "sha256:never"),
    ).toBeNull();
  });

  it.each(ACTIVE_SCENE_GENERATION_STATES)("does not return an attempt that is %s", async (state) => {
    // An in-flight attempt is the other lookup's business. Returning it here
    // would let the service treat "still running" as "already delivered".
    await repo.create(ORG_A, generation("gen_active", { state }));
    expect(await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH)).toBeNull();
  });

  it.each(["FAILED_TERMINAL", "CANCELLED"] as const)(
    "does not return an attempt that is %s",
    async (state: SceneGenerationState) => {
      // These release the identity precisely so a new attempt is allowed.
      await repo.create(ORG_A, generation("gen_term", { state }));
      expect(await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH)).toBeNull();
    },
  );

  it("returns the most recent when several have succeeded", async () => {
    // createdAt descending, id descending as tie-break — declared by the
    // adapter rather than left to the planner.
    await prisma.sceneGeneration.create({
      data: {
        ...generation("gen_old", { state: "SUCCEEDED" }),
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    await prisma.sceneGeneration.create({
      data: {
        ...generation("gen_new", { state: "SUCCEEDED" }),
        createdAt: new Date("2026-08-09T00:00:00.000Z"),
        updatedAt: new Date("2026-08-09T00:00:00.000Z"),
      },
    });

    const found = await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH);
    expect(found?.id).toBe("gen_new");
    // Stable across repeats: nothing depends on physical row order.
    expect((await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH))?.id).toBe(
      "gen_new",
    );
  });

  it("orders deterministically when two succeeded at the same instant", async () => {
    const at = new Date("2026-08-09T12:00:00.000Z");
    // Inserted in the order OPPOSITE to `id` descending, so physical/insertion
    // order cannot accidentally produce the right answer.
    for (const id of ["gen_zzz", "gen_aaa"]) {
      await prisma.sceneGeneration.create({
        data: { ...generation(id, { state: "SUCCEEDED" }), createdAt: at, updatedAt: at },
      });
    }
    // `id` descending breaks the tie, so the answer is defined rather than
    // whatever the database happened to return first.
    const found = await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH);
    expect(found?.id).toBe("gen_zzz");
  });

  it("does not confuse the same request hash under another project", async () => {
    await repo.create(ORG_A, generation("gen_p1", { state: "SUCCEEDED" }));
    await repo.create(
      ORG_A,
      generation("gen_p2", { videoProjectId: PROJECT_A2, state: "SUCCEEDED" }),
    );

    expect((await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH))?.id).toBe(
      "gen_p1",
    );
    expect((await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A2, HASH))?.id).toBe(
      "gen_p2",
    );
  });

  it("does not confuse the same request hash in another tenant", async () => {
    await repo.create(ORG_A, generation("gen_a", { state: "SUCCEEDED" }));
    await repo.create(
      ORG_B,
      generation("gen_b", { videoProjectId: PROJECT_B, state: "SUCCEEDED" }),
    );

    expect((await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH))?.id).toBe(
      "gen_a",
    );
    expect((await repo.findLatestSucceededByRequestIdentity(ORG_B, PROJECT_B, HASH))?.id).toBe(
      "gen_b",
    );
  });
});

describe.skipIf(!HAS_DB)("tenant-scoped update", () => {
  beforeEach(async () => {
    await repo.create(ORG_A, generation("gen_upd"));
  });

  it("applies changes for the owning organization", async () => {
    const updated = await repo.update(ORG_A, "gen_upd", { state: "SUBMITTING" });
    expect(updated.state).toBe("SUBMITTING");
  });

  it("throws SceneGenerationNotFoundError for another organization", async () => {
    const error = await rejectionOf(repo.update(ORG_B, "gen_upd", { state: "SUCCEEDED" }));
    expect(error).toBeInstanceOf(SceneGenerationNotFoundError);
  });

  it("throws the same error for an unknown id", async () => {
    const foreign = await rejectionOf(repo.update(ORG_B, "gen_upd", { state: "SUCCEEDED" }));
    const unknown = await rejectionOf(repo.update(ORG_B, "gen_missing", { state: "SUCCEEDED" }));
    expect(unknown).toBeInstanceOf(SceneGenerationNotFoundError);
    // Same type and same message, so the response cannot reveal that the row
    // exists in some other organization.
    expect((unknown as Error).name).toBe((foreign as Error).name);
    expect((unknown as Error).message).toBe((foreign as Error).message);
  });

  it("leaves the row untouched when another organization attempts the write", async () => {
    await rejectionOf(repo.update(ORG_B, "gen_upd", { state: "FAILED_TERMINAL" }));
    const row = await repo.findById(ORG_A, "gen_upd");
    expect(row?.state).toBe("QUEUED");
  });

  it("exposes no tenant, id, or database detail in the not-found error", async () => {
    const error = await rejectionOf(repo.update(ORG_B, "gen_upd", { state: "SUCCEEDED" }));
    const text = `${(error as Error).name} ${(error as Error).message}`;
    expect(text).not.toContain(ORG_A);
    expect(text).not.toContain(ORG_B);
    expect(text).not.toContain("gen_upd");
    expect(text).not.toContain("Prisma");
    expect(text).not.toContain("scene_generations");
  });
});

describe.skipIf(!HAS_DB)("mutable execution fields", () => {
  beforeEach(async () => {
    await repo.create(ORG_A, generation("gen_fields"));
  });

  it("updates each field independently", async () => {
    const submittedAt = new Date("2026-08-09T11:00:00.000Z");
    const lastPolledAt = new Date("2026-08-09T11:00:30.000Z");

    expect((await repo.update(ORG_A, "gen_fields", { state: "SUBMITTING" })).state).toBe(
      "SUBMITTING",
    );
    expect(
      (await repo.update(ORG_A, "gen_fields", { providerPredictionId: "pred_1" }))
        .providerPredictionId,
    ).toBe("pred_1");
    expect((await repo.update(ORG_A, "gen_fields", { submittedAt })).submittedAt).toEqual(
      submittedAt,
    );
    expect((await repo.update(ORG_A, "gen_fields", { lastPolledAt })).lastPolledAt).toEqual(
      lastPolledAt,
    );
    expect(
      (await repo.update(ORG_A, "gen_fields", { normalizedErrorCode: "PROVIDER" }))
        .normalizedErrorCode,
    ).toBe("PROVIDER");
    expect(
      (await repo.update(ORG_A, "gen_fields", { normalizedErrorMessage: "transient" }))
        .normalizedErrorMessage,
    ).toBe("transient");
    expect(
      (await repo.update(ORG_A, "gen_fields", { outputStorageKey: "org/a/out.mp4" }))
        .outputStorageKey,
    ).toBe("org/a/out.mp4");
  });

  it("clears nullable fields when null is supplied explicitly", async () => {
    await repo.update(ORG_A, "gen_fields", {
      normalizedErrorCode: "PROVIDER",
      normalizedErrorMessage: "transient",
      outputStorageKey: "org/a/out.mp4",
    });
    const cleared = await repo.update(ORG_A, "gen_fields", {
      normalizedErrorCode: null,
      normalizedErrorMessage: null,
      outputStorageKey: null,
    });
    expect(cleared.normalizedErrorCode).toBeNull();
    expect(cleared.normalizedErrorMessage).toBeNull();
    expect(cleared.outputStorageKey).toBeNull();
  });

  it("leaves unmentioned fields alone", async () => {
    await repo.update(ORG_A, "gen_fields", {
      providerPredictionId: "pred_keep",
      normalizedErrorCode: "PROVIDER",
    });
    const after = await repo.update(ORG_A, "gen_fields", { state: "PROCESSING" });
    expect(after.normalizedErrorCode).toBe("PROVIDER");
  });
});

describe.skipIf(!HAS_DB)("providerPredictionId retention", () => {
  it("survives a state-only update out of PROCESSING", async () => {
    // The regression this exists for: a prediction id identifies provider-side
    // work that may have been paid for. Clearing it as a side effect of leaving
    // PROCESSING would lose the only handle on that work.
    await repo.create(
      ORG_A,
      generation("gen_pred", { state: "PROCESSING", providerPredictionId: "pred_123" }),
    );

    const succeeded = await repo.update(ORG_A, "gen_pred", { state: "SUCCEEDED" });
    expect(succeeded.state).toBe("SUCCEEDED");
    expect(succeeded.providerPredictionId).toBe("pred_123");
  });

  it.each(["SUCCEEDED", "FAILED_RETRYABLE", "FAILED_TERMINAL"] as const)(
    "keeps the prediction id on a %s row",
    async (state: SceneGenerationState) => {
      await repo.create(
        ORG_A,
        generation("gen_pred", { state: "PROCESSING", providerPredictionId: "pred_123" }),
      );
      const moved = await repo.update(ORG_A, "gen_pred", { state });
      expect(moved.providerPredictionId).toBe("pred_123");
    },
  );

  it("clears it only when the caller asks explicitly", async () => {
    await repo.create(
      ORG_A,
      generation("gen_pred", { state: "PROCESSING", providerPredictionId: "pred_123" }),
    );
    const cleared = await repo.update(ORG_A, "gen_pred", { providerPredictionId: null });
    expect(cleared.providerPredictionId).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("database-managed updatedAt and immutable identity", () => {
  it("advances updatedAt on every write", async () => {
    const created = await repo.create(ORG_A, generation("gen_touch"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const updated = await repo.update(ORG_A, "gen_touch", { state: "SUBMITTING" });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    expect(updated.createdAt).toEqual(created.createdAt);
  });

  it("leaves identity and provenance untouched through execution updates", async () => {
    // The primary guarantee is the narrow SceneGenerationUpdate type — none of
    // these fields can be expressed. This is the runtime regression guard.
    const created = await repo.create(ORG_A, generation("gen_immutable"));
    const updated = await repo.update(ORG_A, "gen_immutable", {
      state: "PROCESSING",
      providerPredictionId: "pred_x",
      outputStorageKey: "org/a/x.mp4",
    });

    expect(updated.id).toBe(created.id);
    expect(updated.videoProjectId).toBe(created.videoProjectId);
    expect(updated.sourceStoryboardSceneId).toBe(created.sourceStoryboardSceneId);
    expect(updated.assetId).toBe(created.assetId);
    expect(updated.sourceAnalysisRevision).toBe(created.sourceAnalysisRevision);
    expect(updated.requestHash).toBe(created.requestHash);
    expect(updated.providerName).toBe(created.providerName);
    expect(updated.providerModelId).toBe(created.providerModelId);
  });
});

describe.skipIf(!HAS_DB)("active-request conflict translation", () => {
  it("accepts the first active attempt", async () => {
    const created = await repo.create(ORG_A, generation("gen_first"));
    expect(created.id).toBe("gen_first");
  });

  it.each(["QUEUED", "SUBMITTING", "PROCESSING", "FAILED_RETRYABLE", "SUBMISSION_UNKNOWN"] as const)(
    "raises the neutral conflict when an attempt is already %s",
    async (state: SceneGenerationState) => {
      await repo.create(ORG_A, generation("gen_holder", { state }));
      const error = await rejectionOf(repo.create(ORG_A, generation("gen_second")));
      expect(error).toBeInstanceOf(ActiveGenerationConflictError);
    },
  );

  it("exposes no Prisma, code, index name, or database text", async () => {
    await repo.create(ORG_A, generation("gen_holder"));
    const error = (await rejectionOf(repo.create(ORG_A, generation("gen_second")))) as Error & {
      code?: unknown;
    };
    const text = `${error.name} ${error.message} ${JSON.stringify(error)}`;
    expect(text).not.toContain("P2002");
    expect(text).not.toContain("Prisma");
    expect(text).not.toContain("scene_generations_active_request_key");
    expect(text).not.toContain("Unique constraint");
    expect(error.code).toBeUndefined();
  });

  it.each(["SUCCEEDED", "FAILED_TERMINAL", "CANCELLED"] as const)(
    "permits a new active attempt once the previous one is %s",
    async (state: SceneGenerationState) => {
      await repo.create(ORG_A, generation("gen_done", { state }));
      const next = await repo.create(ORG_A, generation("gen_next"));
      expect(next.id).toBe("gen_next");
    },
  );
});

describe.skipIf(!HAS_DB)("errors that must NOT be translated", () => {
  it("propagates a duplicate primary key, which is also P2002", async () => {
    // The sharpest over-translation guard available: same error code, different
    // covered fields. Recognition is by exact target set, so this must not
    // become a conflict — a worker retrying on it would be retrying the wrong
    // thing.
    await repo.create(ORG_A, generation("gen_dup"));
    const error = (await rejectionOf(
      repo.create(ORG_A, generation("gen_dup", { requestHash: "sha256:different" })),
    )) as { code?: string };

    expect(error).not.toBeInstanceOf(ActiveGenerationConflictError);
    expect(error).not.toBeInstanceOf(SceneGenerationNotFoundError);
    expect(error.code).toBe("P2002");
  });

  it("keeps the video-project foreign key live and untranslated", async () => {
    // Since the tenant-boundary fix, a nonexistent project is caught by the
    // ownership check and correctly surfaces as SceneGenerationNotFoundError —
    // "no project of yours has that id" is exactly what happened. That makes
    // the FK unreachable through `create`, so it is exercised directly here to
    // prove the database guarantee is still live and that nothing in this
    // milestone started swallowing it.
    //
    // It also proves the narrowness from the other side: translateWriteError
    // checks `code === "P2002"` first, so a P2003 cannot become a conflict no
    // matter which fields it names.
    const error = (await prisma.sceneGeneration
      .create({ data: generation("gen_fk", { videoProjectId: "vpr_nonexistent" }) })
      .then(
        () => null,
        (e: unknown) => e as { code?: string },
      ))!;

    expect(error.code).toBe("P2003");
    expect(error).not.toBeInstanceOf(ActiveGenerationConflictError);
    expect(error).not.toBeInstanceOf(SceneGenerationNotFoundError);
  });

  it("does not turn a not-found refusal into a database error, or the reverse", async () => {
    // The two neutral errors must stay distinct: one means "not yours or not
    // there", the other means the write collided. A future worker classifies a
    // retry on exactly that difference.
    const notFound = await rejectionOf(
      repo.create(ORG_A, generation("gen_nf", { videoProjectId: PROJECT_B })),
    );
    await repo.create(ORG_A, generation("gen_c1"));
    const conflict = await rejectionOf(repo.create(ORG_A, generation("gen_c2")));

    expect(notFound).toBeInstanceOf(SceneGenerationNotFoundError);
    expect(notFound).not.toBeInstanceOf(ActiveGenerationConflictError);
    expect(conflict).toBeInstanceOf(ActiveGenerationConflictError);
    expect(conflict).not.toBeInstanceOf(SceneGenerationNotFoundError);
  });
});

/**
 * Phase 4B-1c: the immutable request snapshot, proven against real PostgreSQL.
 *
 * Nullability, integer vs text mapping, and "an absent update key leaves the
 * column alone" are all database behaviours, not TypeScript ones, so they are
 * verified here rather than inferred from the in-memory double.
 */
describe.skipIf(!HAS_DB)("request snapshot persistence", () => {
  // No local hooks: the file-level beforeEach already cleans and re-seeds the
  // tenants, and adding another cleanup here would run after it and delete them.

  it("round-trips all five snapshot fields through create and read", async () => {
    const created = await repo.create(ORG_A, generation("gen_snap"));

    expect(created.requestCompiledPrompt).toBe(
      '{"preservation":[],"sceneFacts":{},"userCustomization":null}',
    );
    expect(created.requestDurationSeconds).toBe(5);
    expect(created.requestCameraMotion).toBe("SLOW_PAN");
    expect(created.requestAspectRatio).toBe("16:9");
    expect(created.requestResolution).toBe("1080p");

    // And the same values come back on a fresh read, not just from the insert.
    const read = (await repo.findById(ORG_A, "gen_snap"))!;
    expect(read.requestCompiledPrompt).toBe(created.requestCompiledPrompt);
    expect(read.requestDurationSeconds).toBe(5);
    expect(read.requestCameraMotion).toBe("SLOW_PAN");
    expect(read.requestAspectRatio).toBe("16:9");
    expect(read.requestResolution).toBe("1080p");
  });

  it("stores a legacy row with a null snapshot and reads it back as null", async () => {
    // The migration adds nullable columns and backfills nothing, so a row that
    // predates the contract must remain representable and must NOT acquire
    // fabricated values.
    await repo.create(
      ORG_A,
      generation("gen_legacy_db", {
        requestCompiledPrompt: null,
        requestDurationSeconds: null,
        requestCameraMotion: null,
        requestAspectRatio: null,
        requestResolution: null,
      }),
    );

    const read = (await repo.findById(ORG_A, "gen_legacy_db"))!;
    expect(read.requestCompiledPrompt).toBeNull();
    expect(read.requestDurationSeconds).toBeNull();
    expect(read.requestCameraMotion).toBeNull();
    expect(read.requestAspectRatio).toBeNull();
    expect(read.requestResolution).toBeNull();
  });

  it("preserves the snapshot across an execution-field update", async () => {
    await repo.create(ORG_A, generation("gen_upd"));
    const updated = await repo.update(ORG_A, "gen_upd", {
      state: "PROCESSING",
      providerPredictionId: "pred_db_1",
      submittedAt: new Date("2026-08-15T00:00:00.000Z"),
    });

    expect(updated.state).toBe("PROCESSING");
    expect(updated.providerPredictionId).toBe("pred_db_1");
    // Untouched — SceneGenerationUpdate cannot express these, and the adapter
    // enumerates only the mutable set.
    expect(updated.requestCompiledPrompt).toBe(
      '{"preservation":[],"sceneFacts":{},"userCustomization":null}',
    );
    expect(updated.requestDurationSeconds).toBe(5);
    expect(updated.requestCameraMotion).toBe("SLOW_PAN");
    expect(updated.requestAspectRatio).toBe("16:9");
    expect(updated.requestResolution).toBe("1080p");
  });

  it("returns the snapshot from the active and latest-succeeded lookups too", async () => {
    // Both lookups are separate queries; each must map the new columns.
    await repo.create(ORG_A, generation("gen_active_snap"));
    const active = (await repo.findActiveByRequestIdentity(ORG_A, PROJECT_A, HASH))!;
    expect(active.requestAspectRatio).toBe("16:9");
    expect(active.requestDurationSeconds).toBe(5);

    await repo.update(ORG_A, "gen_active_snap", { state: "SUCCEEDED" });
    const succeeded = (await repo.findLatestSucceededByRequestIdentity(ORG_A, PROJECT_A, HASH))!;
    expect(succeeded.requestCompiledPrompt).toBe(active.requestCompiledPrompt);
    expect(succeeded.requestResolution).toBe("1080p");
  });

  it("keeps an integer duration an integer, not a string", async () => {
    const created = await repo.create(ORG_A, generation("gen_int", { requestDurationSeconds: 17 }));
    expect(created.requestDurationSeconds).toBe(17);
    expect(typeof created.requestDurationSeconds).toBe("number");
  });
});
