import type { TransitionContext } from "../orchestration/ports";
import type { CompletionCandidate, ProviderCompletionService } from "../completion/index";
import type { ManagedOutputTransferPort } from "./transfer";

/**
 * What the orchestration needs from the world, and the exact shape of what it
 * gives back.
 *
 * Four dependencies: a tenant-scoped read, a status source, a transfer port, and
 * Phase 2H-1's completion service. Three of the four are injected interfaces
 * with no production implementation in this phase — which is what keeps the
 * whole module dormant without relying on anyone remembering not to wire it.
 */

/**
 * The persisted facts one orchestration run is allowed to act on.
 *
 * Every field comes from the attempt row. None is caller-supplied, and none is
 * derived from current configuration — see {@link ProviderPollingContextReader}
 * for why that distinction is the most important one in this file.
 *
 * The states are exactly the four this phase can encounter. A `FAILED_*` attempt
 * is finished, a `QUEUED` or `SUBMITTING` one has no provider job to ask about,
 * and a legacy row has no orchestration lifecycle at all — so none of them is a
 * context, and the reader returns `null` rather than a context this runner would
 * then have to reject.
 */
export interface ProviderPollingContext {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly orchestrationState:
    | "PROCESSING"
    | "PROVIDER_SUCCEEDED"
    | "OUTPUT_INGESTING"
    | "OUTPUT_VERIFIED";
  /** Always `ACCEPTED`. An attempt in any other certainty is not a context. */
  readonly submissionCertainty: "ACCEPTED";
  readonly providerName: string;
  readonly providerModelId: string;
  readonly providerPredictionId: string;
}

/**
 * The tenant-scoped read that begins one run.
 *
 * **This is where the phase's central rule lives: the attempt says which
 * provider to ask.** Not `VIDEO_PROVIDER`, not the default model, not the
 * routing policy, not the catalog's current selection. An attempt was admitted
 * against a specific provider and model, and a prediction id issued by that
 * provider is meaningless anywhere else — so asking today's default about
 * yesterday's prediction is, at best, a lookup that fails, and at worst a lookup
 * that succeeds against an unrelated job.
 *
 * The context is **advisory**. It says what was true at read time and authorizes
 * nothing: every write still goes through Phase 2H-1's tenant-scoped
 * compare-and-set, which re-reads under lock. A cross-tenant read returns `null`
 * — indistinguishable from a missing attempt, so the answer cannot be used to
 * confirm another organization's row exists.
 */
export interface ProviderPollingContextReader {
  loadPollingContext(input: {
    readonly organizationId: string;
    readonly attemptId: string;
  }): Promise<ProviderPollingContext | null>;

  /**
   * Bounded, identifier-only discovery, reusing Phase 2H-1's query.
   *
   * Declared here so the orchestration depends on a port rather than on the
   * completion repository directly, but the implementation is 2H-1's — a second
   * discovery query would be a second place for the certainty filter and the
   * limit rule to drift.
   */
  findOrchestrationCandidates(input: {
    readonly stage: ProviderOutputCandidateStage;
    readonly limit: number;
  }): Promise<readonly CompletionCandidate[]>;
}

/**
 * The three stages one batch sweeps, named as Phase 2H-1 names them.
 *
 * `OUTPUT_VERIFIED` is deliberately absent: it is finished, and including it
 * would send a completed attempt to a status source for no reason — an external
 * call with nothing to learn and a locator to leak.
 */
export type ProviderOutputCandidateStage =
  | "AWAITING_PROVIDER_COMPLETION"
  | "AWAITING_OUTPUT_INGESTION"
  | "RESUMABLE_OUTPUT_INGESTION";

/**
 * The minimum a status source needs to identify one provider job.
 *
 * Three application-owned identifiers and nothing else. No organization, no
 * attempt id, no prompt, no source image, no request hash, no pricing, no
 * billing — a vendor asking "what happened to prediction X" has no use for any
 * of it, and every field that travels is a field that can be logged by the
 * far side.
 */
export interface ProviderStatusLookupRef {
  readonly providerName: string;
  readonly providerModelId: string;
  readonly providerPredictionId: string;
}

/**
 * The status source port.
 *
 * Returns `unknown`: a future adapter reads a vendor's JSON, and the
 * orchestrator validates rather than trusts. There is no production
 * implementation, no registry keyed on current environment defaults, and no
 * transport anywhere in this module's dependency graph. A future infrastructure
 * layer may route on `providerName` — the persisted one.
 */
export interface ProviderCompletionStatusSource {
  poll(ref: ProviderStatusLookupRef): Promise<unknown>;
}

export interface ProviderOutputDeps {
  readonly polling: ProviderPollingContextReader;
  readonly statusSource: ProviderCompletionStatusSource;
  readonly transfer: ManagedOutputTransferPort;
  /** Phase 2H-1's service — the authority for every state change here. */
  readonly completion: ProviderCompletionService;
}

export interface RunProviderOutputAttemptInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly context: TransitionContext;
}

export interface RunProviderOutputBatchInput {
  /**
   * A **global** hard cap on unique attempts one invocation may process,
   * validated before any query runs.
   *
   * Not a per-stage cap. Three stages each bounded at 100 would let one batch
   * touch 300 rows while reporting a limit of 100 — and the three stages are
   * not disjoint over the life of a batch, because processing an attempt can
   * move it into a later stage.
   */
  readonly limit: number;
  readonly context: TransitionContext;
}

