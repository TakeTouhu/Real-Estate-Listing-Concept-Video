import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createSceneGenerationAttemptRepository } from "@app/database";

/**
 * What the migration did to rows that were already there: nothing.
 *
 * A legacy `scene_generations` row may represent a call that was paid for, and
 * the facts this phase introduced were not recorded at the time. There is no
 * way to find out now whether a row sitting in `SUBMITTING` was accepted by the
 * provider or never reached it — so the migration declines to say. Every new
 * column stays NULL, and the code that reads them fails closed rather than
 * guessing.
 *
 * The temptation this guards against is real and specific: backfilling
 * `submissionCertainty = 'DEFINITIVELY_REJECTED'` for old failures would make
 * the data tidy and would be a fabricated claim about money.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG = "org_itest_legacy";
const PROP = "prp_itest_legacy";
const PROJECT = "vpr_itest_legacy";
const ASSET = "ast_itest_legacy";

const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);

/** A row shaped exactly as Phase 4A-2a would have written it. */
const LEGACY_ROWS = [
  { id: "sgen_legacy_queued", state: "QUEUED" as const, predictionId: null },
  { id: "sgen_legacy_submitting", state: "SUBMITTING" as const, predictionId: null },
  { id: "sgen_legacy_processing", state: "PROCESSING" as const, predictionId: "pred_legacy_1" },
  { id: "sgen_legacy_succeeded", state: "SUCCEEDED" as const, predictionId: "pred_legacy_2" },
  { id: "sgen_legacy_unknown", state: "SUBMISSION_UNKNOWN" as const, predictionId: null },
  { id: "sgen_legacy_failed", state: "FAILED_TERMINAL" as const, predictionId: null },
  { id: "sgen_legacy_cancelled", state: "CANCELLED" as const, predictionId: null },
];

