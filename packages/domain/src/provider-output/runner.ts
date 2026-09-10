import {
  managedGenerationOutputKey,
  type ManagedOutputVerificationReceipt,
} from "../completion/output";
import { validateReconciliationMaintenanceLimit } from "../reconciliation/limits";
import { isNonBlankString } from "../submission/untrusted";
import { TransientProviderOutputLocator } from "./locator";
import { isWellFormedPollObservation, type ProviderPollObservation } from "./observation";
import type { CompletionCandidate } from "../completion/index";
import type {
  ContextInvalidReason,
  ProviderOutputBatchReport,
  ProviderOutputCandidateStage,
  ProviderOutputDeps,
  ProviderOutputRunResult,
  ProviderPollingContext,
  ProviderStatusLookupRef,
  RunProviderOutputAttemptInput,
  RunProviderOutputBatchInput,
} from "./ports";
import { isWellFormedTransferOutcome } from "./transfer";

/**
 * One bounded pass over one accepted attempt: ask what the provider did, write
 * down the answer, and — if there is an output to fetch — start and finish the
 * copy into managed storage.
 *
 * **Nothing here is a state machine of its own.** Every durable transition is
 * Phase 2H-1's, called through its service, which re-reads under lock and
 * re-decides. This module chooses *which* of those operations to call and in
 * what order; it never writes a row, never names a state, and cannot overrule a
 * refusal. That division is what lets the orchestration be wrong about a stale
 * poll without being dangerous.
 *
 * ### Three orderings that are load-bearing
 *
 * **Provider truth is recorded before output acquisition is attempted.** A
 * provider that finished has finished, and it will bill for the render whether
 * or not the platform can currently reach the artifact. Recording success only
 * once a download location is in hand would let a transient acquisition problem
 * suppress a money-relevant fact indefinitely — the attempt would sit in
 * `PROCESSING` while the Safety Guard counted it as in-flight forever.
 *
 * **No database transaction is open across external I/O.** The status source and
 * the transfer port are network calls in every future implementation, with
 * network timeouts. A row lock or an advisory lock held across one of them is a
 * tenant's entire generation pipeline stalled behind a vendor's slowest
 * response. Each database interaction here opens and closes before anything
 * external is awaited.
 *
 * **A poll result is evidence, never authority.** By the time this module acts
 * on an observation, another runner may have written something else. That is not
 * a race to eliminate; it is why every write goes back through a
 * compare-and-set that re-reads the row. A conflict is surfaced, not resolved
 * in the last writer's favour.
 *
 * ### What this deliberately cannot do
 *
 * There is no HTTP client, no storage client, no provider adapter and no
 * scheduler in this module's dependency graph. It cannot submit, cancel, or
 * re-POST anything: the paid submission port is not among its dependencies, so
 * a second paid generation is not something it declines to do — it is something
 * it has no way to express.
 */

/** Which Phase 2H-1 discovery stage corresponds to each state this run handles. */
const BATCH_STAGES: readonly ProviderOutputCandidateStage[] = [
  "AWAITING_PROVIDER_COMPLETION",
  "AWAITING_OUTPUT_INGESTION",
  "RESUMABLE_OUTPUT_INGESTION",
];

/**
 * Whether the persisted provider identity can address a provider job at all.
 *
 * Checked before the status source is called, and answered rather than repaired.
 * A blank provider name on an accepted attempt is a record that cannot be acted
 * on, and the two available repairs are both worse than refusing: substituting
 * today's default asks the wrong vendor about a prediction it never issued, and
 * rewriting the row invents history. `providerPredictionId` is separate from the
 * other two because the database already guarantees it is present whenever the
 * certainty is `ACCEPTED` — a blank one means something wrote around that
 * constraint.
 */
function invalidContextReason(context: ProviderPollingContext): ContextInvalidReason | null {
  if (!isNonBlankString(context.providerName)) return "PROVIDER_NAME_BLANK";
  if (!isNonBlankString(context.providerModelId)) return "PROVIDER_MODEL_ID_BLANK";
  if (!isNonBlankString(context.providerPredictionId)) return "PROVIDER_PREDICTION_ID_BLANK";
  return null;
}

