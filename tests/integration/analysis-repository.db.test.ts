import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaAnalysisRepository } from "@app/database";

/**
 * Live-PostgreSQL contract test for the analysis repository. Requires
 * DATABASE_URL to point at a disposable database with migrations applied
 * (`pnpm --filter @app/database run db:migrate`).
 */
const ORG_A = "org_itest_analysis_a";
const ORG_B = "org_itest_analysis_b";
const PROPERTY_A = "prp_itest_analysis_a";
const ASSET_A1 = "ast_itest_analysis_a1";
const ASSET_A2 = "ast_itest_analysis_a2";
const ASSET_A3 = "ast_itest_analysis_a3";

const prisma = new PrismaClient();
const repo = createPrismaAnalysisRepository(prisma);

function analysisRow(id: string, assetId: string, organizationId = ORG_A) {
  return {
    id,
    organizationId,
    assetId,
    provider: "deterministic",
    status: "PENDING" as const,
    roomType: null,
    confidence: null,
    qualityScore: null,
    brightnessScore: null,
    blurScore: null,
    duplicateGroup: null,
    detectedObjects: [],
    safetyFlags: [],
    suggestedOrder: null,
    failureReason: null,
    roomTypeOverride: null,
    orderOverride: null,
    correctedBy: null,
    correctedAt: null,
    analysisRevision: 1,
    reviewStatus: "UNREVIEWED" as const,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
  };
}

async function seedAsset(id: string): Promise<void> {
  await prisma.mediaAsset.create({
    data: {
      id,
      organizationId: ORG_A,
      propertyId: PROPERTY_A,
      storageKey: `org/${ORG_A}/properties/${PROPERTY_A}/assets/${id}/normalized.jpg`,
      originalFilename: "seed.jpg",
      mimeType: "image/jpeg",
      width: 1600,
      height: 1200,
      perceptualHash: "ffffffffffffffff",
      status: "READY",
      createdBy: "usr_itest_analysis",
    },
  });
}

beforeAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.property.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.property.create({
    data: {
      id: PROPERTY_A,
      organizationId: ORG_A,
      name: "Integration fixture",
      propertyType: "APARTMENT",
      createdBy: "usr_itest_analysis",
    },
  });
  await seedAsset(ASSET_A1);
  await seedAsset(ASSET_A2);
  await seedAsset(ASSET_A3);
});

afterAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.property.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.$disconnect();
});

