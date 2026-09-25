/**
 * The composition-execution boundaries.
 *
 * Four ports, and the split is the safety argument: the only thing that touches
 * a database is the repository, the only thing that reads object storage is the
 * materializer, the only thing that runs a subprocess is the composer, and the
 * only thing that writes the canonical object is the publisher. No transaction
 * spans any of the other three — a database transaction held open across a
 * gigabyte download and a twenty-minute encode is a connection the pool never
 * gets back.
 *
 * Every port returns a **closed** outcome. Storage messages, ffmpeg stderr, OS
 * errno values, bucket names and local paths stop at each boundary; what crosses
 * is a member of a small application vocabulary.
 */

import type { TransitionContext } from "../orchestration/ports";
import type { CompositionProfile } from "./profile";
import type {
  DeliverableCompositionRetryCode,
  DeliverableCompositionStatus,
  ManagedDeliverableOutputKey,
} from "./durable";
import type { ManagedGenerationOutputKey, Sha256Digest, SafePositiveByteCount } from "../completion/output";

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

/**
 * A candidate is identifiers only.
 *
 * No key, no receipt, no profile, no media path. Everything needed to *decide*
 * is deliberately absent, so a caller cannot mistake the listing for permission:
 * between listing and claiming, another worker may have taken the lease or the
 * job may have moved. `claimCompositionWork` re-reads and re-checks under its
 * own locks.
 */
export interface DeliverableCompositionCandidate {
  readonly deliverableVersionId: string;
  readonly generationJobId: string;
  readonly organizationId: string;
}

export interface DeliverableCompositionQuery {
  readonly limit: number;
  readonly now: number;
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/** One frozen scene input, as execution needs it. */
export interface CompositionSceneInput {
  readonly position: number;
  readonly generationSceneId: string;
  readonly sceneGenerationAttemptId: string;
  /** The canonical managed object holding this scene's verified bytes. */
  readonly sourceStorageKey: ManagedGenerationOutputKey;
  readonly sourceSha256: Sha256Digest;
  readonly sourceSizeBytes: SafePositiveByteCount;
  /** The scene's immutable snapshot duration — the only live Scene fact used. */
  readonly durationSeconds: number;
}

/**
 * Everything one composition execution needs, read once under the claim's locks.
 *
 * Self-contained on purpose: once this is returned the transaction is over, and
 * the worker must not need to go back to the database to know what to compose.
 */
export interface DeliverableCompositionClaim {
  readonly organizationId: string;
  readonly generationJobId: string;
  readonly deliverableVersionId: string;
  readonly compositionId: string;
  readonly leaseToken: string;
  /** The row version this claim observed. Every later write names it. */
  readonly version: number;
  readonly attemptCount: number;
  /** Frozen at first claim, reused verbatim by every retry. */
  readonly profile: CompositionProfile;
  readonly outputStorageKey: ManagedDeliverableOutputKey;
  /** In plan order: position ASC. */
  readonly scenes: readonly CompositionSceneInput[];
}

export type ClaimCompositionWorkOutcome =
  | { readonly kind: "CLAIMED"; readonly claim: DeliverableCompositionClaim }
  /**
   * Another worker holds an unexpired lease, the work is deferred and not yet
   * due, or the job has moved on. An ordinary outcome.
   */
  | { readonly kind: "NOT_CLAIMABLE" }
  /** Already composed and verified; nothing to do. */
  | { readonly kind: "ALREADY_VERIFIED" }
  /** No such deliverable version visible to this organization. */
  | { readonly kind: "NOT_FOUND" };

export interface ClaimCompositionWorkInput {
  readonly organizationId: string;
  readonly deliverableVersionId: string;
  readonly now: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
  readonly context: TransitionContext;
}

// ---------------------------------------------------------------------------
// Finalize and defer
// ---------------------------------------------------------------------------

export interface FinalizeCompositionInput {
  readonly claim: DeliverableCompositionClaim;
  readonly outputSha256: Sha256Digest;
  readonly outputSizeBytes: SafePositiveByteCount;
  readonly verifiedAt: number;
  readonly context: TransitionContext;
}

export type FinalizeCompositionOutcome =
  | { readonly kind: "FINALIZED" }
  /** This exact receipt is already durable. No second event is appended. */
  | { readonly kind: "ALREADY_FINALIZED" }
  /**
   * The lease or row version moved on: another worker reclaimed this work while
   * this one was composing. The composed object is harmless — publication is
   * first-wins — but this caller may not write the receipt.
   */
  | { readonly kind: "LEASE_LOST" };

export interface DeferCompositionInput {
  readonly claim: DeliverableCompositionClaim;
  readonly retryCode: DeliverableCompositionRetryCode;
  readonly nextAttemptAt: number;
}

export type DeferCompositionOutcome =
  | { readonly kind: "DEFERRED" }
  | { readonly kind: "LEASE_LOST" };

export interface DeliverableCompositionRecord {
  readonly id: string;
  readonly deliverableVersionId: string;
  readonly status: DeliverableCompositionStatus;
  readonly attemptCount: number;
  readonly version: number;
  readonly lastRetryCode: DeliverableCompositionRetryCode | null;
  readonly outputStorageKey: string | null;
  readonly outputSha256: string | null;
  readonly outputSizeBytes: bigint | null;
}

export interface DeliverableCompositionRepository {
  /** Bounded, deterministic, identifiers only. A hint, never authority. */
  findCompositionCandidates(
    query: DeliverableCompositionQuery,
  ): Promise<readonly DeliverableCompositionCandidate[]>;