describe.skipIf(!HAS_DB)("legacy scene generations are left exactly as they were", () => {
  beforeEach(async () => {
    await prisma.sceneGeneration.deleteMany({ where: { videoProjectId: PROJECT } });
    await prisma.property.upsert({
      where: { id: PROP },
      update: {},
      create: {
        id: PROP,
        organizationId: ORG,
        name: "Legacy fixture",
        propertyType: "OTHER",
        createdBy: "usr_itest",
      },
    });
    await prisma.mediaAsset.upsert({
      where: { id: ASSET },
      update: {},
      create: {
        id: ASSET,
        organizationId: ORG,
        propertyId: PROP,
        storageKey: `org/${ORG}/a/${ASSET}/normalized.jpg`,
        originalFilename: "a.jpg",
        status: "READY",
        createdBy: "usr_itest",
      },
    });
    await prisma.videoProject.upsert({
      where: { id: PROJECT },
      update: {},
      create: {
        id: PROJECT,
        organizationId: ORG,
        propertyId: PROP,
        name: "Legacy project",
        durationSeconds: 30,
        aspectRatio: "16:9",
        targetOutputResolution: "720p",
        createdBy: "usr_itest",
      },
    });

    let i = 0;
    for (const row of LEGACY_ROWS) {
      await prisma.sceneGeneration.create({
        data: {
          id: row.id,
          videoProjectId: PROJECT,
          sourceStoryboardSceneId: "sbs_legacy_gone",
          assetId: ASSET,
          sourceAnalysisRevision: 1,
          requestHash: `${"d".repeat(62)}${String(i).padStart(2, "0")}`,
          providerName: "wavespeed",
          providerModelId: "wavespeed-ai/open-video/image-to-video",
          state: row.state,
          providerPredictionId: row.predictionId,
        },
      });
      i += 1;
    }
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await prisma.sceneGeneration.deleteMany({ where: { videoProjectId: PROJECT } });
    await prisma.videoProject.deleteMany({ where: { id: PROJECT } });
    await prisma.mediaAsset.deleteMany({ where: { id: ASSET } });
    await prisma.property.deleteMany({ where: { id: PROP } });
    await prisma.$disconnect();
  });

  it("accepts every legacy state without an orchestration column", async () => {
    // The migration adds columns; it does not require them. A row written under
    // the old contract is still insertable and still readable.
    const rows = await prisma.sceneGeneration.findMany({
      where: { videoProjectId: PROJECT },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(LEGACY_ROWS.length);
    for (const row of rows) {
      expect(row.generationSceneRequestId).toBeNull();
      expect(row.attemptOrdinal).toBeNull();
      expect(row.attemptKind).toBeNull();
      expect(row.submissionCertainty).toBeNull();
      expect(row.orchestrationState).toBeNull();
      expect(row.submissionBoundaryEnteredAt).toBeNull();
      expect(row.reconciliationStartedAt).toBeNull();
      expect(row.reconciliationDeadlineAt).toBeNull();
    }
  });

  it("keeps the legacy state vocabulary rather than relabelling it", async () => {
    // `SUCCEEDED` is NOT rewritten to `PROVIDER_SUCCEEDED`, and
    // `SUBMISSION_UNKNOWN` is NOT split into a certainty plus
    // `RECONCILIATION_PENDING`. Both rewrites would be faithful-looking claims
    // about rows nobody can verify today.
    const succeeded = await prisma.sceneGeneration.findUnique({
      where: { id: "sgen_legacy_succeeded" },
    });
    expect(succeeded?.state).toBe("SUCCEEDED");
    expect(succeeded?.orchestrationState).toBeNull();

    const unknown = await prisma.sceneGeneration.findUnique({
      where: { id: "sgen_legacy_unknown" },
    });
    expect(unknown?.state).toBe("SUBMISSION_UNKNOWN");
    expect(unknown?.submissionCertainty).toBeNull();
    expect(unknown?.orchestrationState).toBeNull();
  });

  it("keeps a legacy provider reference that the new CHECK would otherwise reject", async () => {
    // The row has a prediction id and no certainty. Under the new rule that
    // pairing is impossible — but the rule applies to what certainty *says*,
    // not to rows that never had one, so history is not invalidated.
    const processing = await prisma.sceneGeneration.findUnique({
      where: { id: "sgen_legacy_processing" },
    });
    expect(processing?.providerPredictionId).toBe("pred_legacy_1");
    expect(processing?.submissionCertainty).toBeNull();
  });

  it("refuses to project a legacy row as an orchestration attempt", async () => {
    // Fails closed rather than inventing an attempt kind and a certainty. The
    // legacy row stays readable through the repository that owns it.
    const attempts = createSceneGenerationAttemptRepository(prisma);
    await expect(attempts.findById(ORG, "sgen_legacy_processing")).rejects.toThrow(
      /predates orchestration/,
    );
  });

  it("rejects a half-orchestrated row", async () => {
    // All-or-none: a row is either fully legacy or fully orchestrated. A half
    // state is where every later query has to guess which vocabulary applies.
    await expect(
      prisma.sceneGeneration.update({
        where: { id: "sgen_legacy_queued" },
        data: { attemptKind: "PRIMARY" },
      }),
    ).rejects.toThrow(/orchestration_all_or_none/);
  });

  it("still enforces the pre-existing active-request uniqueness", async () => {
    // The partial unique index from Phase 4A-2a is untouched by this migration.
    // Weakening it would reopen the duplicate-submission path it was added for.
    const existing = await prisma.sceneGeneration.findUnique({
      where: { id: "sgen_legacy_queued" },
    });
    await expect(
      prisma.sceneGeneration.create({
        data: {
          id: "sgen_legacy_dup",
          videoProjectId: PROJECT,
          sourceStoryboardSceneId: "sbs_legacy_gone",
          assetId: ASSET,
          sourceAnalysisRevision: 1,
          requestHash: existing!.requestHash,
          providerName: "wavespeed",
          providerModelId: "wavespeed-ai/open-video/image-to-video",
          state: "QUEUED",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
