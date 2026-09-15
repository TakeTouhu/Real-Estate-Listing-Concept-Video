import {
  hasExactlyOwnKeys,
  isPlainRecord,
  type ManagedGenerationOutputKey,
  type ManagedOutputVerificationReceipt,
} from "@app/domain";

/**
 * How generated output reaches managed storage: through an isolated staging
 * write that becomes canonical only on commit, and only if nothing else got
 * there first.
 *
 * This is an infrastructure contract, and it lives in `@app/storage` rather
 * than the domain because the domain has no business knowing that objects are
 * staged. The domain's contract is `ManagedOutputTransferPort` — "copy this and
 * tell me the digest" — and that stays exactly as Phase 2H-2 wrote it. What
 * this module adds is the discipline a concrete copy needs and a plain
 * `putObject(key, bytes)` cannot express:
 *
 * - **staging is invisible.** Writing bytes must not touch the canonical
 *   destination. A crash mid-copy leaves nothing at the key, which is the only
 *   state a later run can safely start from.
 * - **first publish wins.** Once a canonical object exists at a key, no later
 *   session may replace it — not with the same bytes, not with different ones.
 *   Phase 2H-2 permits at-least-once transfer for an already-ingesting attempt,
 *   so two sessions racing to the same key is an expected state of the world,
 *   and the one that lost must be able to *read* the winner rather than
 *   overwrite it.
 * - **the sink sees only what it needs.** A destination key derived by the
 *   application, bytes, and an integrity receipt. No provider URL, no locator,
 *   no organization beyond what the key already encodes.
 *
 * There is **no concrete durable implementation in this phase**. No S3, R2,
 * Azure Blob, GCS, multipart upload or production filesystem. The only sink in
 * the repository is the deterministic fake under `testing/`, and the static
 * suite asserts nothing in production constructs the core that consumes this.
 */

/**
 * Begin one isolated staging write for one canonical destination.
 *
 * The key is the branded value produced by `managedGenerationOutputKey`, and
 * only that. A sink that accepted a string could be handed a provider file
 * name; the brand makes the caller say, in a greppable cast, that it is doing
 * something unusual.
 */
export interface ManagedOutputStagingSink {
  begin(input: {
    readonly destinationKey: ManagedGenerationOutputKey;
  }): Promise<ManagedOutputStagingSession>;
}

/**
 * One staging write, from first byte to publish or abandonment.
 *
 * `write` resolves when the sink has taken the chunk — which is what lets the
 * consumer apply backpressure by simply not asking the source for the next one
 * until this resolves. `commit` atomically makes the staged bytes canonical, or
 * reports that something else already did, or asks for a retry. `abort`
 * discards staged state and is always safe to call after a failure; it is
 * never called after a successful commit, which owns its own cleanup.
 *
 * `commit` returns `unknown` for the reason every port in this pipeline does:
 * the implementation is infrastructure, and the consumer validates what comes
 * back rather than trusting a type it cannot enforce at the boundary.
 */
export interface ManagedOutputStagingSession {
  write(chunk: Uint8Array): Promise<void>;
  commit(input: { readonly receipt: ManagedOutputVerificationReceipt }): Promise<unknown>;
  abort(): Promise<void>;
}

/**
 * The one control signal for a transient storage-write interruption.
 *
 * `write` returns `Promise<void>`, so a durable sink whose part upload is dropped
 * mid-transfer — a socket reset, a throttled service response, a 5xx — has no arm
 * in that signature to say "not now, retry the acquisition". Left as a raw throw
 * it would reach the transfer core and be recorded as `TRANSFER_SOURCE_FAILED`,
 * treating an ordinary storage hiccup as an adapter defect. This is the
 * storage-side counterpart of the provider stream's retry signal: the durable
 * sink converts an expected upload/service rejection into this one
 * application-owned signal, and the transfer core recognizes it and returns
 * `RETRYABLE_FAILURE`.
 *
 * It is nominal (a private `#marker` brand, recognized by a static `is()` guard)
 * and deliberately empty. It carries **no** raw SDK exception, no `cause`, no
 * bucket, no object key, no AWS request ID, no endpoint, no credential, no
 * provider URL, and no external error message. The sink constructs it from
 * nothing — the caught rejection is discarded unread at the sink boundary — and
 * the core recognizes it by brand, never by shape.
 *
 * It is **not** a general error transport. It means exactly "expected retryable
 * storage-write interruption" and nothing else: an unbranded programming error, a
 * malformed value, or any unexpected throw is a different class the core keeps
 * treating as a defect, not a retry.
 */
