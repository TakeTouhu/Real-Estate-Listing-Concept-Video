import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaAnalysisRepository, createPrismaReviewTransaction } from "@app/database";

/**
 * Live-PostgreSQL tests for the review infrastructure: approvals in one
 * duplicate group are independent (the partial unique index that once allowed
 * only one was dropped by migration 24, ADR-0063), and the transaction boundary
 * stops a rejection from partially committing.
 */
const ORG_A = "org_itest_review_a";
const ORG_B = "org_itest_review_b";
const PROPERTY_A = "prp_itest_review_a";
const GROUP = "dup_itest_review";

const prisma = new PrismaClient();
const repo = createPrismaAnalysisRepository(prisma);
const reviewTx = createPrismaReviewTransaction(prisma);

async function seedAsset(id: string, organizationId = ORG_A): Promise<void> {
  await prisma.mediaAsset.create({
    data: {
      id,
      organizationId,
      propertyId: PROPERTY_A,
      storageKey: `org/${organizationId}/p/${id}.jpg`,
      originalFilename: "seed.jpg",
      mimeType: "image/jpeg",
      status: "READY",
      createdBy: "usr_itest_review",
    },
  });
}

function row(id: string, assetId: string, organizationId = ORG_A, duplicateGroup = GROUP) {
  return {
    id,
    organizationId,
    assetId,
    provider: "deterministic",
    status: "SUCCEEDED" as const,
    roomType: "KITCHEN" as const,
    confidence: 0.9,
    qualityScore: 0.8,
    brightnessScore: 0.5,
    blurScore: 0.1,
    duplicateGroup,
    detectedObjects: [],
    safetyFlags: [],
    suggestedOrder: 5,
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

async function cleanup(): Promise<void> {
  await prisma.mediaAsset.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.property.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanup();
  await prisma.property.create({
    data: {
      id: PROPERTY_A,
      organizationId: ORG_A,
      name: "Review fixture",
      propertyType: "APARTMENT",
      createdBy: "usr_itest_review",
    },
  });
  await seedAsset("ast_rv_1");
  await seedAsset("ast_rv_2");
});

describe("review columns", () => {
  it("round-trips review state and defaults a new row to UNREVIEWED revision 1", async () => {
    const created = await repo.create(row("ana_rv_1", "ast_rv_1"));
    expect(created.reviewStatus).toBe("UNREVIEWED");
    expect(created.analysisRevision).toBe(1);
    expect(created.reviewNote).toBeNull();

    const reviewedAt = new Date("2026-07-29T00:00:00.000Z");
    const updated = await repo.update({
      ...created,
      analysisRevision: 2,
      reviewStatus: "REJECTED",
      reviewNote: "Blurry beyond use",
      reviewedBy: "usr_reviewer",
      reviewedAt,
    });
    expect(updated.reviewStatus).toBe("REJECTED");
    expect(updated.analysisRevision).toBe(2);

    const reread = await repo.findById(ORG_A, "ana_rv_1");
    expect(reread?.reviewNote).toBe("Blurry beyond use");
    expect(reread?.reviewedBy).toBe("usr_reviewer");
    expect(reread?.reviewedAt?.toISOString()).toBe(reviewedAt.toISOString());
  });
});

describe("approvals in one duplicate group are independent", () => {
  it("stores a second APPROVED analysis in the same duplicate group", async () => {
    const first = await repo.create(row("ana_rv_1", "ast_rv_1"));
    await repo.update({ ...first, reviewStatus: "APPROVED" });

    const second = await repo.create(row("ana_rv_2", "ast_rv_2"));
    await repo.update({ ...second, reviewStatus: "APPROVED" });

    expect((await repo.findById(ORG_A, "ana_rv_1"))?.reviewStatus).toBe("APPROVED");
    expect((await repo.findById(ORG_A, "ana_rv_2"))?.reviewStatus).toBe("APPROVED");
  });

  it("permits many UNREVIEWED and REJECTED members in one group", async () => {
    const first = await repo.create(row("ana_rv_1", "ast_rv_1"));
    const second = await repo.create(row("ana_rv_2", "ast_rv_2"));
    await repo.update({ ...first, reviewStatus: "REJECTED", reviewNote: "dup" });
    await repo.update({ ...second, reviewStatus: "REJECTED", reviewNote: "dup" });

    expect((await repo.findById(ORG_A, "ana_rv_2"))?.reviewStatus).toBe("REJECTED");
  });
});

describe("review transaction", () => {
  it("commits the analysis and asset writes together", async () => {
    const created = await repo.create(row("ana_rv_1", "ast_rv_1"));

    await reviewTx.run(async ({ analyses, assets }) => {
      const analysis = (await analyses.findById(ORG_A, created.id))!;
      await analyses.update({ ...analysis, reviewStatus: "REJECTED", reviewNote: "blurry" });
      const asset = (await assets.findById(ORG_A, "ast_rv_1"))!;
      await assets.updateIfCurrent({ ...asset, status: "REJECTED" }, asset.status);
    });

    expect((await repo.findById(ORG_A, created.id))?.reviewStatus).toBe("REJECTED");
    expect(
      (await prisma.mediaAsset.findUnique({ where: { id: "ast_rv_1" } }))?.status,
    ).toBe("REJECTED");
  });

  it("commits neither write when the unit of work throws", async () => {
    const created = await repo.create(row("ana_rv_1", "ast_rv_1"));

    await expect(
      reviewTx.run(async ({ analyses, assets }) => {
        const analysis = (await analyses.findById(ORG_A, created.id))!;
        await analyses.update({ ...analysis, reviewStatus: "REJECTED", reviewNote: "blurry" });
        const asset = (await assets.findById(ORG_A, "ast_rv_1"))!;
        await assets.updateIfCurrent({ ...asset, status: "REJECTED" }, asset.status);
        throw new Error("second write failed");
      }),
    ).rejects.toThrow(/second write failed/);

    // PostgreSQL rolled the whole unit back: no partially applied rejection.
    expect((await repo.findById(ORG_A, created.id))?.reviewStatus).toBe("UNREVIEWED");
    expect(
      (await prisma.mediaAsset.findUnique({ where: { id: "ast_rv_1" } }))?.status,
    ).toBe("READY");
  });
});
