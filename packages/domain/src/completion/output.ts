/**
 * What the platform must be able to say about a managed output before calling
 * it verified — and what a caller is allowed to say about it.
 *
 * Two rules govern everything here.
 *
 * **The storage key is derived, never supplied.** A caller that could name the
 * key could point a verification record at another tenant's object, or at a
 * provider URL, or at a path that will not exist on retry. The key is a pure
 * function of application-owned identifiers, so the same attempt always produces
 * the same key and a repeated ingestion overwrites its own object rather than
 * scattering copies.
 *
 * **The integrity facts are validated values, not strings and numbers.** A
 * digest is 64 lowercase hex characters or it is not a digest; a size is a
 * positive safe integer or it is not a size. Both are constructed through a
 * boundary that refuses everything else, so a malformed value cannot reach the
 * column that a later audit will treat as proof.
 */

import { AppError } from "@app/shared";

declare const sha256DigestBrand: unique symbol;
declare const byteCountBrand: unique symbol;

/**
 * A SHA-256 digest of a managed output, in the repository's canonical form.
 *
 * Branded so it cannot be confused with any other string — a request hash, a
 * perceptual hash, or a provider identifier are all hex-shaped and none of them
 * is this.
 *
 * The canonical form is lowercase, matching `isUsableSourceDigest` in the
 * execution-source contract. Uppercase is refused rather than folded: two
 * spellings of one digest is how an equality comparison starts returning false
 * for identical bytes, and this value is compared on the replay path where a
 * false mismatch would be reported to an operator as a corrupted output.
 */
export type Sha256Digest = string & { readonly [sha256DigestBrand]: "Sha256Digest" };

/** A byte count that is positive, integral and inside the safe-integer range. */
export type SafePositiveByteCount = number & {
  readonly [byteCountBrand]: "SafePositiveByteCount";
};

const CANONICAL_SHA256 = /^[0-9a-f]{64}$/;

/** Whether a value is a canonical SHA-256 digest. Accepts `unknown`. */
export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && CANONICAL_SHA256.test(value);
}

/**
 * Whether a value is a usable managed-output byte count.
 *
 * `Number.isSafeInteger` rejects `NaN`, both infinities, fractions and integers
 * past 2^53-1 in one predicate. Zero is refused separately and on purpose: a
 * zero-byte object is not a small video, it is a failed copy that happened to
 * create the destination, and calling it verified would close an attempt over
 * nothing.
 */
export function isSafePositiveByteCount(value: unknown): value is SafePositiveByteCount {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Construct a digest, or refuse.
 *
 * Deliberately does not trim, lowercase, or strip a `sha256:` prefix. Silently
 * normalizing external text is how a value nobody validated ends up in a column
 * an auditor treats as proof; a caller holding `"SHA256:ABC…"` has a bug worth
 * seeing rather than a formatting inconvenience worth hiding.
 */
export function sha256Digest(value: unknown): Sha256Digest {
  if (!isSha256Digest(value)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Managed output digest must be exactly 64 lowercase hexadecimal characters",
    );
  }
  return value;
}

/** Construct a byte count, or refuse. */
export function safePositiveByteCount(value: unknown): SafePositiveByteCount {
  if (!isSafePositiveByteCount(value)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Managed output size must be a positive safe integer number of bytes",
    );
  }
  return value;
}

/**
 * What a future storage layer must be able to prove about the object it wrote.
 *
 * Two facts, both about the bytes, and nothing about where they came from.
 * There is deliberately no storage key here — the service derives that — no
 * provider URL, no raw bytes, and no MIME string: this repository has no closed
 * media-format vocabulary for generated video yet, and inventing a free-text
 * MIME column would be a new place for unvalidated provider text to live.
 */
export interface ManagedOutputVerificationReceipt {
  readonly sha256: Sha256Digest;
  readonly sizeBytes: SafePositiveByteCount;
}

/** Whether an arbitrary value is a usable receipt. Accepts `unknown`. */
export function isWellFormedVerificationReceipt(
  value: unknown,
): value is ManagedOutputVerificationReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isSha256Digest(record.sha256) && isSafePositiveByteCount(record.sizeBytes);
}

/**
 * Where this attempt's managed output lives, derived from identifiers only.
 *
 * Deterministic by construction: the same attempt always yields the same key, so
 * a retried ingestion writes over its own object instead of leaving an orphan
 * behind, and a finalization can be replayed without the platform having to
 * remember what it chose last time.
 *
 * The shape follows the existing asset convention — `org/{organizationId}/…` —
 * so `organizationIdFromStorageKey` continues to recover the owning tenant from
 * the key alone, and so a bucket listing groups a tenant's objects together for
 * retention and deletion.
 *
 * Nothing derived from outside enters it: no provider URL, no provider file
 * name, no prompt, no customer file name, no opaque external path. A key built
 * from external text is a path traversal and a cross-tenant write waiting for
 * the first provider that returns something unexpected.
 */
export function managedGenerationOutputKey(input: {
  readonly organizationId: string;
  readonly attemptId: string;
}): string {
  if (input.organizationId.trim().length === 0 || input.attemptId.trim().length === 0) {
    // Blank identifiers would collapse two different attempts onto one key, and
    // a key with an empty segment is a different object than it looks like.
    throw new AppError(
      "VALIDATION_FAILED",
      "Managed output key requires a non-blank organization and attempt id",
    );
  }
  return ["org", input.organizationId, "generations", input.attemptId, "output.mp4"].join("/");
}