  /**
   * Transaction J1 (first claim) and the retry claim, in one short transaction.
   *
   * Database-only. The first claim additionally moves the job
   * `COMPOSITION_PENDING -> COMPOSING`; a retry leaves the job alone, because
   * the job is already composing and a second transition event would claim a
   * state change that did not happen.
   */
  claimCompositionWork(
    input: ClaimCompositionWorkInput,
  ): Promise<ClaimCompositionWorkOutcome>;

  /**
   * Transaction J2, in one short transaction: the durable receipt and
   * `COMPOSING -> DELIVERABLE_VALIDATING`, together or not at all.
   */
  finalizeComposition(
    input: FinalizeCompositionInput,
  ): Promise<FinalizeCompositionOutcome>;

  /** Return deferred work to `PENDING` with a closed code and a future instant. */
  deferComposition(input: DeferCompositionInput): Promise<DeferCompositionOutcome>;

  /** Read-only, for tests and operators. Never an authority for execution. */
  findCompositionByVersionId(
    organizationId: string,
    deliverableVersionId: string,
  ): Promise<DeliverableCompositionRecord | null>;
}

// ---------------------------------------------------------------------------
// Source materialization
// ---------------------------------------------------------------------------

/** One source the composer will read, already proved to be the planned bytes. */
export interface MaterializedCompositionSource {
  readonly position: number;
  /** An application-created local path. Never derived from customer data. */
  readonly localPath: string;
}

export type MaterializeCompositionSourcesOutcome =
  | {
      readonly kind: "MATERIALIZED";
      readonly sources: readonly MaterializedCompositionSource[];
      /** Releases the temporary directory. Safe to call more than once. */
      readonly release: () => Promise<void>;
    }
  /** Storage could not be read this time. Nothing about the plan is wrong. */
  | { readonly kind: "RETRYABLE_FAILURE" }
  /**
   * A canonical source object's bytes no longer match the receipt the plan
   * froze. Never fed to the composer, never silently replaced with another
   * attempt's output, and never a customer-facing failure on its own.
   */
  | { readonly kind: "INTEGRITY_MISMATCH" }
  /** The plan's total source bytes exceed what one worker may hold. */
  | { readonly kind: "SOURCE_BUDGET_EXCEEDED" };

export interface DeliverableCompositionSourceMaterializer {
  /**
   * Stream every canonical source to private local files, in plan order,
   * hashing and counting as it goes.
   *
   * Nothing is buffered whole in memory, and a source whose digest or byte count
   * disagrees with the frozen receipt stops the whole materialization — a
   * deliverable composed from bytes nobody validated is worse than no
   * deliverable. On every failure path the temporary directory is removed.
   */
  materialize(input: {
    readonly organizationId: string;
    readonly scenes: readonly CompositionSceneInput[];
  }): Promise<MaterializeCompositionSourcesOutcome>;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** One clip as the composer sees it: a local file and an exact duration. */
export interface ComposerClip {
  readonly localPath: string;
  readonly durationSeconds: number;
}

export interface ComposeDeliverableInput {
  readonly clips: readonly ComposerClip[];
  readonly profile: CompositionProfile;
  readonly outputPath: string;
}

export type ComposeDeliverableOutcome =
  | { readonly kind: "SUCCESS" }
  /**
   * The composer ran and did not produce a usable result, or could not be run
   * this time. Deliberately one member: from outside this boundary a non-zero
   * exit and a timeout are the same instruction — try again later — and
   * distinguishing them would require carrying diagnostics across the port.
   */
  | { readonly kind: "RETRYABLE_FAILURE" };

export interface DeliverableMediaComposer {
  /**
   * Compose the clips into one file at `outputPath`.
   *
   * No stderr, command line, exit object or OS error crosses this boundary. A
   * composer that cannot be launched at all is a *deployment* fault and throws a
   * fixed `CONFIGURATION_ERROR` rather than reporting a retryable failure —
   * retrying a missing binary forever is not recovery.
   */
  compose(input: ComposeDeliverableInput): Promise<ComposeDeliverableOutcome>;
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

export type PublishDeliverableOutcome =
  | {
      /**
       * The canonical object exists and this is its receipt — **read from the
       * object that is actually there**, which may be one an earlier crashed
       * attempt published rather than the file just composed.
       */
      readonly kind: "PUBLISHED";
      readonly sha256: Sha256Digest;
      readonly sizeBytes: SafePositiveByteCount;
    }
  | { readonly kind: "RETRYABLE_FAILURE" }
  /** The composed object exceeds the deliverable ceiling. */
  | { readonly kind: "OUTPUT_TOO_LARGE" };

export interface DeliverableOutputPublisher {
  /**
   * Publish the composed file to the canonical deliverable key, first-wins.
   *
   * A retry must never overwrite an existing canonical object: an earlier
   * attempt may have published bytes a later phase already verified. When the
   * key is occupied the publisher re-reads **that** object and returns its
   * actual receipt, which is what makes "published, then crashed before the
   * database learned of it" recoverable.
   */
  publish(input: {
    readonly key: ManagedDeliverableOutputKey;
    readonly localPath: string;
  }): Promise<PublishDeliverableOutcome>;
}
