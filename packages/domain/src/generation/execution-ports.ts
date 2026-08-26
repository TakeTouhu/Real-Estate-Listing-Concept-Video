import type { PreflightFailureState, PreflightRefusalReason } from "./execution-preflight-errors";
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
 * A `SceneGeneration` known to be in one particular state.
 *
 * The state each execution result carries is not incidental — it is the whole
 * difference between them — so it is expressed in the type rather than only
 * asserted at runtime. `Omit` and re-add rather than a widened field: this must
 * *narrow* `SceneGeneration["state"]`, and an intersection alone would leave the
 * original union in place.
 */
type SceneGenerationInState<S extends SceneGeneration["state"]> = Omit<SceneGeneration, "state"> & {
  readonly state: S;
};

/**
 * A row this caller — and only this caller — moved into `SUBMITTING`.
 *
 * Holding one is the licence to spend money on that generation exactly once.
 */
export interface ClaimedSceneGeneration {
  /** Resolved through the owning `VideoProject`; never taken from input. */
  readonly organizationId: string;
  /** The row **as it now stands**, in `SUBMITTING`, not the pre-claim value. */
  readonly generation: SceneGenerationInState<"SUBMITTING">;
}

/**
 * A row this caller — and only this caller — parked as a preflight failure.
 *
 * A **separate type from {@link ClaimedSceneGeneration}**, and separate in a way
 * the compiler enforces. That type means "the licence to spend money on this
 * generation exactly once"; this one means the opposite — the record that no
 * money will be spent on it.
 *
 * What makes them distinct is `generation.state`: `SUBMITTING` there, one of the
 * two failure states here, and those are mutually exclusive. TypeScript is
 * structural, so two interfaces that merely *meant* different things while
 * carrying the same members would be freely interchangeable — a parked row would
 * pass anywhere a submission licence was expected, with nothing for the compiler
 * to say about it. Narrowing the state is what turns the intended distinction
 * into a real one, and it costs nothing to state: both adapters already prove
 * exactly this at runtime before returning.
 */
export interface FailedSceneGeneration {
  /** Resolved through the owning `VideoProject`; never taken from input. */
  readonly organizationId: string;
  /** The row **as it now stands**, already parked, not the pre-write value. */
  readonly generation: SceneGenerationInState<PreflightFailureState>;
}

/**
 * Three methods, and no more than execution actually needs today.
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

  /**
   * Park exactly one `QUEUED` row as a preflight failure, or return `null`.
   *
   * The same compare-and-swap as the claim, competing on the same predicate:
   * `id = $1 AND state = 'QUEUED'`. That is what makes the two mutually
   * exclusive. If the claim wins, this returns `null` and can never overwrite a
   * `SUBMITTING` row — a row someone may already be paying for. If this wins,
   * the claim returns `null` and no submission licence for that row can exist.
   *
   * **The target state is derived, never supplied.** The caller names the
   * refusal; `preflightFailureStateFor` decides where it parks. There is no
   * state parameter, so `ASSET_NOT_FOUND` cannot be filed as `FAILED_RETRYABLE`
   * — the disagreement is unspeakable rather than merely discouraged. The
   * `reason` is also what lands in `normalizedErrorCode`, so the durable code
   * and the durable state cannot describe different failures.
   *
   * **`null` means exactly one thing:** *this caller did not win a `QUEUED`
   * preflight-failure transition.* Unknown id, already claimed, already
   * cancelled, already failed, or simply lost the race — all identical, because
   * the caller's next action is identical in every one of them. When two
   * refusals race, the first database writer wins; there is no reason priority,
   * because with two refusals both true of one row either is a correct record.
   *
   * Takes no `organizationId` — like the other two, it *resolves* the tenant
   * from the owning `VideoProject` and hands it back.
   */
  failQueuedPreflight(
    generationId: string,
    reason: PreflightRefusalReason,
  ): Promise<FailedSceneGeneration | null>;
}