/**
 * The three identifiers a status lookup needs, taken from the attempt row.
 *
 * Everything else the context holds — the organization, the attempt id, the
 * state — stays here. A vendor asked "what became of prediction X" has no use
 * for the customer's identity, and a field that travels is a field the far side
 * can log.
 */
function lookupRefFor(context: ProviderPollingContext): ProviderStatusLookupRef {
  return {
    providerName: context.providerName,
    providerModelId: context.providerModelId,
    providerPredictionId: context.providerPredictionId,
  };
}

export function createProviderOutputRunner(deps: ProviderOutputDeps) {
  /**
   * Ask the status source, and turn anything unusable into a closed answer.
   *
   * The two failure modes are kept apart because they mean different things. A
   * *throw* is "the application could not find out", which says nothing about
   * the provider and must never be recorded as a provider failure — that would
   * convert a network blip into a terminal state for a paid render. A
   * *malformed* result is "the adapter returned something outside the contract",
   * which is a defect in the adapter. Neither writes anything.
   */
  async function observe(
    ref: ProviderStatusLookupRef,
  ): Promise<
    | { readonly ok: true; readonly observation: ProviderPollObservation }
    | { readonly ok: false; readonly result: ProviderOutputRunResult }
  > {
    let raw: unknown;
    try {
      raw = await deps.statusSource.poll(ref);
    } catch {
      // The thrown value is deliberately not inspected, not logged and not
      // persisted. It is a vendor's error object: it can hold a signed URL, a
      // request body, an authorization header, or all three.
      return { ok: false, result: { kind: "STATUS_SOURCE_FAILED" } };
    }
    if (!isWellFormedPollObservation(raw)) {
      return { ok: false, result: { kind: "STATUS_OBSERVATION_MALFORMED" } };
    }
    return { ok: true, observation: raw };
  }

  /**
   * Copy the output and close the attempt, from an attempt that is already
   * durably `OUTPUT_INGESTING`.
   *
   * The destination is derived here from the organization and attempt, never
   * from the provider and never from a caller — the same rule Phase 2H-1
   * enforces again inside its own transaction.
   *
   * A transfer that throws or reports a transient problem leaves the attempt
   * exactly where it is. `OUTPUT_INGESTING` is the resumable state, and that is
   * the entire reason it exists: the provider's render is still there, the key
   * is deterministic, and a later run picks it up. Recording a storage fault as
   * `FAILED_RETRYABLE` would attribute the platform's own problem to the vendor
   * and throw away a render the platform has already paid for.
   */
  async function transferAndFinalize(
    input: RunProviderOutputAttemptInput,
    locator: TransientProviderOutputLocator,
  ): Promise<ProviderOutputRunResult> {
    const destinationKey = managedGenerationOutputKey({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
    });

    let raw: unknown;
    try {
      raw = await deps.transfer.transferAndVerify({ source: locator, destinationKey });
    } catch {
      return { kind: "TRANSFER_SOURCE_FAILED" };
    }
    if (!isWellFormedTransferOutcome(raw)) {
      // The attempt stays `OUTPUT_INGESTING`. It genuinely is ingesting — that
      // transition was applied and committed before this call — and rolling it
      // back because a port misbehaved would discard a true fact.
      return { kind: "TRANSFER_OUTCOME_MALFORMED" };
    }
    if (raw.kind === "RETRYABLE_FAILURE") {
      return { kind: "TRANSFER_RETRYABLE_FAILURE" };
    }

    // The receipt travels exactly as received. Phase 2H-1 is the single
    // authority on whether a digest and a byte count are real, and pre-checking
    // them here would be a second validator with its own drift.
    const finalized = await deps.completion.finalizeOutputVerification({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      // Cast, not validated: the receipt is `unknown` by contract and Phase
      // 2H-1's boundary proves it. Checking it here would be the second
      // validator this design exists to avoid.
      receipt: raw.receipt as ManagedOutputVerificationReceipt,
      context: input.context,
    });

    switch (finalized.kind) {
      case "APPLIED":
        return { kind: "OUTPUT_VERIFIED" };
      case "REPLAYED":
        return { kind: "OUTPUT_VERIFICATION_REPLAYED" };
      case "CONFLICTING_OUTPUT":
        // Two transfers disagreed about the bytes. Phase 2H-1 kept the first
        // and refused the second; surfacing it is all this layer may do.
        return { kind: "PROVIDER_REALITY_CONFLICT", reason: "COMPLETION_CONFLICT" };
      case "RECEIPT_MALFORMED":
        return { kind: "TRANSFER_OUTCOME_MALFORMED" };
      case "NOT_INGESTING":
        return { kind: "ATTEMPT_NOT_APPLICABLE", reason: "ATTEMPT_STATE_MOVED" };
      case "ATTEMPT_NOT_FOUND":
        return { kind: "ATTEMPT_NOT_FOUND" };
      case "LOST_CONCURRENCY":
        return { kind: "LOST_CONCURRENCY" };
    }
  }

  /**
   * Claim the ingestion transition, and transfer only if this run won it.
   *
   * `ALREADY_INGESTING` means another runner got there first. This run stops
   * rather than starting a second simultaneous copy of the same object — not
   * because a duplicate would corrupt anything (the key is deterministic and
   * finalization is idempotent), but because it is wasted bandwidth against a
   * vendor and a storage bill for nothing. It is a cheap way to avoid the common
   * duplicate without introducing an I/O lease, which would be a durable
   * mechanism with its own expiry and crash semantics to get wrong.
   *
   * The resume path deliberately does not come through here: an attempt already
   * persisted as `OUTPUT_INGESTING` transfers directly, because for it the
   * transition is not something to claim but something already true.
   */
  async function claimIngestionThenTransfer(
    input: RunProviderOutputAttemptInput,
    locator: TransientProviderOutputLocator,
  ): Promise<ProviderOutputRunResult> {
    const begun = await deps.completion.beginOutputIngestion({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      context: input.context,
    });

    switch (begun.kind) {
      case "APPLIED":
        return transferAndFinalize(input, locator);
      case "ALREADY_INGESTING":
        return { kind: "INGESTION_ALREADY_CLAIMED" };
      case "ALREADY_VERIFIED":
        return { kind: "ALREADY_VERIFIED" };
      case "NOT_INGESTIBLE":
        return { kind: "ATTEMPT_NOT_APPLICABLE", reason: "TRANSITION_REFUSED" };
      case "ATTEMPT_NOT_FOUND":
        return { kind: "ATTEMPT_NOT_FOUND" };
      case "LOST_CONCURRENCY":
        return { kind: "LOST_CONCURRENCY" };
    }
  }

  /**
   * The `PROCESSING` path: the provider's outcome is not yet on file.
   *
   * A failure is delegated straight to Phase 2H-1. A success is recorded
   * *first*, before the locator is even consulted — §15's mandatory ordering,
   * and the reason `OUTPUT_LOCATOR_UNAVAILABLE` can be returned from an attempt
   * that has nonetheless moved to `PROVIDER_SUCCEEDED`.
   */
  async function fromProcessing(
    input: RunProviderOutputAttemptInput,
    observation: ProviderPollObservation,
  ): Promise<ProviderOutputRunResult> {
    if (observation.kind === "IN_PROGRESS") {
      // Nothing is written. Not a version bump, not an event, not a timestamp.
      // A poll is an observation; recording every one of them would turn the
      // transition log into a heartbeat feed and bury the transitions that
      // matter.
      return { kind: "STILL_PROCESSING" };
    }

    const recorded = await deps.completion.recordProviderCompletion({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      observation:
        observation.kind === "SUCCEEDED"
          ? { kind: "SUCCEEDED" }
          : {
              kind: "FAILED",
              retryable: observation.retryable,
              diagnosticCode: observation.diagnosticCode,
            },
      context: input.context,
    });

    switch (recorded.kind) {
      case "APPLIED":
      case "REPLAYED":
        break;
      case "CONFLICTING_COMPLETION":
        // The row already says something else about provider reality. Phase
        // 2H-1 refused; this layer reports rather than retries with force.
        return { kind: "PROVIDER_REALITY_CONFLICT", reason: "COMPLETION_CONFLICT" };
      case "ATTEMPT_NOT_PROCESSING":
        return { kind: "ATTEMPT_NOT_APPLICABLE", reason: "ATTEMPT_STATE_MOVED" };
      case "OBSERVATION_MALFORMED":
        // Unreachable in practice — the observation was validated before the
        // status source's answer was believed — and mapped rather than
        // asserted, because an impossible case that throws is a crash where a
        // closed answer would do.
        return { kind: "STATUS_OBSERVATION_MALFORMED" };
      case "ATTEMPT_NOT_FOUND":
        return { kind: "ATTEMPT_NOT_FOUND" };
      case "LOST_CONCURRENCY":
        return { kind: "LOST_CONCURRENCY" };
    }

    if (observation.kind === "FAILED") {
      return recorded.kind === "APPLIED"
        ? { kind: "PROVIDER_COMPLETION_APPLIED" }
        : { kind: "PROVIDER_COMPLETION_REPLAYED" };
    }

    // Success is durable at this point, whatever happens next.
    if (observation.outputLocator === null) {
      return { kind: "OUTPUT_LOCATOR_UNAVAILABLE" };
    }
    return claimIngestionThenTransfer(input, observation.outputLocator);
  }

  /**
   * The reacquisition paths: provider success is already on file.
   *
   * The status source is consulted for one reason only — to obtain a usable
   * download location. Its verdict about *execution* is no longer news, and two
   * of its three answers now contradict the record:
   *
   * - `FAILED` against a recorded success is not a correction. Provider reality
   *   the platform already wrote down is immutable; a late failure report is a
   *   discrepancy for a human, not an instruction to overwrite a success and
   *   erase a charge the Safety Guard is counting.
   * - `IN_PROGRESS` against a recorded success cannot move the attempt
   *   backwards. There is no such edge, and inventing one would un-finish work
   *   that finished.
   */
  async function fromRecordedSuccess(
    input: RunProviderOutputAttemptInput,
    observation: ProviderPollObservation,
    resumable: boolean,
  ): Promise<ProviderOutputRunResult> {
    switch (observation.kind) {
      case "FAILED":
        return {
          kind: "PROVIDER_REALITY_CONFLICT",
          reason: "FAILED_AGAINST_RECORDED_SUCCESS",
        };
      case "IN_PROGRESS":
        return {
          kind: "PROVIDER_REALITY_CONFLICT",
          reason: "IN_PROGRESS_AGAINST_RECORDED_SUCCESS",
        };
      case "SUCCEEDED":
        break;
    }

    if (observation.outputLocator === null) {
      return { kind: "OUTPUT_LOCATOR_UNAVAILABLE" };
    }
    // An attempt already ingesting does not re-claim the transition: it is
    // already true of the row, and asking Phase 2H-1 again would only produce
    // `ALREADY_INGESTING` and stop the very resume this path exists for.
    return resumable
      ? transferAndFinalize(input, observation.outputLocator)
      : claimIngestionThenTransfer(input, observation.outputLocator);
  }

  /**
   * One attempt, one pass.
   *
   * The caller supplies an organization, an attempt id and an operational
   * context — and nothing else. State, certainty, provider, model, prediction
   * id, output location, storage key and receipt are all loaded or derived
   * internally, because every one of them is a fact about the past that a
   * caller could otherwise get wrong or supply deliberately.
   */
  async function runOnce(
    input: RunProviderOutputAttemptInput,
  ): Promise<ProviderOutputRunResult> {
    const context = await deps.polling.loadPollingContext({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
    });
    // Missing, cross-tenant, legacy, or in a state this phase does not act on
    // — one answer, so the reply cannot confirm another tenant's row exists.
    if (context === null) return { kind: "ATTEMPT_NOT_FOUND" };

    // Before any external call, and before any write: a verified attempt is
    // finished. Polling it would be an outbound request with nothing to learn
    // and a locator to leak.
    if (context.orchestrationState === "OUTPUT_VERIFIED") {
      return { kind: "ALREADY_VERIFIED" };
    }

    const invalid = invalidContextReason(context);
    if (invalid !== null) return { kind: "ATTEMPT_CONTEXT_INVALID", reason: invalid };

    const observed = await observe(lookupRefFor(context));
    if (!observed.ok) return observed.result;

    switch (context.orchestrationState) {
      case "PROCESSING":
        return fromProcessing(input, observed.observation);
      case "PROVIDER_SUCCEEDED":
        return fromRecordedSuccess(input, observed.observation, false);
      case "OUTPUT_INGESTING":
        return fromRecordedSuccess(input, observed.observation, true);
    }
  }

  return {
    runProviderOutputAttemptOnce: runOnce,

    /**
     * One bounded pass over all three stages.
     *
     * One invocation is one pass. It does not loop, sleep, schedule itself, own
     * a timer, back off, or retry a candidate — a daemon is a different thing
     * with different failure modes, and nothing in this phase is authorized to
     * become one. A caller decides when a batch runs; this decides what one
     * batch does.
     *
     * Candidates are advisory. Discovery takes no locks, so every row it returns
     * is a hypothesis about the past; the single-attempt runner reloads the
     * authoritative context and may well conclude there is nothing to do. That
     * is a normal outcome, counted rather than treated as an error.
     */
    async runProviderOutputBatchOnce(
      input: RunProviderOutputBatchInput,
    ): Promise<ProviderOutputBatchReport> {
      // Before any query, and reusing Phase 2G-2's canonical validator rather
      // than restating the rule: two bound rules is how a limit one boundary
      // rejects reaches the database through the other.
      const limit = validateReconciliationMaintenanceLimit(input.limit);

      // **All discovery happens before any processing.** Interleaving them —
      // discover a stage, process it, discover the next — lets the batch feed
      // itself: this batch moves an attempt from PROCESSING to
      // PROVIDER_SUCCEEDED, and the next stage's query, run afterwards, finds
      // the same attempt and processes it again. The same happens when a
      // transfer failure leaves an attempt at OUTPUT_INGESTING just before the
      // resumable query runs. Neither is a race with another worker; the batch
      // does it to itself, deterministically, every time.
      //
      // So the candidate set is fixed first, against one moment, and processing
      // works from that frozen list.
      const discovered: CompletionCandidate[] = [];
      for (const stage of BATCH_STAGES) {
        discovered.push(...(await deps.polling.findOrchestrationCandidates({ stage, limit })));
      }

      // Deduplicated on the full tenant-qualified identity. An attempt id alone
      // is not an identity — ids are only unique within their own data — and
      // two organizations are two different rows however their ids compare.
      // Order is preserved, so BATCH_STAGES priority and each query's own
      // ordering decide who makes the cut when the limit bites.
      const seen = new Set<string>();
      const selected: CompletionCandidate[] = [];
      for (const candidate of discovered) {
        const identity = `${candidate.organizationId}\u0000${candidate.attemptId}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        selected.push(candidate);
        // A **global** cap on unique attempts, not a per-stage one. Three
        // stages each bounded at 100 would let one invocation touch 300 rows
        // while reporting that its limit was 100.
        if (selected.length === limit) break;
      }

      const results: ProviderOutputRunResult["kind"][] = [];
      for (const candidate of selected) {
        const result = await runOnce({
          organizationId: candidate.organizationId,
          attemptId: candidate.attemptId,
          context: input.context,
        });
        // Only the closed kind is kept. A batch report is the thing most
        // likely to be logged wholesale, so it must not be able to carry a
        // provider error, a storage diagnostic or a locator.
        results.push(result.kind);
      }

      return { candidates: selected.length, results };
    },
  };
}

export type ProviderOutputRunner = ReturnType<typeof createProviderOutputRunner>;
