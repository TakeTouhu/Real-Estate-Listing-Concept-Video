import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  isInternalStorageKey,
  managedCleanMasterKey,
  managedDeliverableOutputKey,
} from "@app/domain";
import { createDeliverableCompositionPlanRepository } from "@app/database";
import { signStorageToken } from "@app/storage";
import {
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";
import { DIGEST, SIZE, seedPlanChain } from "./deliverable-composition-fixture";

/**
 * The Clean Master record (DS-4, ADR-0074), against live PostgreSQL.
 *
 * Nothing writes a master yet, so these tests write the rows themselves and
 * prove what the table refuses: a second master for a version, a key outside
 * the version's own place in the internal namespace, a receipt that is not one,
 * and a version deleted from under its master. Every key the table accepts is
 * one the signers refuse.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const plans = createDeliverableCompositionPlanRepository(prisma);

let seq = 0;

/** A planned deliverable version, as Transaction I leaves it. */
async function plannedVersion(): Promise<string> {
  seq += 1;
  const chain = await seedPlanChain(prisma);
  const planned = await plans.admitCompositionPlan({
    organizationId: ORG_A,
    generationJobId: chain.jobId,
    deliverableVersionId: `gdv_itest_cm_${seq}`,
    context: ctx(),
  });
  if (planned.kind !== "PLANNED") throw new Error(`fixture: plan returned ${planned.kind}`);
  return planned.deliverableVersionId;
}

function master(deliverableVersionId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `gcm_${deliverableVersionId}`,
    deliverableVersionId,
    storageKey: managedCleanMasterKey({ organizationId: ORG_A, deliverableVersionId }),
    sha256: DIGEST,
    sizeBytes: BigInt(SIZE),
    verifiedAt: new Date("2026-10-20T00:00:00.000Z"),
    ...overrides,
  };
}

const create = (data: ReturnType<typeof master>) =>
  prisma.generationDeliverableCleanMaster.create({ data: data as never });

RUN("the Clean Master record (DS-4)", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  it("requires every column, with no default but its creation time", async () => {
    const columns = await prisma.$queryRaw<{ column: string; nullable: string; fallback: string | null }[]>`
      SELECT column_name AS "column", is_nullable AS nullable, column_default AS fallback
        FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'generation_deliverable_clean_masters'
       ORDER BY ordinal_position`;
    expect(columns).toEqual([
      { column: "id", nullable: "NO", fallback: null },
      { column: "deliverableVersionId", nullable: "NO", fallback: null },
      { column: "storageKey", nullable: "NO", fallback: null },
      { column: "sha256", nullable: "NO", fallback: null },
      { column: "sizeBytes", nullable: "NO", fallback: null },
      { column: "verifiedAt", nullable: "NO", fallback: null },
      { column: "createdAt", nullable: "NO", fallback: "CURRENT_TIMESTAMP" },
    ]);
  });

  it("stores the master of a planned version, at a key no signer will sign", async () => {
    const versionId = await plannedVersion();
    await create(master(versionId));
    const stored = await prisma.generationDeliverableCleanMaster.findUniqueOrThrow({
      where: { deliverableVersionId: versionId },
      include: { deliverableVersion: { select: { cleanMaster: { select: { id: true } } } } },
    });
    expect(stored.storageKey).toBe(`org/${ORG_A}/internal/clean-masters/${versionId}`);
    expect(stored.deliverableVersion.cleanMaster?.id).toBe(stored.id);
    expect(isInternalStorageKey(stored.storageKey)).toBe(true);
    expect(() =>
      signStorageToken({ key: stored.storageKey, purpose: "download", expiresAtSeconds: 2_000_000_000 }, "s"),
    ).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
  });

  it("keeps one master per version", async () => {
    const versionId = await plannedVersion();
    await create(master(versionId));
    await expect(create(master(versionId, { id: "gcm_second" }))).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.generationDeliverableCleanMaster.count()).toBe(1);
  });

  it("refuses any key but the version's own in the internal namespace", async () => {
    const versionId = await plannedVersion();
    const other = await plannedVersion();
    const own = managedCleanMasterKey({ organizationId: ORG_A, deliverableVersionId: versionId });
    for (const storageKey of [
      // The customer's video, and another version's master.
      managedDeliverableOutputKey({ organizationId: ORG_A, deliverableVersionId: versionId }),
      managedCleanMasterKey({ organizationId: ORG_A, deliverableVersionId: other }),
      // Outside the internal namespace, or beside it.
      `org/${ORG_A}/clean-masters/${versionId}`,
      `org/${ORG_A}/Internal/clean-masters/${versionId}`,
      `org/${ORG_A}/x/internal/clean-masters/${versionId}`,
      // No organization, a blank one, or one segment too many.
      `org//internal/clean-masters/${versionId}`,
      `org/ /internal/clean-masters/${versionId}`,
      `${own}/`,
      `${own}/output`,
      own.replace(/^org\//, "orgs/"),
    ]) {
      await expect(
        create(master(versionId, { storageKey })),
        storageKey,
      ).rejects.toThrow(/deliverable_clean_master_key_check/);
    }
    expect(await prisma.generationDeliverableCleanMaster.count()).toBe(0);
  });

  it("refuses a receipt that is not one", async () => {
    const versionId = await plannedVersion();
    for (const overrides of [
      { sha256: DIGEST.toUpperCase() },
      { sha256: DIGEST.slice(1) },
      { sha256: `${DIGEST}0` },
      { sizeBytes: 0n },
      { sizeBytes: -1n },
      { sizeBytes: 9_007_199_254_740_992n },
    ]) {
      await expect(
        create(master(versionId, overrides)),
        JSON.stringify(overrides, (_, value: unknown) => (typeof value === "bigint" ? `${value}n` : value)),
      ).rejects.toThrow(/deliverable_clean_master_receipt_check/);
    }
    await create(master(versionId, { sizeBytes: 9_007_199_254_740_991n }));
  });

  it("names a real version, and no version is deleted from under its master", async () => {
    await expect(create(master("gdv_itest_cm_missing"))).rejects.toMatchObject({ code: "P2003" });
    const versionId = await plannedVersion();
    await create(master(versionId));
    await prisma.generationDeliverableInput.deleteMany({ where: { deliverableVersionId: versionId } });
    await expect(
      prisma.generationDeliverableVersion.delete({ where: { id: versionId } }),
    ).rejects.toMatchObject({
      code: "P2003",
      meta: { field_name: expect.stringContaining("generation_deliverable_clean_masters_deliverableVersionId_fkey") },
    });
    expect(await prisma.generationDeliverableVersion.count({ where: { id: versionId } })).toBe(1);
    // The master is what held it: without one, the same version deletes.
    await prisma.generationDeliverableCleanMaster.delete({ where: { deliverableVersionId: versionId } });
    await prisma.generationDeliverableVersion.delete({ where: { id: versionId } });
  });
});
