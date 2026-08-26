import { describe, expect, it } from "vitest";
import {
  ACTIVE_SCENE_GENERATION_STATES,
  TERMINAL_SCENE_GENERATION_STATES,
} from "./state-machine";
import type {
  ClaimedSceneGeneration,
  FailedSceneGeneration,
  SceneGenerationExecutionRepository,
} from "./execution-ports";
import type {
  PreflightFailureState,
  PreflightRefusalReason,
} from "./execution-preflight-errors";
import type { SceneGenerationState } from "./types";

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
    type Fail = Parameters<SceneGenerationExecutionRepository["failQueuedPreflight"]>;

    const discoveryTakesNothing: Discovery extends [] ? true : never = true;
    const claimTakesOnlyAnId: Claim extends [string] ? true : never = true;
    const failTakesAnIdAndAReason: Fail extends [string, PreflightRefusalReason] ? true : never =
      true;

    expect(discoveryTakesNothing && claimTakesOnlyAnId && failTakesAnIdAndAReason).toBe(true);
  });

  it("cannot be told which failure state to write (compile-time)", () => {
    // The property that makes reason/state disagreement unspeakable rather than
    // merely discouraged: there is no third parameter, so
    // `ASSET_NOT_FOUND` + FAILED_RETRYABLE has no way to be expressed. The
    // target comes from `preflightFailureStateFor` inside the adapter.
    type Fail = Parameters<SceneGenerationExecutionRepository["failQueuedPreflight"]>;

    const takesExactlyTwoArguments: Fail["length"] extends 2 ? true : never = true;
    // And the second is the closed reason vocabulary, not an open string — a
    // `string` parameter would let arbitrary caller text reach the durable
    // diagnostic column.
    const secondIsNotAnOpenString: string extends Fail[1] ? never : true = true;

    expect(takesExactlyTwoArguments && secondIsNotAnOpenString).toBe(true);
  });

  it("refuses to interchange a parked result and a submission licence (compile-time)", () => {
    // The property Codex found missing on the first attempt, and the reason it
    // mattered: TypeScript is structural, so two interfaces carrying identical
    // members are freely interchangeable no matter what their names or comments
    // claim. A parked row would have passed anywhere a licence to spend money
    // was expected.
    //
    // What separates them now is `generation.state` — `SUBMITTING` against
    // `FAILED_RETRYABLE | FAILED_TERMINAL`, which cannot overlap. Asserted in
    // **both** directions: a one-way check would still pass if one type were
    // widened back to the full `SceneGenerationState` union, because the narrow
    // side would remain assignable to the wide one.
    type FailedIsNotAClaim = FailedSceneGeneration extends ClaimedSceneGeneration ? never : true;
    type ClaimIsNotAFailure = ClaimedSceneGeneration extends FailedSceneGeneration ? never : true;

    const parkedCannotBeSpent: FailedIsNotAClaim = true;
    const licenceIsNotAFailure: ClaimIsNotAFailure = true;

    // And the states themselves are exactly what the two adapters verify at
    // runtime before returning — the type states no more than is already proved.
    type ClaimState = ClaimedSceneGeneration["generation"]["state"];
    type FailState = FailedSceneGeneration["generation"]["state"];

    const claimIsSubmitting: ClaimState extends "SUBMITTING" ? true : never = true;
    const failIsParked: FailState extends PreflightFailureState ? true : never = true;
    // Neither is still the whole vocabulary: a widened field would satisfy the
    // `extends` checks above only if it had not actually been narrowed.
    const claimIsNotWide: SceneGenerationState extends ClaimState ? never : true = true;
    const failIsNotWide: SceneGenerationState extends FailState ? never : true = true;

    expect(
      parkedCannotBeSpent &&
        licenceIsNotAFailure &&
        claimIsSubmitting &&
        failIsParked &&
        claimIsNotWide &&
        failIsNotWide,
    ).toBe(true);
  });

  it("parks preflight failures on both sides of the identity boundary", () => {
    // The two states Phase 4C-2B can write, and the consequence that makes them
    // different: a retryable park keeps the request identity reserved, so
    // admission reuses the attempt rather than creating a duplicate; a terminal
    // park releases it, so a later deliberate admission may create a new one.
    expect(ACTIVE_SCENE_GENERATION_STATES).toContain("FAILED_RETRYABLE");
    expect(TERMINAL_SCENE_GENERATION_STATES).toContain("FAILED_TERMINAL");
  });

  it("claims into a state the domain still considers active", () => {
    // `SUBMITTING` must stay inside ACTIVE_SCENE_GENERATION_STATES: it holds the
    // request identity, so admission cannot create a duplicate attempt while a
    // claim is in flight. If that set ever stopped covering it, a claim would
    // silently open the duplicate-charge window this phase exists to close.
    expect(ACTIVE_SCENE_GENERATION_STATES).toContain("SUBMITTING");
  });
});
