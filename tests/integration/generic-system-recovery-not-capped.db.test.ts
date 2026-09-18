import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_AUTOMATIC_MEDIA_RECOVERY_ATTEMPTS_PER_REQUEST,
  automaticMediaRecoveryAllowed,
} from "@app/domain";
import {
  attemptInput,
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
 * The Phase 6B cap is the automatic media policy's, not Transaction C's.
 *
 * This file exists to stop a specific future mistake: someone reading
 * `MAX_AUTOMATIC_MEDIA_RECOVERY_ATTEMPTS_PER_REQUEST = 1` and "simplifying" it
 * by moving the check into generic attempt admission. That would silently
 * remove the platform's ability to recover deliberately — an operator explicitly
 * admitting a second recovery after an incident, a reconstruction path replaying
 * a sequence — and the failure would be invisible until someone needed it.
 *
 * So the two policies are asserted side by side, against the same request:
 * generic admission keeps admitting sequential recoveries, and the automatic
 * policy refuses after one.
 */

const RUN = HAS_DB ? describe : describe.skip;
const prisma = new PrismaClient();
const repos = repositories(prisma);

/**
 * Move an attempt out of every active state, so the next one may be admitted.
 *
 * `submissionBoundaryEnteredAt` is set alongside the state because a CHECK
 * constraint requires it for every state past `QUEUED`: an attempt that reached
 * a terminal provider outcome must have crossed the submission boundary to get
 * there. Setting one without the other would be a row shape the database
 * refuses, and the fixture would be violating the invariant rather than the
 * code under test.
 */
async function finish(attemptId: string): Promise<void> {
  await prisma.sceneGeneration.update({
    where: { id: attemptId },
    data: {
      submissionBoundaryEnteredAt: new Date("2026-09-01T00:00:00.000Z"),
      submissionCertainty: "ACCEPTED",
      providerPredictionId: `pred_${attemptId}`,
      providerAcceptedAt: new Date("2026-09-01T00:00:00.000Z"),
      orchestrationState: "FAILED_TERMINAL",
    },
  });
}

RUN("the automatic media-recovery cap is not a generic SYSTEM_RECOVERY cap", () => {
  beforeEach(async () => {
    await wipeOrchestration(prisma);
    await seedTenants(prisma);
  });

  afterAll(async () => {
    await wipeOrchestration(prisma);
    await dropTenants(prisma);
    await prisma.$disconnect();
  });

  it("keeps admitting sequential recoveries through generic Transaction C", async () => {
    const { request } = await seedChain(prisma, "genericcap");

    // 1. The first attempt is PRIMARY, ordinal 1, and starts the request.
    const first = await repos.attempts.admit(
      ORG_A,
      attemptInput({ id: "sgen_cap_1", generationSceneRequestId: request.id }),
      ctx(),
    );
    if (first.kind !== "ADMITTED") throw new Error(`first not admitted: ${first.kind}`);
    expect(first.attempt.attemptKind).toBe("PRIMARY");
    expect(first.attempt.attemptOrdinal).toBe(1);
    expect(
      (await prisma.sceneGenerationRequest.findUniqueOrThrow({ where: { id: request.id } })).state,
    ).toBe("GENERATING");

    // A live sibling still blocks another attempt: recovery is sequential.
    const whileActive = await repos.attempts.admit(
      ORG_A,
      attemptInput({ id: "sgen_cap_blocked", generationSceneRequestId: request.id }),
      ctx(),
    );
    expect(whileActive.kind).toBe("ATTEMPT_ALREADY_ACTIVE");

    // 2. Once it has finished, generic admission files SYSTEM_RECOVERY #1.
    await finish("sgen_cap_1");
    const second = await repos.attempts.admit(
      ORG_A,
      attemptInput({ id: "sgen_cap_2", generationSceneRequestId: request.id }),
      ctx(),
    );
    if (second.kind !== "ADMITTED") throw new Error(`second not admitted: ${second.kind}`);
    expect(second.attempt.attemptKind).toBe("SYSTEM_RECOVERY");
    expect(second.attempt.attemptOrdinal).toBe(2);

    // 3. And after *that* finishes, another explicit recovery is still allowed.
    //    This is the assertion that fails if the Phase 6B cap ever moves into
    //    Transaction C.
    await finish("sgen_cap_2");
    const third = await repos.attempts.admit(
      ORG_A,
      attemptInput({ id: "sgen_cap_3", generationSceneRequestId: request.id }),
      ctx(),
    );
    if (third.kind !== "ADMITTED") throw new Error(`third not admitted: ${third.kind}`);
    expect(third.attempt.attemptKind).toBe("SYSTEM_RECOVERY");
    expect(third.attempt.attemptOrdinal).toBe(3);

    // The request itself never moved again: only a PRIMARY starts it.
    const finalRequest = await prisma.sceneGenerationRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(finalRequest.state).toBe("GENERATING");
    expect(finalRequest.deliveredAt).toBeNull();

    // Meanwhile the automatic media policy, given the same request's attempts,
    // refuses after the first SYSTEM_RECOVERY exists.
    const systemRecoveries = await prisma.sceneGeneration.count({
      where: { generationSceneRequestId: request.id, attemptKind: "SYSTEM_RECOVERY" },
    });
    expect(systemRecoveries).toBe(2);
    expect(automaticMediaRecoveryAllowed(systemRecoveries)).toBe(false);
    // ...and would already have refused at one.
    expect(automaticMediaRecoveryAllowed(1)).toBe(false);
    expect(automaticMediaRecoveryAllowed(0)).toBe(true);
    expect(MAX_AUTOMATIC_MEDIA_RECOVERY_ATTEMPTS_PER_REQUEST).toBe(1);
  });

  it("derives kind and ordinal internally rather than from the caller", async () => {
    // Transaction C's derivation is what Phase 6B reuses instead of writing a
    // second admission path, so it is asserted here rather than assumed.
    const { request } = await seedChain(prisma, "genericderive");
    const first = await repos.attempts.admit(
      ORG_A,
      attemptInput({ id: "sgen_derive_1", generationSceneRequestId: request.id }),
      ctx(),
    );
    if (first.kind !== "ADMITTED") throw new Error("expected admission");
    await finish("sgen_derive_1");
    const second = await repos.attempts.admit(
      ORG_A,
      attemptInput({ id: "sgen_derive_2", generationSceneRequestId: request.id }),
      ctx(),
    );
    if (second.kind !== "ADMITTED") throw new Error("expected admission");

    // Nothing in the input names a kind or an ordinal; both come from what
    // already exists under the request.
    expect(Object.keys(attemptInput({ id: "x", generationSceneRequestId: "y" }))).not.toContain(
      "attemptKind",
    );
    expect(Object.keys(attemptInput({ id: "x", generationSceneRequestId: "y" }))).not.toContain(
      "attemptOrdinal",
    );
    expect(second.attempt.attemptKind).toBe("SYSTEM_RECOVERY");
    expect(second.attempt.attemptOrdinal).toBe(2);
    expect(second.attempt.orchestrationState).toBe("QUEUED");
    expect(second.attempt.submissionCertainty).toBe("PRE_SUBMISSION");
  });
});
