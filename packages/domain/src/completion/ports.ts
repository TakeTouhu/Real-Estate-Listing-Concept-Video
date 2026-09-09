import type { EpochMillis } from "../pricing/units";
import type { TransitionContext } from "../orchestration/ports";
import type { SubmissionClock } from "../submission/ports";
import type {
  CompletingAttemptFacts,
  CompletionConflictReason,
  CompletionWrite,
  NotFinalizableReason,
  NotIngestibleReason,
  NotProcessingReason,
  OutputConflictReason,
} from "./decide";
import type { ProviderCompletionObservation } from "./observation";
import type {
  ManagedOutputVerificationReceipt,
  SafePositiveByteCount,
  Sha256Digest,
} from "./output";

/**
 * What recording a provider completion and a verified managed output needs from
 * persistence.
 *
 * A repository and a clock. **No provider client, no HTTP, no object storage,
 * and no way to add one without editing this file.** The completion evidence and
 * the integrity receipt both arrive as arguments; the layer that will one day
 * poll a provider and copy its bytes belongs to a later phase with a different
 * dependency set.
 */

/** Everything one decision reads, loaded under one lock. */
export interface CompletionFacts {
  readonly attempt: CompletingAttemptFacts;
}

/**
 * The serialized write boundary.
 *
 * `withCompletingAttempt` runs its callback inside one transaction already
 * holding this phase's locks, in the order Phases 2F-1, 2G-1 and 2G-2 fixed:
 * organization+cycle advisory lock, then the authoritative attempt read, then
 * the compare-and-set. The reservation row is deliberately *not* locked here —
 * nothing in this phase touches customer entitlement — but the advisory lock is
 * still taken so a completion cannot land while an authorization is reading the
 * cycle's exposure mid-flight.
 */
export interface CompletionRepository {
  withCompletingAttempt<T>(
    input: { readonly organizationId: string; readonly attemptId: string },
    run: (session: CompletionSession) => Promise<T>,
  ): Promise<T>;

  /**
   * Bounded, advisory discovery of attempts a future worker might act on.
   *
   * Returns identifiers only. It takes no locks and holds none: by the time a
   * caller acts, another worker may already have moved the row, which is why
   * every candidate still goes through the single-attempt service and is
   * re-checked there under lock.
   */
  findCompletionCandidates(
    input: CompletionCandidateQuery,
  ): Promise<readonly CompletionCandidate[]>;
}

/** Which stage of the post-acceptance lifecycle to look for. */
export type CompletionCandidateStage =
  /** `PROCESSING + ACCEPTED` — the provider may have finished. */
  | "AWAITING_PROVIDER_COMPLETION"
  /** `PROVIDER_SUCCEEDED + ACCEPTED` — output is ready to copy. */
  | "AWAITING_OUTPUT_INGESTION"
  /**
   * `OUTPUT_INGESTING + ACCEPTED` — a copy started and did not finish.
   *
   * Included because ingestion is resumable by design: an interrupted copy
   * leaves the attempt here rather than failing it, and this is how a later
   * worker finds it again.
   */
  | "RESUMABLE_OUTPUT_INGESTION";

export interface CompletionCandidateQuery {
  readonly stage: CompletionCandidateStage;
  /** A hard bound. Discovery never returns an unbounded batch. */
  readonly limit: number;
}

/** Identifiers only — deliberately not enough to decide anything with. */
export interface CompletionCandidate {
  readonly organizationId: string;
  readonly attemptId: string;
}

export interface CompletionSession {
  /** `null` when the attempt is missing, cross-tenant, or not orchestrated. */
  loadFacts(): Promise<CompletionFacts | null>;

  /** Move the execution state, and nothing else. */
  applyCompletion(input: {
    readonly expectedVersion: number;
    readonly write: CompletionWrite;
    readonly context: TransitionContext;
  }): Promise<ApplyCompletionResult>;

  /** `PROVIDER_SUCCEEDED → OUTPUT_INGESTING`, and nothing else. */
  applyBeginIngestion(input: {
    readonly expectedVersion: number;
    readonly context: TransitionContext;
  }): Promise<ApplyCompletionResult>;

