import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAssetAnalysisRepository } from "./in-memory-analysis";
import { InMemoryMediaAssetRepository } from "./in-memory-property";
import { InMemoryReviewTransaction } from "./in-memory-review-transaction";
import { TestClock } from "./in-memory";
import type { AssetAnalysis } from "../analysis/types";
import type { MediaAsset } from "../property/types";

const ORG = "org_1";

function analysisRow(): Omit<AssetAnalysis, "createdAt" | "updatedAt"> {
  return {
    id: "ana_1",
    organizationId: ORG,
    assetId: "ast_1",
    provider: "stub",
    status: "SUCCEEDED",
    roomType: "KITCHEN",
    confidence: 0.9,
    qualityScore: 0.8,
    brightnessScore: 0.5,
    blurScore: 0.1,
    duplicateGroup: null,
    detectedObjects: [],
    safetyFlags: [],
    suggestedOrder: 5,
    failureReason: null,
    analysisRevision: 1,
    reviewStatus: "UNREVIEWED",
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
  };
}

function assetRow(): Omit<MediaAsset, "createdAt" | "updatedAt"> {
  return {
    id: "ast_1",
    organizationId: ORG,
    propertyId: "prp_1",
    storageKey: "k",
    originalFilename: "p.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1,
    width: 1600,
    height: 1200,
    sha256: null,
    perceptualHash: null,
    status: "READY",
    failureReason: null,
    thumbnailKey: null,
    createdBy: "usr_1",
    deletionRequestedAt: null,
    retentionExpiresAt: null,
  };
}

let clock: TestClock;
let analyses: InMemoryAssetAnalysisRepository;
let assets: InMemoryMediaAssetRepository;
let tx: InMemoryReviewTransaction;

beforeEach(async () => {
  clock = new TestClock();
  analyses = new InMemoryAssetAnalysisRepository(clock);
  assets = new InMemoryMediaAssetRepository(clock);
  tx = new InMemoryReviewTransaction(analyses, assets);
  await analyses.create(analysisRow());
  await assets.create(assetRow());
});

describe("InMemoryReviewTransaction", () => {
  it("commits both writes when the unit of work succeeds", async () => {
    await tx.run(async ({ analyses: a, assets: m }) => {
      const analysis = (await a.findById(ORG, "ana_1"))!;
      await a.update({ ...analysis, reviewStatus: "REJECTED", reviewNote: "blurry" });
      const asset = (await m.findById(ORG, "ast_1"))!;
      await m.update({ ...asset, status: "REJECTED" });
    });

    expect((await analyses.findById(ORG, "ana_1"))?.reviewStatus).toBe("REJECTED");
    expect((await assets.findById(ORG, "ast_1"))?.status).toBe("REJECTED");
  });

  it("rolls both writes back when the unit of work throws after the first", async () => {
    await expect(
      tx.run(async ({ analyses: a, assets: m }) => {
        const analysis = (await a.findById(ORG, "ana_1"))!;
        await a.update({ ...analysis, reviewStatus: "REJECTED", reviewNote: "blurry" });
        const asset = (await m.findById(ORG, "ast_1"))!;
        await m.update({ ...asset, status: "REJECTED" });
        throw new Error("asset write failed");
      }),
    ).rejects.toThrow(/asset write failed/);

    // Neither write survives: no partially applied review.
    expect((await analyses.findById(ORG, "ana_1"))?.reviewStatus).toBe("UNREVIEWED");
    expect((await analyses.findById(ORG, "ana_1"))?.reviewNote).toBeNull();
    expect((await assets.findById(ORG, "ast_1"))?.status).toBe("READY");
  });

  it("propagates the original error rather than masking it", async () => {
    const boom = new Error("original cause");
    await expect(tx.run(() => Promise.reject(boom))).rejects.toBe(boom);
  });

  it("returns the callback's value on success", async () => {
    await expect(tx.run(() => Promise.resolve("done"))).resolves.toBe("done");
  });
});
