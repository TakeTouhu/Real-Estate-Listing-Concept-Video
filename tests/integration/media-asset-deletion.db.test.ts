import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaPropertyRepositories, createPrismaReviewTransaction } from "@app/database";
import { createPrismaAnalysisRepository } from "@app/database";
import type { MediaAsset } from "@app/domain";

/**
 * Deletion-intent monotonicity against live PostgreSQL.
 *
 * The properties here are decided by a single conditional `UPDATE`'s `WHERE`
 * clause, so PostgreSQL is the only thing that can demonstrate them. An
 * in-memory double can show that a predicate was *written*; it cannot show that
 * the database refused the row.
 *
 * The recurring shape is a **stale snapshot**: an entity read before a deletion
 * request, then used afterwards. That is not contrived — it is exactly what
 * `AssetService.completeUpload` holds while it scans, processes an image and
 * writes two storage objects.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const ORG_A = "org_itest_del_a";
const ORG_B = "org_itest_del_b";
const PROP_A = "prp_itest_del_a";
const PROP_B = "prp_itest_del_b";
const ASSET = "ast_itest_del";

const prisma = new PrismaClient();
const { assets } = createPrismaPropertyRepositories(prisma);
const analyses = createPrismaAnalysisRepository(prisma);
const reviewTx = createPrismaReviewTransaction(prisma);

async function seedTenant(organizationId: string, propertyId: string): Promise<void> {
  await prisma.organization.create({
    data: { id: organizationId, name: organizationId, slug: organizationId },
  });
  await prisma.property.create({
    data: {
      id: propertyId,
      organizationId,
      name: "Fixture",
      propertyType: "APARTMENT",
      createdBy: "usr_itest_del",
    },
  });
}

function seedAsset(
  id: string,
  organizationId: string,
  propertyId: string,
  status: MediaAsset["status"] = "PROCESSING",
) {
  return prisma.mediaAsset.create({
    data: {
      id,
      organizationId,
      propertyId,
      storageKey: `org/${organizationId}/p/${id}/original.bin`,
      originalFilename: "seed.jpg",
      mimeType: "image/jpeg",
      status,
      createdBy: "usr_itest_del",
    },
  });
}

/** The durable row as the domain sees it — the stale snapshot's source. */
async function read(organizationId: string, id: string): Promise<MediaAsset> {
  return (await assets.findById(organizationId, id))!;
}