  /** `OUTPUT_INGESTING → OUTPUT_VERIFIED`, with the four integrity facts. */
  applyOutputVerification(input: ApplyOutputVerificationInput): Promise<ApplyCompletionResult>;
}

/**
 * What persistence is told about a verified output — and, more importantly, what
 * it is not told.
 *
 * **There is no storage key here.** The service derives one and the repository
 * derives it again, independently, from the organization and attempt the
 * transaction was opened for. That is not redundancy: this boundary is reachable
 * without the service, exactly as the tenant mutation boundary was in Phases
 * 2G-1 and 2G-2, so a key parameter here would let any caller holding a session
 * point a verification record at an arbitrary path — another attempt's object, a
 * provider URL, anything. Removing the parameter makes that state unspellable
 * rather than merely refused.
 *
 * `outputVerifiedAt` is the service's single post-lock instant, carried as a
 * value so the repository never reads a clock of its own.
 */
export interface ApplyOutputVerificationInput {
  readonly expectedVersion: number;
  readonly outputSha256: Sha256Digest;
  readonly outputSizeBytes: SafePositiveByteCount;
  readonly outputVerifiedAt: EpochMillis;
  readonly context: TransitionContext;
}

export type ApplyCompletionResult =
  | { readonly kind: "APPLIED"; readonly stateVersion: number }
  | { readonly kind: "LOST" };

export interface CompletionDeps {
  readonly completion: CompletionRepository;
  readonly clock: SubmissionClock;
}

/** The whole caller-supplied input for recording a provider completion. */
export interface RecordProviderCompletionInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly observation: ProviderCompletionObservation;
  readonly context: TransitionContext;
}

/** The whole caller-supplied input for starting managed ingestion. */
export interface BeginOutputIngestionInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly context: TransitionContext;
}

/**
 * The whole caller-supplied input for closing a managed output.
 *
 * Note what is absent: the storage key, which the service derives, and
 * `outputVerifiedAt`, which comes from the post-lock clock. A caller able to
 * supply either could point a verification record at another object or backdate
 * when the platform proved the bytes.
 */
export interface FinalizeOutputVerificationInput {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly receipt: ManagedOutputVerificationReceipt;
  readonly context: TransitionContext;
}

/** The closed result of recording one provider completion. */
export type ProviderCompletionResult =
  | { readonly kind: "APPLIED"; readonly attemptId: string; readonly stateVersion: number }
  | { readonly kind: "REPLAYED"; readonly attemptId: string }
  | { readonly kind: "ATTEMPT_NOT_FOUND" }
  | { readonly kind: "ATTEMPT_NOT_PROCESSING"; readonly reason: NotProcessingReason }
  | { readonly kind: "CONFLICTING_COMPLETION"; readonly reason: CompletionConflictReason }
  | { readonly kind: "OBSERVATION_MALFORMED" }
  | { readonly kind: "LOST_CONCURRENCY" };

/** The closed result of starting managed output ingestion. */
export type BeginOutputIngestionResult =
  | { readonly kind: "APPLIED"; readonly attemptId: string; readonly stateVersion: number }
  | { readonly kind: "ALREADY_INGESTING"; readonly attemptId: string }
  | { readonly kind: "ALREADY_VERIFIED"; readonly attemptId: string }
  | { readonly kind: "ATTEMPT_NOT_FOUND" }
  | { readonly kind: "NOT_INGESTIBLE"; readonly reason: NotIngestibleReason }
  | { readonly kind: "LOST_CONCURRENCY" };

/** The closed result of closing one managed output. */
export type FinalizeOutputVerificationResult =
  | {
      readonly kind: "APPLIED";
      readonly attemptId: string;
      readonly stateVersion: number;
      readonly outputStorageKey: string;
      readonly outputVerifiedAt: EpochMillis;
    }
  | { readonly kind: "REPLAYED"; readonly attemptId: string }
  | { readonly kind: "ATTEMPT_NOT_FOUND" }
  | { readonly kind: "NOT_INGESTING"; readonly reason: NotFinalizableReason }
  | { readonly kind: "CONFLICTING_OUTPUT"; readonly reason: OutputConflictReason }
  | { readonly kind: "RECEIPT_MALFORMED" }
  | { readonly kind: "LOST_CONCURRENCY" };