describe("Prisma analysis repository against live PostgreSQL", () => {
  it("round-trips a row including its JSON columns", async () => {
    const created = await repo.create(analysisRow("ana_itest_1", ASSET_A1));
    expect(created.detectedObjects).toEqual([]);

    const updated = await repo.update({
      ...created,
      status: "SUCCEEDED",
      roomType: "KITCHEN",
      confidence: 0.75,
      qualityScore: 0.5,
      duplicateGroup: "dup_itest",
      detectedObjects: [{ label: "sink", confidence: 0.9 }],
      safetyFlags: [{ code: "LOW_RESOLUTION", severity: "WARNING", message: "below 1024px" }],
      suggestedOrder: 5,
    });
    expect(updated.roomType).toBe("KITCHEN");
    expect(updated.detectedObjects).toEqual([{ label: "sink", confidence: 0.9 }]);
    expect(updated.safetyFlags).toEqual([{ code: "LOW_RESOLUTION", severity: "WARNING", message: "below 1024px" }]);

    const reread = await repo.findById(ORG_A, "ana_itest_1");
    expect(reread?.suggestedOrder).toBe(5);
    expect(reread?.duplicateGroup).toBe("dup_itest");
  });

  it("does not return a row to another organization", async () => {
    expect(await repo.findById(ORG_B, "ana_itest_1")).toBeNull();
    expect(await repo.findByAssetId(ORG_B, ASSET_A1)).toBeNull();
    expect(await repo.listByAssetIds(ORG_B, [ASSET_A1, ASSET_A2])).toEqual([]);
  });

  it("enforces the unique constraint of one analysis per asset", async () => {
    await expect(repo.create(analysisRow("ana_itest_2", ASSET_A1))).rejects.toThrow();
  });

  it("lists only the requested assets for the owning organization", async () => {
    await repo.create(analysisRow("ana_itest_3", ASSET_A2));
    const rows = await repo.listByAssetIds(ORG_A, [ASSET_A1, ASSET_A2]);
    expect(rows.map((r) => r.assetId).sort()).toEqual([ASSET_A1, ASSET_A2]);
    expect(await repo.listByAssetIds(ORG_A, [])).toEqual([]);
  });

  it("round-trips the human correction columns, including back to null", async () => {
    const created = await repo.create(analysisRow("ana_itest_corr", ASSET_A3));
    // A fresh row carries no correction.
    expect(created.roomTypeOverride).toBeNull();
    expect(created.orderOverride).toBeNull();
    expect(created.correctedBy).toBeNull();
    expect(created.correctedAt).toBeNull();

    const correctedAt = new Date("2026-08-04T12:34:56.000Z");
    const corrected = await repo.update({
      ...created,
      status: "SUCCEEDED",
      roomType: "KITCHEN",
      suggestedOrder: 5,
      roomTypeOverride: "LIVING_ROOM",
      orderOverride: 2,
      correctedBy: "usr_itest_reviewer",
      correctedAt,
    });
    expect(corrected.roomTypeOverride).toBe("LIVING_ROOM");
    expect(corrected.orderOverride).toBe(2);
    expect(corrected.correctedBy).toBe("usr_itest_reviewer");
    expect(corrected.correctedAt?.toISOString()).toBe(correctedAt.toISOString());
    // The analyzer's own output survives the correction, in the database and
    // not merely in memory.
    expect(corrected.roomType).toBe("KITCHEN");
    expect(corrected.suggestedOrder).toBe(5);

    const reread = await repo.findByAssetId(ORG_A, ASSET_A3);
    expect(reread?.roomTypeOverride).toBe("LIVING_ROOM");
    expect(reread?.orderOverride).toBe(2);
    expect(reread?.correctedAt?.toISOString()).toBe(correctedAt.toISOString());
    expect(reread?.roomType).toBe("KITCHEN");

    const cleared = await repo.update({
      ...reread!,
      roomTypeOverride: null,
      orderOverride: null,
      correctedBy: null,
      correctedAt: null,
    });
    expect(cleared.roomTypeOverride).toBeNull();
    expect(cleared.orderOverride).toBeNull();
    expect(cleared.correctedBy).toBeNull();
    expect(cleared.correctedAt).toBeNull();
    expect((await repo.findById(ORG_A, "ana_itest_corr"))?.orderOverride).toBeNull();
  });

  it("preserves corrections through an unrelated update", async () => {
    const current = await repo.findById(ORG_A, "ana_itest_corr");
    await repo.update({
      ...current!,
      roomTypeOverride: "BALCONY",
      orderOverride: 7,
      correctedBy: "usr_itest_reviewer",
      correctedAt: new Date("2026-08-04T00:00:00.000Z"),
    });

    // A write that says nothing about the corrections must not drop them: the
    // repository persists the whole row, so an approval or any other ordinary
    // update leaves a reviewer's correction intact.
    const withDecision = await repo.update({
      ...(await repo.findById(ORG_A, "ana_itest_corr"))!,
      reviewStatus: "APPROVED",
      reviewedBy: "usr_itest_reviewer",
      reviewedAt: new Date("2026-08-04T01:00:00.000Z"),
    });
    expect(withDecision.roomTypeOverride).toBe("BALCONY");
    expect(withDecision.orderOverride).toBe(7);
    expect(withDecision.correctedBy).toBe("usr_itest_reviewer");
  });

  it("persists an order priority that is zero, negative, or large", async () => {
    // Persistence stores what it is given. Which priorities are *valid* is the
    // correction service's rule (Phase 3D-2), deliberately not a column
    // constraint — the database must not encode a product rule that has not
    // been decided yet.
    const current = await repo.findById(ORG_A, "ana_itest_corr");
    for (const priority of [0, -3, 999999]) {
      const updated = await repo.update({ ...current!, orderOverride: priority });
      expect(updated.orderOverride).toBe(priority);
    }
  });

  it("cascades deletion of the analysis when its asset is deleted", async () => {
    await prisma.mediaAsset.delete({ where: { id: ASSET_A2 } });
    expect(await repo.findByAssetId(ORG_A, ASSET_A2)).toBeNull();
  });
});
