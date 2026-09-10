import { hasExactlyOwnKeys, isPlainRecord } from "../submission/untrusted";
import type { TransientProviderOutputLocator } from "./locator";

/**
 * Copying a provider's output into managed storage, as a contract rather than an
 * implementation.
 *
 * **There is no concrete implementation in this phase.** No HTTP client, no S3,
 * R2 or GCS client, no credentials. What exists is the shape a future adapter
 * must satisfy — and defining it first is deliberate: the shape is the
 * constraint on its implementations, not the other way round.
 */

/**
 * Where the copy is going. Always derived, never chosen.
 *
 * A plain string alias rather than a new opaque type: the value is produced by
 * Phase 2H-1's `managedGenerationOutputKey` and the orchestrator has no other
 * source for one. Naming it here is documentation of that provenance, not a
 * second validation boundary — a second one could drift from the first.
 */
export type ManagedGenerationOutputKey = string;

export interface ManagedOutputTransferInput {
  /** Opaque, non-readable. The adapter that can dereference it does not exist. */
  readonly source: TransientProviderOutputLocator;
  /**
   * Derived by Phase 2H-1 from the organization and attempt.
   *
   * Neither the provider nor the caller chooses it. A provider-chosen
   * destination is a cross-tenant write waiting for the first vendor that
   * returns something unexpected; a caller-chosen one is the same hole with a
   * friendlier face.
   */
  readonly destinationKey: ManagedGenerationOutputKey;
}

/**
 * The transfer port.
 *
 * Returns `unknown` on purpose. A future adapter is infrastructure — it will
 * have a storage SDK in it and a response shape this layer should not be
 * modelling — so the orchestrator validates what comes back rather than trusting
 * a type it cannot enforce at the boundary.
 */
export interface ManagedOutputTransferPort {
  transferAndVerify(input: ManagedOutputTransferInput): Promise<unknown>;
}

/**
 * What a transfer can conclude, and deliberately nothing else.
 *
 * Two arms. There is no `TERMINAL_FAILURE`: this phase has no evidence that any
 * storage failure is permanent, and inventing that arm would invite a future
 * adapter to classify a transient outage as one — which, on a path whose only
 * safe response is "try again later", is how a paid, still-retrievable render
 * gets abandoned.
 *
 * The receipt stays `unknown` all the way through. Phase 2H-1's finalization is
 * the single authority on what a valid receipt is; parsing it here would create
 * a second validator, and two validators of one contract drift.
 */
export type ManagedOutputTransferOutcome =
  | { readonly kind: "VERIFIED"; readonly receipt: unknown }
  | { readonly kind: "RETRYABLE_FAILURE" };

export const VERIFIED_TRANSFER_KEYS: readonly string[] = ["kind", "receipt"];
export const RETRYABLE_FAILURE_TRANSFER_KEYS: readonly string[] = ["kind"];

/**
 * Whether a transfer port returned something this orchestrator can act on.
 *
 * Only the top level is checked — the discriminant and the exact own keys. The
 * receipt's *contents* are not inspected here, which is the point: it travels to
 * Phase 2H-1 exactly as received, and that boundary decides whether the digest
 * and byte count are real.
 *
 * `RETRYABLE_FAILURE` carrying a message or a URL is malformed rather than
 * tolerated. A storage adapter's error text is external data, and the moment a
 * field exists to carry it, something will log it, and a signed URL will be in
 * that log.
 */
export function isWellFormedTransferOutcome(
  value: unknown,
): value is ManagedOutputTransferOutcome {
  if (!isPlainRecord(value)) return false;

  switch (value.kind) {
    case "VERIFIED":
      // `receipt` must be *present*, and may be anything: absence is a defect in
      // the adapter, while contents are Phase 2H-1's question.
      return hasExactlyOwnKeys(value, VERIFIED_TRANSFER_KEYS);
    case "RETRYABLE_FAILURE":
      return hasExactlyOwnKeys(value, RETRYABLE_FAILURE_TRANSFER_KEYS);
    default:
      return false;
  }
}
