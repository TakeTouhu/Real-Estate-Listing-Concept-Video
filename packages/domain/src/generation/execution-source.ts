import type { MediaAssetStatus } from "../property/types";
import type { PreflightRefusalReason } from "./execution-preflight-errors";

/**
 * The exact bytes an admitted generation is allowed to submit, named by what
 * the durable row says about them.
 *
 * Three fields and no fourth. This is **not** a credential and **not** an
 * admission identity: it carries no signed URL, no expiry, no `assetId`, no
 * `organizationId`, no `requestHash` and no prompt. A signed URL is a secret
 * with a lifetime; this is a description of a source, safe to hold beside one
 * but never to be confused with it.
 *
 * `assetId` is deliberately absent even though it would be convenient. The
 * frozen asset id lives on the `SceneGeneration` row, so any future validator
 * can read it authoritatively rather than accept it from whoever is asking —
 * and a caller-supplied asset id would be a way to point a check at a different
 * asset than the one admitted.
 *
 * **Why `storageKey` and `mimeType` are not enough.** `buildAssetStorageKey` is
 * deterministic in (organization, property, asset, variant, extension), so every
 * normalized JPEG ever produced for one asset lands on the *same* key with the
 * same MIME type. Two genuinely different images therefore agree on both fields.
 * {@link PreparedSourceIdentity.sha256} is the field that can tell them apart.
 */
export interface PreparedSourceIdentity {
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sha256: string;
}

/**
 * The only source format execution accepts.
 *
 * The media pipeline normalizes every accepted upload to JPEG, so a `READY`
 * asset that is not one is not the normalized master — it is something else,
 * and submitting it would send the provider an image the customer never had
 * normalized. Thumbnails are excluded for the same reason plus a worse one:
 * `thumbnailKey` is a downscaled derivative, and paying to animate it would be
 * a silent quality substitution.
 */
export const NORMALIZED_SOURCE_MIME_TYPE = "image/jpeg";

/**
 * The one shape a normalized content digest may take here.
 *
 * `AssetService.completeUpload` produces it with `sha256Hex`, which is
 * `createHash("sha256").update(input).digest("hex")` — an unprefixed lowercase
 * hexadecimal digest, so exactly 64 characters from `[0-9a-f]`. That producer is
 * canonical and singular, which is what makes pinning the format reasonable
 * rather than fussy: a value in any other shape was not written by this
 * pipeline, and comparing two such values would produce an equality that means
 * nothing.
 *
 * Deliberately **not** `sha256:<hex>`. `requestHash` and the storyboard
 * fingerprint both carry that prefix; this column does not, and inventing one
 * here would reject every row production has ever written.
 */
const CANONICAL_SOURCE_DIGEST = /^[0-9a-f]{64}$/;

/**
 * Whether a durable digest can serve as execution source identity.
 *
 * Rejects null, empty, whitespace, 63 and 65 characters, uppercase `A-F`, a
 * `sha256:` prefix, and anything non-hex.
 *
 * **What this buys, stated precisely.** SHA-256 is a collision-resistant digest,
 * not an injective function — no hash over arbitrary-length input can be. Two
 * different images agreeing on this value is not *impossible*, it is
 * computationally infeasible to arrange, which is the property being relied on.
 * The digest is therefore practical evidence of content identity: strong enough
 * to detect that a source changed, and never a proof that bytes cannot change.
 * What actually keeps the bytes still is the lifecycle and storage-writer
 * inventory recorded in ADR-0029, not this regular expression.
 */
export function isUsableSourceDigest(sha256: string | null): sha256 is string {
  return sha256 !== null && CANONICAL_SOURCE_DIGEST.test(sha256);
}

/** What a source asset's current status means for executing a generation. */
export type AssetExecutability = "READY" | "IN_PROGRESS" | "UPLOAD_FAILED" | "UNRECOVERABLE";

