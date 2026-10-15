import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AnalysisService } from "@app/domain";
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
 * Proves look-alike photos are approved independently on the real runtime path:
 * AnalysisService -> Prisma repositories -> PostgreSQL (ADR-0052 Decision 14,
 * ADR-0063).
 *
 * Until migration 24 a partial unique index allowed one approved photo per
 * duplicate group per organization, so approving a look-alike in another
 * Property failed with nothing on the page to explain why. An in-memory double
 * cannot show the index is gone; only the database that used to refuse the
 * write can.
 */
const ORG = "org_itest_dupconf";
const PROPERTY = "prp_itest_dupconf";
const OTHER_PROPERTY = "prp_itest_dupconf_other";
const ASSET_A = "ast_itest_dupconf_a";
const ASSET_B = "ast_itest_dupconf_b";
const ASSET_ELSEWHERE = "ast_itest_dupconf_elsewhere";
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
  properties: propertyRepos.properties,
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
async function seedAnalyzed(
  assetId: string,
  analysisId: string,
  propertyId = PROPERTY,
): Promise<void> {
  await prisma.mediaAsset.create({
    data: {
      id: assetId,
      organizationId: ORG,
      propertyId,
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
    data: { organizationId: ORG, userId: REVIEWER, role: "CREATOR" },
  });
  for (const id of [PROPERTY, OTHER_PROPERTY]) {
    await prisma.property.create({
      data: {
        id,
        organizationId: ORG,
        name: "Fixture",
        propertyType: "APARTMENT",
        createdBy: REVIEWER,
        // The CREATOR reviewing reaches only what it is responsible for (ADR-0064).
        responsibleUserId: REVIEWER,
      },
    });
  }
  await seedAnalyzed(ASSET_A, "ana_itest_dupconf_a");
  await seedAnalyzed(ASSET_B, "ana_itest_dupconf_b");
  await seedAnalyzed(ASSET_ELSEWHERE, "ana_itest_dupconf_elsewhere", OTHER_PROPERTY);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("look-alike approval through the real runtime path", () => {
  it("approves two look-alikes in one Property, each on its own", async () => {
    const first = await service.approve(REVIEWER, ORG, ASSET_A);
    const second = await service.approve(REVIEWER, ORG, ASSET_B);

    expect(first.duplicateGroup).toBe(GROUP);
    expect(second.duplicateGroup).toBe(GROUP);
    expect((await analyses.findByAssetId(ORG, ASSET_A))?.reviewStatus).toBe("APPROVED");
    expect((await analyses.findByAssetId(ORG, ASSET_B))?.reviewStatus).toBe("APPROVED");
  });

  it("approves a photo whose look-alike is already approved in another Property", async () => {
    await service.approve(REVIEWER, ORG, ASSET_ELSEWHERE);
    const approved = await service.approve(REVIEWER, ORG, ASSET_A);

    expect(approved.reviewStatus).toBe("APPROVED");
    expect((await analyses.findByAssetId(ORG, ASSET_ELSEWHERE))?.reviewStatus).toBe("APPROVED");
  });

  it("leaves the non-unique duplicate-group index and drops the unique one", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'asset_analyses'`;
    const names = rows.map((r) => r.indexname);

    expect(names).not.toContain("asset_analyses_org_dupgroup_approved_key");
    expect(names).toContain("asset_analyses_organizationId_duplicateGroup_idx");
  });
});
