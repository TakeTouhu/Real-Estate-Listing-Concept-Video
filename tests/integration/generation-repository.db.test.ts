import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaSceneGenerationRepository } from "@app/database";
import {
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
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("create and mapping", () => {
  it("returns the full mapped entity", async () => {
    const created = await repo.create(
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
    const created = await repo.create(generation("gen_nulls"));
    expect(created.providerPredictionId).toBeNull();
    expect(created.submittedAt).toBeNull();
    expect(created.lastPolledAt).toBeNull();
    expect(created.normalizedErrorCode).toBeNull();
    expect(created.normalizedErrorMessage).toBeNull();
    expect(created.outputStorageKey).toBeNull();
  });

  it("takes createdAt and updatedAt from persistence", async () => {
    // The caller cannot supply either — they are absent from NewSceneGeneration.
    const created = await repo.create(generation("gen_ts"));
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
    expect(created.createdAt.getTime()).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("tenant-scoped reads", () => {
  beforeEach(async () => {
    await repo.create(generation("gen_read"));
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
      await repo.create(generation("gen_active", { state }));
      const found = await repo.findActiveByRequestIdentity(ORG_A, PROJECT_A, HASH);
      expect(found?.id).toBe("gen_active");
      expect(found?.state).toBe(state);
    },
  );

  it.each(["SUCCEEDED", "FAILED_TERMINAL", "CANCELLED"] as const)(
    "does not return an attempt that is %s",
    async (state: SceneGenerationState) => {
      await repo.create(generation("gen_done", { state }));
      expect(await repo.findActiveByRequestIdentity(ORG_A, PROJECT_A, HASH)).toBeNull();
    },
  );

  it("cannot see another tenant's active attempt", async () => {
    await repo.create(generation("gen_mine"));
    expect(await repo.findActiveByRequestIdentity(ORG_B, PROJECT_A, HASH)).toBeNull();
  });

  it("is not disturbed by the same request hash in another tenant", async () => {
    await repo.create(generation("gen_a", { videoProjectId: PROJECT_A }));
    await repo.create(generation("gen_b", { id: "gen_b", videoProjectId: PROJECT_B }));

    expect((await repo.findActiveByRequestIdentity(ORG_A, PROJECT_A, HASH))?.id).toBe("gen_a");
    expect((await repo.findActiveByRequestIdentity(ORG_B, PROJECT_B, HASH))?.id).toBe("gen_b");
  });

  it("returns null for a request hash nobody has attempted", async () => {
    await repo.create(generation("gen_a"));
    expect(await repo.findActiveByRequestIdentity(ORG_A, PROJECT_A, "sha256:other")).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("tenant-scoped update", () => {
  beforeEach(async () => {
    await repo.create(generation("gen_upd"));
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
    await repo.create(generation("gen_fields"));
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
        generation("gen_pred", { state: "PROCESSING", providerPredictionId: "pred_123" }),
      );
      const moved = await repo.update(ORG_A, "gen_pred", { state });
      expect(moved.providerPredictionId).toBe("pred_123");
    },
  );

  it("clears it only when the caller asks explicitly", async () => {
    await repo.create(
      generation("gen_pred", { state: "PROCESSING", providerPredictionId: "pred_123" }),
    );
    const cleared = await repo.update(ORG_A, "gen_pred", { providerPredictionId: null });
    expect(cleared.providerPredictionId).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("database-managed updatedAt and immutable identity", () => {
  it("advances updatedAt on every write", async () => {
    const created = await repo.create(generation("gen_touch"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const updated = await repo.update(ORG_A, "gen_touch", { state: "SUBMITTING" });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    expect(updated.createdAt).toEqual(created.createdAt);
  });

  it("leaves identity and provenance untouched through execution updates", async () => {
    // The primary guarantee is the narrow SceneGenerationUpdate type — none of
    // these fields can be expressed. This is the runtime regression guard.
    const created = await repo.create(generation("gen_immutable"));
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
    const created = await repo.create(generation("gen_first"));
    expect(created.id).toBe("gen_first");
  });

  it.each(["QUEUED", "SUBMITTING", "PROCESSING", "FAILED_RETRYABLE", "SUBMISSION_UNKNOWN"] as const)(
    "raises the neutral conflict when an attempt is already %s",
    async (state: SceneGenerationState) => {
      await repo.create(generation("gen_holder", { state }));
      const error = await rejectionOf(repo.create(generation("gen_second")));
      expect(error).toBeInstanceOf(ActiveGenerationConflictError);
    },
  );

  it("exposes no Prisma, code, index name, or database text", async () => {
    await repo.create(generation("gen_holder"));
    const error = (await rejectionOf(repo.create(generation("gen_second")))) as Error & {
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
      await repo.create(generation("gen_done", { state }));
      const next = await repo.create(generation("gen_next"));
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
    await repo.create(generation("gen_dup"));
    const error = (await rejectionOf(
      repo.create(generation("gen_dup", { requestHash: "sha256:different" })),
    )) as { code?: string };

    expect(error).not.toBeInstanceOf(ActiveGenerationConflictError);
    expect(error).not.toBeInstanceOf(SceneGenerationNotFoundError);
    expect(error.code).toBe("P2002");
  });

  it("propagates a foreign-key failure rather than calling it not-found", async () => {
    // A missing project is a database failure, not "the row is not yours".
    // Flattening it would corrupt a worker's retry classification.
    const error = (await rejectionOf(
      repo.create(generation("gen_orphan", { videoProjectId: "vpr_nonexistent" })),
    )) as { code?: string };

    expect(error).not.toBeInstanceOf(ActiveGenerationConflictError);
    expect(error).not.toBeInstanceOf(SceneGenerationNotFoundError);
    expect(error.code).toBe("P2003");
  });
});
