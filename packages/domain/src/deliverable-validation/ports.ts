/**
 * The deliverable-validation and publication boundaries.
 *
 * Two ports, and the split is the safety argument: the only thing that touches
 * the database is the repository, and the only thing that reads object storage
 * and runs an inspector is the validator. No method here takes a callback, so
 * there is no way for a transaction to wrap an S3 GET, a temp-file
 * materialization or an `ffprobe` invocation — a pooled connection held across a
 * multi-hundred-megabyte download is a connection the pool never gets back while
 * the work is not touching the database at all.
 *
 * ## Why publication is a separate operation
 *
 * `finalizeValid` records a verdict; `publishDeliverable` — Transaction G — makes
 * that verdict the customer's video. Folding them together would be simpler and
 * would delete a state this system needs: *validated, not yet published*. A
 * process that dies between the two must be recoverable, and it is recoverable
 * only because the `VALID` row survives on its own and the next sweep finds a
 * `DELIVERABLE_VALIDATING` job standing behind it.
 *
 * It also keeps the two facts honestly separable. A verdict is evidence about
 * bytes; publication spends a customer's entitlement and moves what they can
 * download. Those are not the same commit's business even when they are one
 * sweep's work.
 */

import type {
  ManagedOutputVerificationReceipt,
  SafePositiveByteCount,
  Sha256Digest,
} from "../completion/output";
import type { ManagedDeliverableOutputKey } from "../deliverable-composition-execution/durable";
import type { TransitionContext } from "../orchestration/ports";
import type {
  ManagedOutputMediaFacts,
  ManagedOutputMediaInvalidReason,
} from "../provider-output/media-validation";
import type {
  DeliverableValidationReceiptBinding,
  DurableDeliverableValidationRecord,
} from "./durable";

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

/**
 * A candidate is identifiers only.
 *
 * No key, no receipt, no status, no verdict. Everything needed to *decide* is
 * deliberately absent, so a caller cannot mistake the listing for permission:
 * between the listing and the claim another worker may have taken the lease, the
 * verdict may have been written, or the job may have been published. The claim
 * re-reads and re-checks under its own locks.
 */
export interface DeliverableValidationCandidate {
  readonly deliverableVersionId: string;
  readonly generationJobId: string;
  readonly organizationId: string;
}

