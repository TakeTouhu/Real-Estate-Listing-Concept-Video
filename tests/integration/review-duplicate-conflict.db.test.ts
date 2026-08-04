import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AnalysisService } from "@app/domain";
import { AppError } from "@app/shared";
import type { AnalysisRequest, AnalysisResult, ImageAnalysisProvider } from "@app/domain";
import {
  createPrismaAnalysisRepository,
  createPrismaIdentityRepositories,
  createPrismaPropertyRepositories,
  createPrismaReviewTransaction,
} from "@app/database";
import { fakePasswordHasher, fakeTokenService, TestClock } from "@app/domain/testing";
import { LocalObjectStorage } from "@app/storage";

/**
 * Proves the duplicate-approval conflict is translated correctly by the real
 * runtime path: AnalysisService -> Prisma repositories -> PostgreSQL partial
 * unique index -> adapter translation -> AppError("VALIDATION_FAILED").
 *
 * A direct constraint test or an in-memory simulation cannot show this: the
 * first would skip the service and the adapter, the second would skip the
 * database that actually refuses the write.
 */
const ORG = "org_itest_dupconf";
const PROPERTY = "prp_itest_dupconf";
const ASSET_A = "ast_itest_dupconf_a";
const ASSET_B = "ast_itest_dupconf_b";
const REVIEWER = "usr_itest_dupconf";
const GROUP = "dup_itest_dupconf";

const prisma = new PrismaClient();

/** Returns the same result for every asset, so both land in one duplicate group. */
class FixedProvider implements ImageAnalysisProvider {
  readonly name = "fixed";
  analyze(_request: AnalysisRequest): Promise<AnalysisResult> {
    return Promise.resolve({
      roomType: "KITCHEN",
      confidence: 0.9,
      qualityScore: 0.8,
      brightnessScore: 0.5,
      blurScore: 0.1,
      detectedObjects: [],
      safetyFlags: [],
    });
  }
  normalizeError() {
    return {
      kind: "PROVIDER" as const,
      retryable: true,
      code: "e",
      messageSanitized: "Analysis provider failed",
    };
  }
}

const clock = new TestClock();
const identityRepos = createPrismaIdentityRepositories(prisma);
const propertyRepos = createPrismaPropertyRepositories(prisma);
const analyses = createPrismaAnalysisRepository(prisma);

const service = new AnalysisService({
  identity: {
    repos: identityRepos,
    clock,
    ids: { generate: (p) => `${p}_${Math.random().toString(36).slice(2, 12)}` },
    passwords: fakePasswordHasher,
    tokens: fakeTokenService(),
  },
  assets: propertyRepos.assets,
  analyses,
  storage: new LocalObjectStorage({ secret: "itest-secret-0000000000000000" }),
  provider: new FixedProvider(),
  reviewTx: createPrismaReviewTransaction(prisma),
  clock,
  ids: { generate: (p) => `${p}_${Math.random().toString(36).slice(2, 12)}` },
});

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
  await prisma.mediaAsset.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.membership.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.user.deleteMany({ where: { id: REVIEWER } });
}

/** Seed an asset plus a SUCCEEDED analysis already sharing the duplicate group. */
async function seedAnalyzed(assetId: string, analysisId: string): Promise<void> {
  await prisma.mediaAsset.create({
    data: {
      id: assetId,
      organizationId: ORG,
      propertyId: PROPERTY,
      storageKey: `org/${ORG}/p/${assetId}.jpg`,
      originalFilename: "seed.jpg",
      mimeType: "image/jpeg",
      width: 1600,
      height: 1200,
      perceptualHash: "ffffffffffffffff",
      status: "READY",
      createdBy: REVIEWER,
    },
  });
  await analyses.create({
    id: analysisId,
    organizationId: ORG,
    assetId,
    provider: "fixed",
    status: "SUCCEEDED",
    roomType: "KITCHEN",
    confidence: 0.9,
    qualityScore: 0.8,
    brightnessScore: 0.5,
    blurScore: 0.1,
    duplicateGroup: GROUP,
    detectedObjects: [],
    safetyFlags: [],
    suggestedOrder: 5,
    failureReason: null,
    roomTypeOverride: null,
    orderOverride: null,
    correctedBy: null,
    correctedAt: null,
    analysisRevision: 1,
    reviewStatus: "UNREVIEWED",
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
  });
}

/** Opt-in suite: without a test database it must skip, not fail in a hook. */
const HAS_DB = Boolean(process.env.DATABASE_URL);

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.user.create({
    data: { id: REVIEWER, email: `${REVIEWER}@example.com`, name: "Reviewer" },
  });
  await prisma.organization.create({
    data: { id: ORG, name: "Dup Conflict", slug: `slug-${ORG}` },
  });
  await prisma.membership.create({
    data: { organizationId: ORG, userId: REVIEWER, role: "REVIEWER" },
  });
  await prisma.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Fixture",
      propertyType: "APARTMENT",
      createdBy: REVIEWER,
    },
  });
  await seedAnalyzed(ASSET_A, "ana_itest_dupconf_a");
  await seedAnalyzed(ASSET_B, "ana_itest_dupconf_b");
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("duplicate-approval conflict through the real runtime path", () => {
  it("refuses the second approval with VALIDATION_FAILED and leaves both rows correct", async () => {
    const first = await service.approve(REVIEWER, ORG, ASSET_A, { primaryAssetId: ASSET_A });
    expect(first.reviewStatus).toBe("APPROVED");

    // Second approval in the same (organizationId, duplicateGroup): PostgreSQL
    // raises the partial-index violation, the Prisma adapter translates it, and
    // the service surfaces it as a validation failure.
    const error = await service
      .approve(REVIEWER, ORG, ASSET_B, { primaryAssetId: ASSET_B })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("VALIDATION_FAILED");
    expect((error as AppError).message).toMatch(/already approved/i);

    expect((await analyses.findByAssetId(ORG, ASSET_A))?.reviewStatus).toBe("APPROVED");
    expect((await analyses.findByAssetId(ORG, ASSET_B))?.reviewStatus).toBe("UNREVIEWED");
  });

  it("does not surface a raw Prisma error or the constraint name to the caller", async () => {
    await service.approve(REVIEWER, ORG, ASSET_A, { primaryAssetId: ASSET_A });
    const error = await service
      .approve(REVIEWER, ORG, ASSET_B, { primaryAssetId: ASSET_B })
      .then(
        () => null,
        (e: unknown) => e,
      );

    const text = `${(error as Error).name} ${(error as Error).message}`;
    expect(text).not.toContain("asset_analyses_org_dupgroup_approved_key");
    expect(text).not.toContain("P2002");
    expect(text).not.toContain("Invalid `prisma");
  });
});
