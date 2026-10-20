import { AppError } from "@app/shared";

/**
 * Where the Clean Master lives, and the rule that keeps it there (ADR-0074,
 * implementing ADR-0052 Decision 17 and ADR-0071 Decision 7).
 *
 * The Clean Master is the overlay-free master of one deliverable: no burned-in
 * disclosure, no burned-in logo. The customer's video is made from it, and a
 * later disclosure or logo change is recomposed from it once the scene videos
 * are gone. It is internal: never downloadable, never shown to a customer, and
 * not counted in the customer's storage quota.
 *
 * Its objects live under one **internal namespace**, the third segment of an
 * organization's key:
 *
 * ```text
 * org/{organizationId}/internal/clean-masters/{deliverableVersionId}
 * ```
 *
 * and no signed URL, of either purpose, is ever made or honoured for a key in
 * it. The refusal is positional, so it does not depend on a list of the
 * namespaces customers may reach: whatever is ever stored under `internal/` is
 * refused by the same check.
 */

/** The third segment of every internal-only key. */
export const INTERNAL_STORAGE_SEGMENT = "internal";

/**
 * `true` when the key names an internal-only object, which no signed URL may
 * reach: `org/{organizationId}/internal/…`.
 *
 * Exact and case-sensitive, as object keys are: `org/o/Internal/x` is a
 * different object from `org/o/internal/x`, and nothing writes it.
 */
export function isInternalStorageKey(key: string): boolean {
  const parts = key.split("/");
  return parts[0] === "org" && parts[2] === INTERNAL_STORAGE_SEGMENT;
}

/**
 * Throws when the key is internal-only. Every signer calls this before it signs
 * anything, so an internal object can never be given a URL, whichever code path
 * asked for one.
 *
 * Reaching it is a defect in the caller, never a customer's doing: no route
 * accepts a key from a customer. So it is an internal error, and its message
 * names no key.
 */
export function assertSignableStorageKey(key: string): void {
  if (isInternalStorageKey(key)) {
    throw new AppError("INTERNAL_ERROR", "An internal-only storage object is never given a signed URL");
  }
}

declare const managedCleanMasterKeyBrand: unique symbol;

/**
 * A Clean Master's key, produced only by {@link managedCleanMasterKey}.
 *
 * A third brand, distinct from `ManagedGenerationOutputKey` and
 * `ManagedDeliverableOutputKey`: a master and the customer's video made from it
 * are different objects with different exposure, and one type covering both
 * would let the composer write the customer's video over the master, or a
 * download path sign the master, with the compiler's blessing.
 */
export type ManagedCleanMasterKey = string & {
  readonly [managedCleanMasterKeyBrand]: "ManagedCleanMasterKey";
};

/**
 * The one place a string becomes a Clean Master key.
 *
 * ```text
 * org/{organizationId}/internal/clean-masters/{deliverableVersionId}
 * ```
 *
 * Two application-generated identifiers and nothing else, as for every other
 * managed key. Each must be non-blank and free of `/`: the internal refusal
 * reads the key's segments by position, so an identifier carrying a `/` would
 * move the namespace out of the place the refusal looks. The deliverable version
 * id is immutable, so the key is too.
 *
 * Extensionless, like the deliverable's own key: the receipt proves a digest and
 * a byte count, not a container.
 */
export function managedCleanMasterKey(input: {
  readonly organizationId: string;
  readonly deliverableVersionId: string;
}): ManagedCleanMasterKey {
  for (const id of [input.organizationId, input.deliverableVersionId]) {
    if (id.trim().length === 0 || id.includes("/")) {
      throw new AppError(
        "VALIDATION_FAILED",
        "A Clean Master key requires a non-blank organization and deliverable version id without '/'",
      );
    }
  }
  return [
    "org",
    input.organizationId,
    INTERNAL_STORAGE_SEGMENT,
    "clean-masters",
    input.deliverableVersionId,
  ].join("/") as ManagedCleanMasterKey;
}