export interface DeliverableValidationQuery {
  readonly limit: number;
  /** Epoch ms. Due-ness and lease expiry are judged against this instant. */
  readonly now: number;
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/**
 * Ownership of one deliverable validation, self-contained on purpose.
 *
 * Once this is returned the transaction is over, so the worker must not need to
 * go back to the database to know what to validate. The receipt travels with it
 * because every later write re-asserts it: a finalize that could not name the
 * bytes it judged would be a verdict about whatever is at the key by then.
 */
export interface DeliverableValidationClaim {
  readonly organizationId: string;
  readonly generationJobId: string;
  readonly deliverableVersionId: string;
  readonly validationId: string;
  readonly leaseToken: string;
  /** The row version this claim observed. Every later write names it. */
  readonly version: number;
  readonly attemptCount: number;
  /** The canonical managed object this verdict is about. */
  readonly outputStorageKey: ManagedDeliverableOutputKey;
  /** Frozen from the composition's durable receipt, never re-derived. */
  readonly expectedReceipt: ManagedOutputVerificationReceipt;
}

/**
 * What one claim attempt concluded.
 *
 * `ALREADY_VALID` is separate from `ALREADY_TERMINAL`, and the separation is the
 * whole recovery path: a `VALID` row behind a job that is still
 * `DELIVERABLE_VALIDATING` has a publication outstanding, and the caller must go
 * on to Transaction G rather than treat the row as finished. An `INVALID_MEDIA`
 * or `INTEGRITY_MISMATCH` row is finished, and nobody revisits it.
 */
export type ClaimDeliverableValidationOutcome =
  | { readonly kind: "CLAIMED"; readonly claim: DeliverableValidationClaim }
  /** Another worker holds an unexpired lease, or the row is not yet due. */
  | { readonly kind: "NOT_CLAIMABLE" }
  /** A `VALID` verdict already exists. Publication may still be outstanding. */
  | {
      readonly kind: "ALREADY_VALID";
      readonly publication: DeliverableValidationPublicationTarget;
    }
  /** A terminal non-`VALID` verdict already exists. Never reopened. */
  | { readonly kind: "ALREADY_TERMINAL" }
  /** The job is not awaiting deliverable validation. An ordinary outcome. */
  | { readonly kind: "NOT_ELIGIBLE" }
  /** No such deliverable version visible to this organization. */
  | { readonly kind: "NOT_FOUND" };

// ---------------------------------------------------------------------------
// Finalize and defer
// ---------------------------------------------------------------------------

export interface FinalizeDeliverableValidationValidInput {
  readonly claim: DeliverableValidationClaim;
  readonly facts: ManagedOutputMediaFacts;
  /** Epoch ms. */
  readonly validatedAt: number;
  readonly context: TransitionContext;
}

export interface FinalizeDeliverableValidationInvalidInput {
  readonly claim: DeliverableValidationClaim;
  readonly reason: ManagedOutputMediaInvalidReason;
  readonly validatedAt: number;
}

export interface FinalizeDeliverableValidationMismatchInput {
  readonly claim: DeliverableValidationClaim;
  readonly validatedAt: number;
}

/**
 * What finalizing a `VALID` verdict concluded.
 *
 * Both written arms carry the publication target, and that is what keeps the
 * runner honest: there is no path on which a `VALID` verdict exists and the
 * caller is left without the identity Transaction G needs. A replay of the same
 * verdict answers `ALREADY_FINALIZED` *with* the target, because the publication
 * behind it may still be outstanding.
 *
 * `LEASE_LOST` is the safe outcome, not an error: the write matched zero rows
 * because the lease token, the row version or the receipt binding no longer
 * agrees. A worker whose lease expired and whose row was reclaimed must lose
 * here, and must not treat losing as a failure worth retrying or reporting.
 */
export type FinalizeDeliverableValidOutcome =
  | {
      readonly kind: "FINALIZED";
      readonly publication: DeliverableValidationPublicationTarget;
    }
  /** This exact verdict is already durable. No second event is appended. */
  | {
      readonly kind: "ALREADY_FINALIZED";
      readonly publication: DeliverableValidationPublicationTarget;
    }
  | { readonly kind: "LEASE_LOST" };

/**
 * What finalizing a terminal non-`VALID` verdict concluded.
 *
 * Deliberately carries no publication target on any arm. There is nothing to
 * publish, and a field that could hold one would be a field a later edit could
 * start reading on this path.
 */
export type FinalizeDeliverableVerdictOutcome =
  | { readonly kind: "FINALIZED" }
  /** This exact verdict is already durable. No second write. */
  | { readonly kind: "ALREADY_FINALIZED" }
  | { readonly kind: "LEASE_LOST" };

export interface DeferDeliverableValidationInput {
  readonly claim: DeliverableValidationClaim;
  /** Epoch ms at which the row becomes eligible again. */
  readonly nextAttemptAt: number;
}

export type DeferDeliverableValidationOutcome =
  | { readonly kind: "DEFERRED" }
  | { readonly kind: "LEASE_LOST" };

// ---------------------------------------------------------------------------
// Transaction G — publication
// ---------------------------------------------------------------------------

/**
 * The identity of a proved-usable deliverable, as Transaction G must be asked
 * for it.
 *
 * Deliberately the identity and the receipt, and nothing about *how* the verdict
 * was reached: no facts, no lease, no attempt count. Transaction G's job is to
 * publish a deliverable whose validity is already durable, and giving it the
 * media facts would invite it to re-decide validity from values it did not
 * measure.
 *
 * The row version is carried so the publication names the exact `VALID` row it
 * was derived from. A verdict cannot change once terminal, so this is not a CAS
 * against a moving value — it is a refusal to publish against a row that is not
 * the row the caller read.
 */
export interface DeliverableValidationPublicationTarget {
  readonly organizationId: string;
  readonly generationJobId: string;
  readonly deliverableVersionId: string;
  readonly validationId: string;
  readonly validationVersion: number;
  readonly receipt: DeliverableValidationReceiptBinding;
}

export interface PublishValidatedDeliverableInput {
  readonly publication: DeliverableValidationPublicationTarget;
  /** Epoch ms. Stamped on the hold when a unit is actually spent. */
  readonly publishedAt: number;
  readonly context: TransitionContext;
}

/**
 * What Transaction G concluded.
 *
 * `UNIT_CONSUMED` and `POINTER_MOVED` are separate members rather than a boolean
 * on one, because they are different business facts and a caller that cannot
 * tell them apart cannot report either honestly. An initial publication spends
 * the customer's entitlement; a recomposition replaces a video they already paid
 * for, and spending a second unit for it would charge twice for one job.
 */
export type PublishValidatedDeliverableOutcome =
  /** The first deliverable of this job. Pointer set, one unit spent. */
  | { readonly kind: "PUBLISHED_AND_CONSUMED" }
  /** A replacement for a deliverable the customer already holds. No unit. */
  | { readonly kind: "PUBLISHED_AS_REPLACEMENT" }
  /**
   * This exact publication is already durable. No write, no second event, and
   * above all no second consume.
   */
  | { readonly kind: "ALREADY_PUBLISHED" }
  /**
   * The job is no longer awaiting this version's publication — it moved on, or a
   * different version became current. An ordinary outcome, and deliberately not
   * a defect: a superseded cycle is a normal thing to lose.
   */
  | { readonly kind: "NOT_PUBLISHABLE" };

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

export interface DeliverableValidationRepository {
  /** Bounded, deterministic, identifiers only. A hint, never authority. */
  findValidationCandidates(
    query: DeliverableValidationQuery,
  ): Promise<readonly DeliverableValidationCandidate[]>;

