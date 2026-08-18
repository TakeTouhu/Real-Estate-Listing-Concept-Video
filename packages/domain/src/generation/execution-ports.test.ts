import { describe, expect, it } from "vitest";
import { ACTIVE_SCENE_GENERATION_STATES } from "./state-machine";
import type { SceneGenerationExecutionRepository } from "./execution-ports";

/**
 * The execution port's **type-level** contract.
 *
 * There is deliberately no in-memory implementation of this interface, and so
 * no behavioural test here. Nothing in production consumes the port yet, and a
 * double built ahead of a consumer would be a second, unverified answer to the
 * one question this boundary exists to settle — who may spend money on a
 * generation. Every behavioural property (ordering, state filtering, tenant
 * resolution, claim exclusivity, and what a claim leaves untouched) is proven
 * against real PostgreSQL in
 * `tests/integration/generation-execution-repository.db.test.ts`, because the
 * database is what actually decides them.
 *
 * What remains here is what only the type system can state.
 */
describe("the execution port is separate from the tenant-facing one", () => {
  it("takes no organizationId on any method (compile-time)", () => {
    // The contract that keeps this boundary trustworthy: tenant identity is
    // *returned*, never accepted. A method that took one would let a caller
    // assert a tenant instead of resolving it, which is the whole difference
    // between this port and `SceneGenerationRepository`.
    type Discovery = Parameters<SceneGenerationExecutionRepository["findNextQueuedForPreparation"]>;
    type Claim = Parameters<SceneGenerationExecutionRepository["claimQueuedForSubmission"]>;

    const discoveryTakesNothing: Discovery extends [] ? true : never = true;
    const claimTakesOnlyAnId: Claim extends [string] ? true : never = true;

    expect(discoveryTakesNothing && claimTakesOnlyAnId).toBe(true);
  });

  it("claims into a state the domain still considers active", () => {
    // `SUBMITTING` must stay inside ACTIVE_SCENE_GENERATION_STATES: it holds the
    // request identity, so admission cannot create a duplicate attempt while a
    // claim is in flight. If that set ever stopped covering it, a claim would
    // silently open the duplicate-charge window this phase exists to close.
    expect(ACTIVE_SCENE_GENERATION_STATES).toContain("SUBMITTING");
  });
});
