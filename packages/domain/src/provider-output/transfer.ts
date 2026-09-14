import type { ManagedGenerationOutputKey } from "../completion/output";
import { hasExactlyOwnKeys, isPlainRecord } from "../submission/untrusted";
import type { TransientProviderOutputLocator } from "./locator";

/**
 * Copying a provider's output into managed storage, as a contract rather than an
 * implementation.
 *
 * The domain still owns no implementation — no HTTP client, no S3, R2 or GCS
 * client, no credentials. A concrete streaming core now exists in
 * `@app/storage` (Phase 2H-3B-1) and satisfies this shape; the shape remains
 * the constraint on it, not the other way round.
 *
 * The destination type is imported from the completion module rather than
 * aliased here. While no writer existed a plain `string` alias documented
 * provenance well enough; a real writer needs the type to *enforce* it, and one
 * branded definition next to its only constructor is the way to have that
 * without a second validation boundary that could drift from the first.
 */

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