/**
 * The single classification of every source-asset status, and the one place a
 * new status has to be thought about.
 *
 * A `Record<MediaAssetStatus, …>` does not compile with a member missing, so
 * adding a status to the union forces a decision here rather than letting it
 * fall into whichever branch happens to catch it. This is the *only* exhaustive
 * map of these states; nothing restates it, including the tests, and Phase
 * 4C-3A-2b's locked-row validation will reach it through
 * {@link classifyExecutionSource} rather than copying it into a persistence
 * adapter.
 *
 * The criterion is narrow and deliberately not about how the failure feels:
 *
 * > Can this **same** `MediaAsset` identity become an executable `READY`
 * > normalized source later, without changing the admitted generation's
 * > `assetId`?
 *
 * It says nothing about whether that happens on its own. `PENDING_UPLOAD` may
 * be waiting on a customer's client to finish uploading, and `FAILED` needs a
 * customer to call `AssetService.retryUpload` — both can still reach `READY`
 * under the same id, which is what makes them recoverable. `QUARANTINED` and
 * `REJECTED` cannot: `retryUpload` refuses them, and no other route exists.
 */
const ASSET_EXECUTABILITY: Record<MediaAssetStatus, AssetExecutability> = {
  READY: "READY",
  PENDING_UPLOAD: "IN_PROGRESS",
  UPLOADED: "IN_PROGRESS",
  SCANNING: "IN_PROGRESS",
  PROCESSING: "IN_PROGRESS",
  FAILED: "UPLOAD_FAILED",
  QUARANTINED: "UNRECOVERABLE",
  REJECTED: "UNRECOVERABLE",
  DELETION_PENDING: "UNRECOVERABLE",
  DELETED: "UNRECOVERABLE",
};

/**
 * Whether an unvalidated value is one of the ten `MediaAssetStatus` members.
 *
 * Exists because Phase 4C-3A-2b reads the asset row with `$queryRaw`, which
 * bypasses Prisma's model mapping: the `status` column arrives as a **plain
 * string**, not the generated enum, so the type parameter on a raw query is an
 * assertion rather than a check. `raw.status as MediaAssetStatus` would launder
 * an arbitrary database value straight into {@link classifyExecutionSource} and
 * out through `ASSET_EXECUTABILITY[…]` as `undefined`, which no branch handles.
 *
 * **Deliberately not a second list.** The membership test reads the keys of
 * `ASSET_EXECUTABILITY`, which is already `Record<MediaAssetStatus, …>` and
 * therefore already fails to compile when a status is added. A parallel array
 * would be a second vocabulary that could silently disagree with it — exactly
 * what the exhaustive map exists to prevent.
 *
 * `hasOwnProperty` via `Object.prototype`, not `in` and not a direct method
 * call: `"toString" in ASSET_EXECUTABILITY` is `true` through the prototype
 * chain, and an object literal's own `hasOwnProperty` could itself be shadowed.
 */
export function isMediaAssetStatus(value: unknown): value is MediaAssetStatus {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(ASSET_EXECUTABILITY, value)
  );
}

/**
 * Exactly what classifying a source needs, and nothing that would tie it to one
 * way of reading the row.
 *
 * Deliberately **not** a `MediaAsset`. Phase 4C-3A-2b validates a row locked
 * with `SELECT … FOR NO KEY UPDATE`, which returns the columns it asked for
 * rather than a mapped entity; requiring a whole `MediaAsset` there would force
 * either a second read or a half-populated object built to satisfy a type. Five
 * fields is also the honest surface: nothing else takes part in the decision.
 */
export interface ExecutionSourceObservation {
  readonly status: MediaAssetStatus;
  readonly deletionRequestedAt: Date | null;
  readonly storageKey: string;
  readonly mimeType: string | null;
  readonly sha256: string | null;
}

/**
 * The refusals a **single observation** can produce.
 *
 * A narrowed subset of {@link PreflightRefusalReason}, not the whole union, and
 * the narrowing does real work: it is what lets a caller write a total
 * message table for exactly these and get a compile error if this set ever
 * grows. `ASSET_NOT_FOUND` is absent because a classifier handed an observation
 * has one by definition, and `ASSET_SOURCE_CHANGED` is absent because it is a
 * statement about *two* observations, which no single one can make.
 */
