import type { SceneGeneration } from "./types";

/**
 * The **system-scoped** persistence boundary for generation execution.
 *
 * Deliberately separate from {@link SceneGenerationRepository}, which is
 * tenant-facing: every one of its methods takes `organizationId` as an
 * addressing argument, and a caller who forgot it would be writing a missing
 * predicate rather than getting an unfiltered result. Execution cannot use that
 * interface, because a worker has no tenant to address it with — there is no
 * transport, no payload, and no customer request to read one from (ADR-0024).
 *
 * Adding a system-scoped read to the tenant-facing port instead was considered
 * and rejected: any holder of that repository could then bypass scoping, so the
 * blast radius of the trusted surface would be every call site rather than this
 * one file. Keeping them apart means the tenant-facing isolation tests keep
 * their full force, and this port is the only place where a row is reachable
 * without naming its organization first.
 *
 * **Tenant identity is resolved, never supplied.** Both methods return the
 * `organizationId` they derived from the generation's owning `VideoProject`, so
 * downstream execution code is tenant-correct by construction: the caller never
 * chooses an organization, the claim hands it one.
 */

/**
 * A row eligible for preparation, with its resolved tenant.
 *
 * Discovery is deliberately **read-only and non-exclusive**. Two workers may see
 * the same candidate, and that is safe because nothing is claimed here: the
 * exclusive step is {@link SceneGenerationExecutionRepository.claimQueuedForSubmission},
 * and the loser of that race simply moves on.
 *
 * The order matters and is the reason preparation and claiming are two calls.
 * Everything a later milestone needs to prepare a request — the frozen prompt,
 * the snapshot facts, the asset id — is immutable (ADR-0018, ADR-0023), so
 * preparation can happen before the row is moved anywhere. Claiming first would
 * hold the row in `SUBMITTING` across that whole stretch, and `SUBMITTING` is
 * the one state whose only honest recovery is `SUBMISSION_UNKNOWN` — a state
 * with no automatic exit that parks the work for a human. Narrowing the claim to
 * the provider call itself keeps that bucket as small as the design allows.
 */
export interface SystemGenerationCandidate {
  /** Resolved through the owning `VideoProject`; never taken from input. */
  readonly organizationId: string;
  readonly generation: SceneGeneration;
}

/**
 * A row this caller — and only this caller — moved into `SUBMITTING`.
 *
 * Holding one is the licence to spend money on that generation exactly once.
 */
export interface ClaimedSceneGeneration {
  /** Resolved through the owning `VideoProject`; never taken from input. */
  readonly organizationId: string;
  /** The row **as it now stands**, in `SUBMITTING`, not the pre-claim value. */
  readonly generation: SceneGeneration;
}

/**
 * Two methods, and no more than execution actually needs today.
 *
 * There is no `findById`, no listing, no lease renewal, no completion write, and
 * no abandonment sweep. Each of those belongs to a milestone that does not exist
 * yet, and inventing them here would put unused surface on the one boundary that
 * decides whether a provider gets paid — the same defect this phase has already
 * removed twice elsewhere.
 */
export interface SceneGenerationExecutionRepository {
  /**
   * The next `QUEUED` generation eligible for preparation, or `null`.
   *
   * **Reads only.** No state changes, nothing is reserved, and calling it twice
   * may return the same row. Ordering is deterministic — oldest first, by
   * `createdAt` then `id` as a tie-break — so two rows written in the same
   * millisecond still have a defined order and the scan cannot starve one of
   * them.
   *
   * Scans across all tenants by design: the queue is global, and the row's own
   * `state` is what makes it eligible (ADR-0024).
   */
  findNextQueuedForPreparation(): Promise<SystemGenerationCandidate | null>;

  /**
   * Move exactly one `QUEUED` row to `SUBMITTING`, or return `null`.
   *
   * This is a compare-and-swap, not a read followed by a write: the update
   * carries `state = 'QUEUED'` in its own predicate, so when two workers race
   * for the same candidate the database picks the winner and the loser gets
   * `null` rather than a second licence to submit. A row that has moved on for
   * any other reason — already claimed, cancelled, terminal — is refused by the
   * same predicate, and `null` does not distinguish between those cases because
   * the caller's next action is identical in all of them: try something else.
   *
   * Legality is still the domain's question. `assertTransition` says whether
   * `QUEUED → SUBMITTING` is a legal move; this method decides **who** gets to
   * make it. Both, not either.
   */
  claimQueuedForSubmission(generationId: string): Promise<ClaimedSceneGeneration | null>;
}