/**
 * Everything one run of one attempt can conclude.
 *
 * Closed, and closed at a coarse grain on purpose. No arm carries a provider
 * error, a response body, a URL, a storage diagnostic or the locator; several
 * distinct external failures deliberately collapse into one outcome, because the
 * difference between them is only expressible in the vendor's own words and
 * those words are exactly what must not travel.
 *
 * There is deliberately **no `OUTPUT_INGESTION_STARTED`**. A run that starts
 * ingestion always goes on to attempt the transfer in the same run, so every
 * such run ends on an outcome describing what the transfer achieved —
 * `OUTPUT_VERIFIED`, `TRANSFER_RETRYABLE_FAILURE`, `TRANSFER_SOURCE_FAILED` and
 * so on. An arm no path can return is worse than an absent one: it reads as a
 * reachable outcome and invites a caller to handle a case that never arrives.
 */
export type ProviderOutputRunResult =
  /** The provider is still working. Nothing was written. */
  | { readonly kind: "STILL_PROCESSING" }
  /** A provider outcome was persisted by this run. */
  | { readonly kind: "PROVIDER_COMPLETION_APPLIED" }
  /** A provider outcome was already on file; this run wrote nothing. */
  | { readonly kind: "PROVIDER_COMPLETION_REPLAYED" }
  /**
   * The provider succeeded — and that is now durable — but no usable download
   * location could be obtained. A later run may poll again purely to reacquire
   * one.
   */
  | { readonly kind: "OUTPUT_LOCATOR_UNAVAILABLE" }
  /** Another runner won the ingestion transition; this one does not transfer. */
  | { readonly kind: "INGESTION_ALREADY_CLAIMED" }
  /** The managed output is now verified. */
  | { readonly kind: "OUTPUT_VERIFIED" }
  /** An identical verification was already on file. */
  | { readonly kind: "OUTPUT_VERIFICATION_REPLAYED" }
  /** The attempt was already verified before this run started. */
  | { readonly kind: "ALREADY_VERIFIED" }
  /** The transfer reported a transient problem. The attempt stays ingesting. */
  | { readonly kind: "TRANSFER_RETRYABLE_FAILURE" }
  /** The transfer port threw or rejected. Not a provider failure. */
  | { readonly kind: "TRANSFER_SOURCE_FAILED" }
  /** The status source threw or rejected. Not a provider failure. */
  | { readonly kind: "STATUS_SOURCE_FAILED" }
  /** The status source returned something outside the closed contract. */
  | { readonly kind: "STATUS_OBSERVATION_MALFORMED" }
  /** The transfer port returned something outside the closed contract. */
  | { readonly kind: "TRANSFER_OUTCOME_MALFORMED" }
  /**
   * A poll contradicts what the platform has already durably recorded about the
   * provider — a failure reported for an attempt recorded as succeeded, or a
   * still-running answer for one already past it. Surfaced, never applied.
   */
  | { readonly kind: "PROVIDER_REALITY_CONFLICT"; readonly reason: ProviderRealityConflictReason }
  /** Missing, cross-tenant, legacy, or not in a state this phase acts on. */
  | { readonly kind: "ATTEMPT_NOT_FOUND" }
  | { readonly kind: "ATTEMPT_NOT_APPLICABLE"; readonly reason: NotApplicableReason }
  /** Persisted provider identity is unusable, so no source was called. */
  | { readonly kind: "ATTEMPT_CONTEXT_INVALID"; readonly reason: ContextInvalidReason }
  /** Phase 2H-1's compare-and-set lost a race. A later run may retry. */
  | { readonly kind: "LOST_CONCURRENCY" };

export type ProviderRealityConflictReason =
  /** A later poll reports failure for an attempt recorded as succeeded. */
  | "FAILED_AGAINST_RECORDED_SUCCESS"
  /** A poll reports still-running for an attempt already past that point. */
  | "IN_PROGRESS_AGAINST_RECORDED_SUCCESS"
  /** Phase 2H-1 refused the completion as contradicting the record. */
  | "COMPLETION_CONFLICT";

export type NotApplicableReason =
  /** The attempt moved out from under this run between read and write. */
  | "ATTEMPT_STATE_MOVED"
  /** Phase 2H-1 declined the transition for a reason this run does not override. */
  | "TRANSITION_REFUSED";

export type ContextInvalidReason =
  | "PROVIDER_NAME_BLANK"
  | "PROVIDER_MODEL_ID_BLANK"
  | "PROVIDER_PREDICTION_ID_BLANK";

/** What one bounded pass did, in closed counts. Never in prose. */
export interface ProviderOutputBatchReport {
  /**
   * How many **unique** attempts this invocation actually processed.
   *
   * Not how many rows the three queries returned. Discovery happens entirely
   * before processing and is then deduplicated on `(organizationId, attemptId)`
   * and capped at the global limit, so this is the size of the frozen set that
   * was run — never larger than `limit`, and never counting one attempt twice.
   */
  readonly candidates: number;
  /**
   * One entry per processed attempt, carrying only the closed result kind.
   *
   * `results.length === candidates`, always: each selected attempt is run
   * exactly once, so there is no attempt with two entries and none with zero.
   */
  readonly results: readonly ProviderOutputRunResult["kind"][];
}
