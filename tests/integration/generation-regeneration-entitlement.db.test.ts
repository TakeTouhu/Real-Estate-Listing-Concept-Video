import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { usedUserRegenerationCount } from "@app/domain";
import {
  ctx,
  dropTenants,
  HAS_DB,
  ORG_A,
  repositories,
  seedChain,
  seedTenants,
  wipeOrchestration,
} from "./orchestration-fixture";

/**
 * The regeneration entitlement, end to end against PostgreSQL.
 *
 * The commercial rule is that a right is spent when a usable rendition reaches
 * the customer — not when they ask, and not when the platform tries. Two
 * defects made that untrue in the first implementation, and both are asserted
 * here from the customer's side.
 *
 * The unconditional unique index over `(scene, kind, ordinal)` did not
 * constrain `INITIAL` at all, because every initial row carries a NULL ordinal
 * and PostgreSQL treats NULLs as distinct. And it made a *failed* regeneration
 * occupy its ordinal permanently: the derivation correctly said no right had
 * been spent, while the database refused to store the replacement.
 */
const prisma = HAS_DB ? new PrismaClient() : (null as unknown as PrismaClient);
const repos = HAS_DB ? repositories(prisma) : (null as unknown as ReturnType<typeof repositories>);

describe.skipIf(!HAS_DB)("a regeneration right is spent only on delivery", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  /** Drive a request to a terminal state through the real transitions. */
  async function finish(
    id: string,
    version: number,
    to: "DELIVERED" | "FAILED_TERMINAL",
  ): Promise<void> {
    const generating = await repos.requests.transition({
      organizationId: ORG_A,
      id,
      expectedState: "PENDING",
      expectedVersion: version,
      nextState: "GENERATING",
      context: ctx(),
    });
    if (generating.kind !== "APPLIED") throw new Error("expected APPLIED");
    const done = await repos.requests.transition({
      organizationId: ORG_A,
      id,
      expectedState: "GENERATING",
      expectedVersion: generating.value.stateVersion,
      nextState: to,
      context: ctx(),
    });
    if (done.kind !== "APPLIED") throw new Error("expected APPLIED");
  }

  async function admitRegen(sceneId: string, id: string) {
    return repos.requests.admitUserRegeneration(
      ORG_A,
      { id, generationSceneId: sceneId, requestedByUserId: "usr_itest" },
      ctx({ actorType: "USER", actorUserId: "usr_itest" }),
    );
  }

  it("gives back the ordinal when a regeneration fails", async () => {
    const { scene } = await seedChain(prisma, "regenfail");

    const first = await admitRegen(scene.id, "genreq_regen_a");
    if (first.kind !== "ADMITTED") throw new Error(`expected ADMITTED, got ${first.kind}`);
    expect(first.request.userRegenerationOrdinal).toBe(1);

    await finish(first.request.id, first.request.stateVersion, "FAILED_TERMINAL");

    // No right spent: the platform failed the customer.
    const after = await repos.requests.listBySceneId(ORG_A, scene.id);
    expect(usedUserRegenerationCount(after)).toBe(0);

    // And the replacement can actually be stored, carrying ordinal 1 again.
    // Under the old unconditional index this insert failed, so the customer
    // could never ask a second time.
    const replacement = await admitRegen(scene.id, "genreq_regen_b");
    if (replacement.kind !== "ADMITTED") {
      throw new Error(`expected ADMITTED, got ${replacement.kind}`);
    }
    expect(replacement.request.userRegenerationOrdinal).toBe(1);

    // The failed request stays in history rather than being cleaned away.
    const all = await repos.requests.listBySceneId(ORG_A, scene.id);
    expect(all.map((r) => [r.id, r.state])).toEqual([
      ["genreq_regenfail", "PENDING"],
      ["genreq_regen_a", "FAILED_TERMINAL"],
      ["genreq_regen_b", "PENDING"],
    ]);
  });

  it("walks the full entitlement and then refuses a third", async () => {
    const { scene } = await seedChain(prisma, "regenwalk");

    const first = await admitRegen(scene.id, "genreq_w1");
    if (first.kind !== "ADMITTED") throw new Error("expected ADMITTED");
    expect(first.request.userRegenerationOrdinal).toBe(1);
    await finish(first.request.id, first.request.stateVersion, "DELIVERED");
    expect(usedUserRegenerationCount(await repos.requests.listBySceneId(ORG_A, scene.id))).toBe(1);

    const second = await admitRegen(scene.id, "genreq_w2");
    if (second.kind !== "ADMITTED") throw new Error("expected ADMITTED");
    // Derived from delivered requests, not from a caller-supplied number.
    expect(second.request.userRegenerationOrdinal).toBe(2);
    await finish(second.request.id, second.request.stateVersion, "DELIVERED");
    expect(usedUserRegenerationCount(await repos.requests.listBySceneId(ORG_A, scene.id))).toBe(2);

    const third = await admitRegen(scene.id, "genreq_w3");
    expect(third.kind).toBe("ENTITLEMENT_EXHAUSTED");
    expect(await prisma.sceneGenerationRequest.findUnique({ where: { id: "genreq_w3" } }))
      .toBeNull();
  });

  it("refuses a second regeneration while one is still in flight", async () => {
    // Not an entitlement rule but a coherence one: two concurrent renditions of
    // the same scene would both claim to be the customer's current answer.
    const { scene } = await seedChain(prisma, "regenactive");
    const first = await admitRegen(scene.id, "genreq_act1");
    expect(first.kind).toBe("ADMITTED");
    const second = await admitRegen(scene.id, "genreq_act2");
    expect(second.kind).toBe("REGENERATION_ALREADY_ACTIVE");
  });

  /**
   * The race the partial index exists for.
   *
   * Both transactions read the same delivered set and derive the same next
   * ordinal. Only the active-regeneration index can settle it, and it does so
   * by failing the second commit outright rather than letting two requests
   * share an entitlement slot.
   */
  it("lets only one of two concurrent admissions succeed", async () => {
    const { scene } = await seedChain(prisma, "regenrace");
    const results = await Promise.allSettled([
      admitRegen(scene.id, "genreq_race_a"),
      admitRegen(scene.id, "genreq_race_b"),
    ]);

    const admitted = results.filter(
      (r) => r.status === "fulfilled" && r.value.kind === "ADMITTED",
    );
    expect(admitted).toHaveLength(1);

    const stored = await prisma.sceneGenerationRequest.findMany({
      where: { generationSceneId: scene.id, kind: "USER_REGENERATION" },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.userRegenerationOrdinal).toBe(1);
  });

  it("records when a request was delivered and when one failed", async () => {
    // Added because a mutation removing the `deliveredAt` write survived: the
    // entitlement derives from `state`, so nothing observable broke while the
    // column recording *when* a right was spent silently stayed empty. That is
    // the fact a billing dispute is settled with.
    const { scene } = await seedChain(prisma, "stamps");
    const first = await admitRegen(scene.id, "genreq_stamp_ok");
    if (first.kind !== "ADMITTED") throw new Error("expected ADMITTED");
    expect(first.request.deliveredAt).toBeNull();

    await finish(first.request.id, first.request.stateVersion, "DELIVERED");
    const delivered = await repos.requests.findById(ORG_A, first.request.id);
    expect(delivered?.deliveredAt).not.toBeNull();
    expect(delivered?.failedAt).toBeNull();

    const second = await admitRegen(scene.id, "genreq_stamp_fail");
    if (second.kind !== "ADMITTED") throw new Error("expected ADMITTED");
    await finish(second.request.id, second.request.stateVersion, "FAILED_TERMINAL");
    const failed = await repos.requests.findById(ORG_A, second.request.id);
    expect(failed?.failedAt).not.toBeNull();
    expect(failed?.deliveredAt).toBeNull();
  });

  it("refuses two active regenerations at the database, not only in the service", async () => {
    // Aimed at the partial index itself. The repository also checks for an
    // active sibling inside its transaction, and that in-transaction check is
    // what a sequential caller hits — so a mutation removing the index survived
    // until this test bypassed the repository entirely. Under a genuine
    // concurrent interleave the index is the only thing left.
    const { scene } = await seedChain(prisma, "activeidx");
    await prisma.sceneGenerationRequest.create({
      data: {
        id: "genreq_active_1",
        generationSceneId: scene.id,
        kind: "USER_REGENERATION",
        userRegenerationOrdinal: 1,
        state: "GENERATING",
      },
    });
    await expect(
      prisma.sceneGenerationRequest.create({
        data: {
          id: "genreq_active_2",
          generationSceneId: scene.id,
          kind: "USER_REGENERATION",
          userRegenerationOrdinal: 2,
          state: "PENDING",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("permits at most one initial request per scene", async () => {
    // NULL ordinals are distinct to PostgreSQL, so the old unconditional index
    // allowed any number of these.
    const { scene } = await seedChain(prisma, "initdup");
    await expect(
      prisma.sceneGenerationRequest.create({
        data: {
          id: "genreq_second_initial",
          generationSceneId: scene.id,
          kind: "INITIAL",
          userRegenerationOrdinal: null,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("permits only one delivered request per entitlement ordinal", async () => {
    const { scene } = await seedChain(prisma, "delivdup");
    const first = await admitRegen(scene.id, "genreq_d1");
    if (first.kind !== "ADMITTED") throw new Error("expected ADMITTED");
    await finish(first.request.id, first.request.stateVersion, "DELIVERED");

    // Forcing a second DELIVERED row onto ordinal 1 is refused: an entitlement
    // slot can be spent once.
    await expect(
      prisma.sceneGenerationRequest.create({
        data: {
          id: "genreq_d2",
          generationSceneId: scene.id,
          kind: "USER_REGENERATION",
          userRegenerationOrdinal: 1,
          state: "DELIVERED",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("still refuses an out-of-range ordinal at the database", async () => {
    const { scene } = await seedChain(prisma, "ordrange");
    for (const ordinal of [0, 3, 99]) {
      await expect(
        prisma.sceneGenerationRequest.create({
          data: {
            id: `genreq_bad_${ordinal}`,
            generationSceneId: scene.id,
            kind: "USER_REGENERATION",
            userRegenerationOrdinal: ordinal,
          },
        }),
      ).rejects.toThrow(/scene_generation_requests_ordinal_check/);
    }
    await expect(
      prisma.sceneGenerationRequest.create({
        data: {
          id: "genreq_initial_with_ordinal",
          generationSceneId: scene.id,
          kind: "INITIAL",
          userRegenerationOrdinal: 1,
        },
      }),
    ).rejects.toThrow(/scene_generation_requests_ordinal_check/);
  });

  describe("a scene's delivered pointer must name one of its own requests", () => {
    it("rejects a request id that does not exist", async () => {
      const { scene } = await seedChain(prisma, "ptrmissing");
      await expect(
        prisma.generationScene.update({
          where: { id: scene.id },
          data: { currentDeliveredRequestId: "genreq_never_existed" },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("rejects a request belonging to another scene", async () => {
      // The case a plain existence check would miss, and the one that breaks
      // recovery reconstruction: a scene pointing at someone else's rendition.
      const a = await seedChain(prisma, "ptra");
      const b = await seedChain(prisma, "ptrb");
      await expect(
        prisma.generationScene.update({
          where: { id: a.scene.id },
          data: { currentDeliveredRequestId: b.request.id },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("accepts a request belonging to the same scene", async () => {
      const { scene, request } = await seedChain(prisma, "ptrok");
      const updated = await prisma.generationScene.update({
        where: { id: scene.id },
        data: { currentDeliveredRequestId: request.id },
      });
      expect(updated.currentDeliveredRequestId).toBe(request.id);
    });

    it("keeps the named request undeletable while it is selected", async () => {
      const { scene, request } = await seedChain(prisma, "ptrdel");
      await prisma.generationScene.update({
        where: { id: scene.id },
        data: { currentDeliveredRequestId: request.id },
      });
      await expect(
        prisma.sceneGenerationRequest.delete({ where: { id: request.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
    });
  });
});