async function cleanup(): Promise<void> {
  const organizationId = { in: [ORG_A, ORG_B] };
  await prisma.assetAnalysis.deleteMany({ where: { organizationId } });
  await prisma.mediaAsset.deleteMany({ where: { organizationId } });
  await prisma.property.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

beforeEach(async () => {
  if (!HAS_DB) return;
  await cleanup();
  await seedTenant(ORG_A, PROP_A);
  await seedTenant(ORG_B, PROP_B);
});

afterAll(async () => {
  if (HAS_DB) await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!HAS_DB)("updateIfCurrent against PostgreSQL", () => {
  it("refuses a row belonging to another organization", async () => {
    await seedAsset(ASSET, ORG_B, PROP_B);
    const foreign = await read(ORG_B, ASSET);

    // The organization is in the write predicate, not only in the read that
    // produced this entity — so a caller that obtained a row by any other route
    // still cannot write it under the wrong tenant.
    const result = await assets.updateIfCurrent(
      { ...foreign, organizationId: ORG_A, status: "READY" },
      "PROCESSING",
    );

    expect(result).toBeNull();
    expect((await prisma.mediaAsset.findUnique({ where: { id: ASSET } }))!.status).toBe(
      "PROCESSING",
    );
  });

  it("refuses a stale writer after deletion has won, preserving every field", async () => {
    // The core monotonicity proof.
    await seedAsset(ASSET, ORG_A, PROP_A);
    const stale = await read(ORG_A, ASSET);
    expect(stale.deletionRequestedAt).toBeNull();

    const requestedAt = new Date("2026-03-01T00:00:00.000Z");
    expect(await assets.requestDeletion(ORG_A, ASSET, requestedAt)).not.toBeNull();
    const afterDeletion = await prisma.mediaAsset.findUnique({ where: { id: ASSET } });

    const result = await assets.updateIfCurrent({ ...stale, status: "READY" }, "PROCESSING");

    expect(result).toBeNull();
    const after = await prisma.mediaAsset.findUnique({ where: { id: ASSET } });
    expect(after!.deletionRequestedAt).toEqual(requestedAt);
    expect(after!.status).toBe("DELETION_PENDING");
    // Not just the two deletion columns: the deletion winner's whole row stands.
    expect(after).toEqual(afterDeletion);
  });

  it("cannot resurrect a deleted asset as READY", async () => {
    // The stale snapshot carries everything a finished `completeUpload` would
    // write — a new normalized key, a hash, dimensions, and READY.
    await seedAsset(ASSET, ORG_A, PROP_A);
    const stale = await read(ORG_A, ASSET);
    await assets.requestDeletion(ORG_A, ASSET, new Date("2026-03-01T00:00:00.000Z"));

    const result = await assets.updateIfCurrent(
      {
        ...stale,
        storageKey: `org/${ORG_A}/p/${ASSET}/normalized.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: 4,
        width: 1600,
        height: 1200,
        sha256: "a".repeat(64),
        perceptualHash: "0f0f0f0f0f0f0f0f",
        status: "READY",
        failureReason: null,
      },
      "PROCESSING",
    );

    expect(result).toBeNull();
    const after = await prisma.mediaAsset.findUnique({ where: { id: ASSET } });
    expect(after!.status).not.toBe("READY");
    expect(after!.status).toBe("DELETION_PENDING");
    expect(after!.storageKey).toBe(stale.storageKey);
  });

  it("cannot clear deletion intent even when the caller passes null", async () => {
    await seedAsset(ASSET, ORG_A, PROP_A);
    const stale = await read(ORG_A, ASSET);
    await assets.requestDeletion(ORG_A, ASSET, new Date("2026-03-01T00:00:00.000Z"));

    // `deletionRequestedAt: null` is not merely rejected by the predicate — the
    // column is absent from the written data, so no path writes it.
    const result = await assets.updateIfCurrent(
      { ...stale, deletionRequestedAt: null, status: "FAILED" },
      "PROCESSING",
    );

    expect(result).toBeNull();
    expect(
      (await prisma.mediaAsset.findUnique({ where: { id: ASSET } }))!.deletionRequestedAt,
    ).not.toBeNull();
  });

  it("refuses on deletion intent alone, when the status predicate would allow it", async () => {
    // The one case that isolates the deletion guard.
    //
    // In every other test here the status has *also* moved — `requestDeletion`
    // sets `DELETION_PENDING` — so the expected-status predicate rejects the
    // stale writer on its own and the deletion guard is never load-bearing.
    // Removing the guard would leave all of them passing.
    //
    // The invariant is stated on the column, not on the status: once
    // `deletionRequestedAt` is non-null, ordinary lifecycle work is over. This
    // seeds exactly that — intent recorded while the status is still an
    // ordinary one, which is what any future two-phase deletion, or any writer
    // that marks intent before moving the row, would produce.
    await seedAsset(ASSET, ORG_A, PROP_A);
    const stale = await read(ORG_A, ASSET);
    await prisma.mediaAsset.update({
      where: { id: ASSET },
      data: { deletionRequestedAt: new Date("2026-03-01T00:00:00.000Z") },
    });

    // `PROCESSING` is still the durable status, so only the deletion guard can
    // refuse this.
    const result = await assets.updateIfCurrent({ ...stale, status: "READY" }, "PROCESSING");

    expect(result).toBeNull();
    const after = await prisma.mediaAsset.findUnique({ where: { id: ASSET } });
    expect(after!.status).toBe("PROCESSING");
    expect(after!.deletionRequestedAt).not.toBeNull();
  });

  it("gives exactly one winner to competing lifecycle writers with different targets", async () => {
    // Both believe the row is PROCESSING. The first to commit moves it, and the
    // second's predicate no longer matches. This is an expected-status check,
    // not a version counter — it discriminates only because the winner changes
    // the status.
    await seedAsset(ASSET, ORG_A, PROP_A);
    const snapshot = await read(ORG_A, ASSET);

    const results = await Promise.all([
      assets.updateIfCurrent({ ...snapshot, status: "READY" }, "PROCESSING"),
      assets.updateIfCurrent({ ...snapshot, status: "FAILED" }, "PROCESSING"),
    ]);

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    const after = await prisma.mediaAsset.findUnique({ where: { id: ASSET } });
    expect(after!.status).toBe(winners[0]!.status);
  });

  it("cannot establish deletion intent, even on a write it wins", async () => {
    // The other half of "ordinary mutation must not write deletionRequestedAt",
    // and the half the predicate cannot enforce. Here the writer *wins* — the
    // durable row still has null intent — but its snapshot carries a non-null
    // value. If the column were in the written data, this ordinary lifecycle
    // call would establish deletion intent, bypassing `requestDeletion`
    // entirely and skipping the audit entry that records who asked.
    await seedAsset(ASSET, ORG_A, PROP_A);
    const current = await read(ORG_A, ASSET);

    const result = await assets.updateIfCurrent(
      {
        ...current,
        deletionRequestedAt: new Date("2026-03-01T00:00:00.000Z"),
        status: "READY",
      },
      "PROCESSING",
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe("READY");
    expect(result!.deletionRequestedAt).toBeNull();
    expect(
      (await prisma.mediaAsset.findUnique({ where: { id: ASSET } }))!.deletionRequestedAt,
    ).toBeNull();
  });

  it("succeeds and advances updatedAt when the predicate holds", async () => {
    // Guards the guard: if the predicate refused everything, every assertion
    // above would pass vacuously.
    await seedAsset(ASSET, ORG_A, PROP_A);
    const current = await read(ORG_A, ASSET);

    const result = await assets.updateIfCurrent({ ...current, status: "READY" }, "PROCESSING");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("READY");
    expect(result!.deletionRequestedAt).toBeNull();
    expect(result!.updatedAt.getTime()).toBeGreaterThanOrEqual(current.updatedAt.getTime());
  });
});

describe.skipIf(!HAS_DB)("requestDeletion against PostgreSQL", () => {
  it("gives exactly one winner to two concurrent requests", async () => {
    await seedAsset(ASSET, ORG_A, PROP_A);
    const first = new Date("2026-03-01T00:00:00.000Z");
    const second = new Date("2026-03-02T00:00:00.000Z");

    const results = await Promise.all([
      assets.requestDeletion(ORG_A, ASSET, first),
      assets.requestDeletion(ORG_A, ASSET, second),
    ]);

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const after = await prisma.mediaAsset.findUnique({ where: { id: ASSET } });
    expect(after!.status).toBe("DELETION_PENDING");
    // The durable timestamp is the winner's, not whichever call returned last.
    expect(after!.deletionRequestedAt).toEqual(winners[0]!.deletionRequestedAt);
    expect([first, second]).toContainEqual(after!.deletionRequestedAt);
  });

  it("refuses to revive a DELETED row", async () => {
    await seedAsset(ASSET, ORG_A, PROP_A, "DELETED");

    expect(await assets.requestDeletion(ORG_A, ASSET, new Date())).toBeNull();
    expect((await prisma.mediaAsset.findUnique({ where: { id: ASSET } }))!.status).toBe("DELETED");
  });

  it("refuses an asset in another organization", async () => {
    await seedAsset(ASSET, ORG_B, PROP_B);

    expect(await assets.requestDeletion(ORG_A, ASSET, new Date())).toBeNull();
    const after = await prisma.mediaAsset.findUnique({ where: { id: ASSET } });
    expect(after!.deletionRequestedAt).toBeNull();
    expect(after!.status).toBe("PROCESSING");
  });

  it("writes only the two deletion-owned columns", async () => {
    await seedAsset(ASSET, ORG_A, PROP_A, "READY");
    const before = await prisma.mediaAsset.findUnique({ where: { id: ASSET } });

    const requestedAt = new Date("2026-03-01T00:00:00.000Z");
    await assets.requestDeletion(ORG_A, ASSET, requestedAt);

    const after = await prisma.mediaAsset.findUnique({ where: { id: ASSET } });
    // A deletion request must not disturb the storage key, hashes or dimensions
    // an in-flight lifecycle writer may still be reading.
    expect({
      ...after!,
      status: before!.status,
      deletionRequestedAt: before!.deletionRequestedAt,
      updatedAt: before!.updatedAt,
    }).toEqual(before);
  });
});

describe.skipIf(!HAS_DB)("review rejection against PostgreSQL", () => {
  it("rolls the analysis decision back when deletion won the asset", async () => {
    await seedAsset(ASSET, ORG_A, PROP_A, "READY");
    const created = await analyses.create({
      id: "ana_itest_del",
      organizationId: ORG_A,
      assetId: ASSET,
      provider: "deterministic",
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
    const staleAsset = await read(ORG_A, ASSET);
    await assets.requestDeletion(ORG_A, ASSET, new Date("2026-03-01T00:00:00.000Z"));

    // The shape `AnalysisService.reject` uses: both writes in one transaction,
    // throwing inside it when the guarded asset write loses.
    await expect(
      reviewTx.run(async ({ analyses: txAnalyses, assets: txAssets }) => {
        const analysis = (await txAnalyses.findById(ORG_A, created.id))!;
        await txAnalyses.update({ ...analysis, reviewStatus: "REJECTED", reviewNote: "blurry" });
        const updated = await txAssets.updateIfCurrent(
          { ...staleAsset, status: "REJECTED" },
          staleAsset.status,
        );
        if (updated === null) throw new Error("asset write lost");
        return updated;
      }),
    ).rejects.toThrow(/asset write lost/);

    // PostgreSQL rolled the analysis write back with it: no split decision.
    expect((await analyses.findById(ORG_A, created.id))!.reviewStatus).toBe("UNREVIEWED");
    const after = await prisma.mediaAsset.findUnique({ where: { id: ASSET } });
    expect(after!.status).toBe("DELETION_PENDING");
    expect(after!.deletionRequestedAt).not.toBeNull();
  });
});