export type ExecutionSourceRefusalReason = Extract<
  PreflightRefusalReason,
  | "ASSET_NOT_READY"
  | "ASSET_UPLOAD_FAILED"
  | "ASSET_UNRECOVERABLE"
  | "ASSET_FORMAT_UNSUPPORTED"
  | "ASSET_SOURCE_UNIDENTIFIABLE"
>;

/**
 * Either the identity of an executable source, or the reason it is not one.
 *
 * A discriminated union rather than `PreparedSourceIdentity | null`: the reason
 * is the whole product of a refusal, and `null` would force every caller to
 * re-derive it from the observation it just handed in — which is how two
 * callers start disagreeing about what a row means.
 */
export type ExecutionSourceClassification =
  | { readonly kind: "USABLE"; readonly identity: PreparedSourceIdentity }
  | { readonly kind: "REFUSED"; readonly reason: ExecutionSourceRefusalReason };

/**
 * The one canonical answer to "may this row be submitted, and as what?"
 *
 * Pure: no repository, no storage, no clock, no throwing. Preflight calls it for
 * both of its observations, and Phase 4C-3A-2b will call it for the locked row
 * inside the claim transaction — one decision procedure, so a claim can never
 * accept a source preflight would have refused.
 *
 * Order is load-bearing:
 *
 * 1. **deletion intent first**, because it outranks status. Retention can be
 *    requested while the row still reads `READY`, and submitting a photo whose
 *    deletion a customer has already asked for would be worse than refusing.
 *    Checking it first also means a deleted asset is reported as unrecoverable
 *    rather than as "changed" or "wrong format".
 * 2. **status**, through the exhaustive map above.
 * 3. **format** — a normalized JPEG at a non-blank key.
 * 4. **digest usability** — see {@link isUsableSourceDigest}.
 *
 * The returned `storageKey` is the durable string exactly as stored, not a
 * trimmed copy: the key that gets signed must be the key the identity names, and
 * a normalized-in-passing value would quietly make those two different things.
 */
export function classifyExecutionSource(
  observation: ExecutionSourceObservation,
): ExecutionSourceClassification {
  if (observation.deletionRequestedAt !== null) return refused("ASSET_UNRECOVERABLE");

  switch (ASSET_EXECUTABILITY[observation.status]) {
    case "IN_PROGRESS":
      return refused("ASSET_NOT_READY");
    case "UPLOAD_FAILED":
      return refused("ASSET_UPLOAD_FAILED");
    case "UNRECOVERABLE":
      return refused("ASSET_UNRECOVERABLE");
    case "READY":
      break;
  }

  // Ready is not the same as usable. The normalized master is a JPEG at a
  // non-blank key; anything else is either not the normalized source or not
  // addressable, and both would be discovered by the provider after the money
  // was spent.
  const { storageKey, mimeType, sha256 } = observation;
  if (mimeType !== NORMALIZED_SOURCE_MIME_TYPE || storageKey.trim().length === 0) {
    return refused("ASSET_FORMAT_UNSUPPORTED");
  }

  // A separate refusal from the one above, because it is a different situation.
  // A non-JPEG is a source we will not submit; a `READY` row with no canonical
  // digest is a row this pipeline should never have written — its own integrity
  // is in question, and calling that a format problem would send whoever reads
  // the durable code looking at MIME types.
  if (!isUsableSourceDigest(sha256)) return refused("ASSET_SOURCE_UNIDENTIFIABLE");

  return { kind: "USABLE", identity: { storageKey, mimeType, sha256 } };
}

/**
 * Whether two observations describe the same source.
 *
 * All three fields, because any one of them alone can agree across genuinely
 * different bytes — `storageKey` and `mimeType` always do, for the deterministic
 * reason given on {@link PreparedSourceIdentity}.
 */
export function sameSourceIdentity(a: PreparedSourceIdentity, b: PreparedSourceIdentity): boolean {
  return a.storageKey === b.storageKey && a.mimeType === b.mimeType && a.sha256 === b.sha256;
}

function refused(reason: ExecutionSourceRefusalReason): ExecutionSourceClassification {
  return { kind: "REFUSED", reason };
}