  /**
   * Re-check eligibility and take ownership, in one short transaction.
   *
   * Creates the row when absent — a deliverable composed before this phase
   * existed carries no validation record, and is discovered here rather than
   * backfilled. The receipt is copied from the composition's durable output
   * receipt under the same locks, so a record can never be created against bytes
   * the composition does not claim.
   */
  claimDeliverableValidation(input: {
    readonly organizationId: string;
    readonly deliverableVersionId: string;
    readonly now: number;
    /** Opaque, carrying no tenant, job, deliverable or key identity. */
    readonly leaseToken: string;
    readonly leaseExpiresAt: number;
  }): Promise<ClaimDeliverableValidationOutcome>;

  /** `RUNNING` → `VALID`, with the normalized media facts and one event. */
  finalizeValid(
    input: FinalizeDeliverableValidationValidInput,
  ): Promise<FinalizeDeliverableValidOutcome>;

  /**
   * `RUNNING` → `INVALID_MEDIA`. The job is untouched and no event is appended.
   *
   * Not a customer-facing failure and not a settlement: during a recomposition
   * the customer may already hold a perfectly good video, and terminalizing the
   * job over a replacement that could not be validated would destroy it.
   */
  finalizeInvalidMedia(
    input: FinalizeDeliverableValidationInvalidInput,
  ): Promise<FinalizeDeliverableVerdictOutcome>;

  /** `RUNNING` → `INTEGRITY_MISMATCH`. Same restraint as `INVALID_MEDIA`. */
  finalizeIntegrityMismatch(
    input: FinalizeDeliverableValidationMismatchInput,
  ): Promise<FinalizeDeliverableVerdictOutcome>;

  /**
   * Return the row to `PENDING` with a future instant. Never a verdict.
   *
   * Only for failures a later attempt could genuinely survive. A storage hiccup
   * must never become a permanent record that a customer's deliverable is
   * unusable, and there is no deterministic-refusal arm here: the two
   * deterministic answers this work can reach — not media, and not the published
   * bytes — are verdicts, and they have their own terminal statuses.
   */
  deferValidation(
    input: DeferDeliverableValidationInput,
  ): Promise<DeferDeliverableValidationOutcome>;

  /**
   * Transaction G, in one short transaction: the publication boundary.
   *
   * `DELIVERABLE_VALIDATING -> DELIVERABLE_READY`, the job's deliverable pointer,
   * the entitlement consume where one is owed, and every transition event —
   * together or not at all. Nothing here reads object storage: the bytes were
   * proved usable before this was called, and re-reading them inside a
   * transaction that holds the entitlement lock would pin it across a download.
   */
  publishDeliverable(
    input: PublishValidatedDeliverableInput,
  ): Promise<PublishValidatedDeliverableOutcome>;

  /** Read-only, for tests and operators. Never an authority for execution. */
  findValidationByVersionId(
    organizationId: string,
    deliverableVersionId: string,
  ): Promise<DurableDeliverableValidationRecord | null>;
}

/** Produces opaque lease tokens. Injected so tests can be deterministic. */
export interface DeliverableValidationLeaseTokenFactory {
  next(): string;
}

// ---------------------------------------------------------------------------
// The media validator
// ---------------------------------------------------------------------------

/**
 * What one deliverable validation needs to see, and nothing else.
 *
 * A canonical deliverable key and the receipt the composition already proved. No
 * bucket, no signed URL, no provider identity, no job or organization id — the
 * adapter's own configuration supplies storage coordinates.
 *
 * This is a distinct input type from the provider-attempt validator's, because
 * the key is a distinct brand: a deliverable and one scene's provider output are
 * different identities with different lifecycles, and a single input type
 * covering both would let a deliverable receipt be checked against an attempt's
 * object. The *question* is the same, so the answer vocabulary is shared
 * verbatim — {@link ManagedOutputMediaValidationOutcome} and its parser are
 * reused rather than re-declared.
 */
export interface DeliverableMediaValidationInput {
  readonly deliverableKey: ManagedDeliverableOutputKey;
  readonly expectedReceipt: ManagedOutputVerificationReceipt;
}

/**
 * The validator port. Returns `unknown` for the same reason every
 * infrastructure port in this pipeline does: the implementation is an adapter
 * over a storage client and a subprocess, and the consumer validates what comes
 * back rather than trusting a type it cannot enforce at the boundary.
 */
export interface DeliverableMediaValidationPort {
  /**
   * Deliberately not called `validate`.
   *
   * One adapter answers this question for both kinds of managed object, and a
   * shared method name would force it to choose one input type or take a union
   * and sort the brands out at runtime. Two names let the *same* adapter satisfy
   * both ports with one private core, while each runner can still only be handed
   * the key type it owns.
   */
  validateDeliverable(input: DeliverableMediaValidationInput): Promise<unknown>;
}

/**
 * The receipt Transaction G will be asked to publish, as a domain value.
 *
 * A function rather than an inline object literal at the one call site, so the
 * branding is applied in exactly one place and a future second caller cannot
 * assemble a receipt binding out of unbranded numbers.
 */
export function deliverableValidationReceipt(input: {
  readonly sha256: Sha256Digest;
  readonly sizeBytes: SafePositiveByteCount;
}): DeliverableValidationReceiptBinding {
  return { sha256: input.sha256, sizeBytes: input.sizeBytes };
}