export class ManagedOutputStagingRetryableFailure {
  readonly #marker: true;

  constructor() {
    this.#marker = true;
  }

  static is(value: unknown): value is ManagedOutputStagingRetryableFailure {
    return typeof value === "object" && value !== null && #marker in value;
  }
}

/**
 * What a commit can conclude, and deliberately nothing else.
 *
 * ```text
 * PUBLISHED          the staged bytes are now canonical at the destination
 * EXISTING           something else already published; here is *its* receipt
 * RETRYABLE_FAILURE  not now; the attempt stays ingesting
 * ```
 *
 * `EXISTING` carrying a receipt is the arm that makes crash recovery work.
 * Runner A publishes and dies before the database learns of it; runner B
 * resumes, downloads again, stages bytes that may differ, and commits. B must
 * finish the *database* against what is *actually at the key* — A's object —
 * so the sink hands back A's receipt and the transfer core reports that one,
 * not the receipt for B's abandoned bytes. The receipt is `unknown` here and
 * stays unknown: Phase 2H-1's finalization is the single authority on whether
 * a digest and byte count are real.
 *
 * No arm carries a message, a URL, a storage diagnostic or a provider field.
 * A storage adapter's error text is external data, and the moment a field
 * exists to carry it, something will log it.
 */
export type ManagedOutputStagingCommitOutcome =
  | { readonly kind: "PUBLISHED" }
  | { readonly kind: "EXISTING"; readonly receipt: unknown }
  | { readonly kind: "RETRYABLE_FAILURE" };

/** The complete own-property set of each arm. Exhaustive, not a minimum. */
export const PUBLISHED_COMMIT_KEYS: readonly string[] = ["kind"];
export const EXISTING_COMMIT_KEYS: readonly string[] = ["kind", "receipt"];
export const RETRYABLE_FAILURE_COMMIT_KEYS: readonly string[] = ["kind"];

/**
 * Whether a sink returned a commit outcome this core can act on.
 *
 * Exact own keys throughout. `PUBLISHED` with an extra `url`, `EXISTING`
 * without a receipt, `RETRYABLE_FAILURE` with a `message` — each is malformed
 * rather than tolerated, because the extra field is precisely the one this
 * contract exists to keep out. Only the top level is checked; an `EXISTING`
 * receipt's *contents* travel onward to Phase 2H-1 exactly as received.
 */
export function isWellFormedStagingCommitOutcome(
  value: unknown,
): value is ManagedOutputStagingCommitOutcome {
  return parseStagingCommitOutcome(value) !== null;
}

/**
 * Read a commit result once, under a guard, into a fresh plain object — or
 * `null`.
 *
 * Total over hostile objects, which is the whole reason this exists alongside
 * the predicate. The value is whatever a sink adapter returned, and reading
 * `kind` or `receipt` may invoke a getter. A getter that throws is not a commit
 * outcome — it is a value outside the contract, and the answer is `null`, never
 * the getter's own error escaping into a place where it would replace the fixed
 * defect the core is about to raise.
 *
 * Materialized rather than merely validated, for the second half of the same
 * problem: a predicate that returns `true` leaves the caller to read the
 * properties *again*, and a getter that answered once and throws the second
 * time would pass validation and then explode in the dispatch. Every read
 * happens here, exactly once, inside the guard, and what the caller gets is a
 * plain object with own data properties that cannot surprise it. The
 * `receipt` reference itself is carried through untouched — its contents are
 * Phase 2H-1's question, and it travels there exactly as received.
 */
export function parseStagingCommitOutcome(
  value: unknown,
): ManagedOutputStagingCommitOutcome | null {
  if (!isPlainRecord(value)) return null;
  try {
    const kind: unknown = value.kind;
    switch (kind) {
      case "PUBLISHED":
        return hasExactlyOwnKeys(value, PUBLISHED_COMMIT_KEYS) ? { kind: "PUBLISHED" } : null;
      case "EXISTING":
        // `receipt` must be *present*; its contents are Phase 2H-1's question.
        return hasExactlyOwnKeys(value, EXISTING_COMMIT_KEYS)
          ? { kind: "EXISTING", receipt: value.receipt }
          : null;
      case "RETRYABLE_FAILURE":
        return hasExactlyOwnKeys(value, RETRYABLE_FAILURE_COMMIT_KEYS)
          ? { kind: "RETRYABLE_FAILURE" }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
