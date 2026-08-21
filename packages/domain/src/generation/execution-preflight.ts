import { AppError } from "@app/shared";
import type { MediaAssetRepository, ObjectStorage } from "../property/ports";
import type { MediaAssetStatus } from "../property/types";
import type { VideoModelCapabilityProvider } from "./capability";
import { frozenExecutionPromptFrom } from "./execution-input";
import type { SystemGenerationCandidate } from "./execution-ports";
import { PreflightRefusalError } from "./execution-preflight-errors";
import { computeGenerationRequestHash, generationRequestFactsFrom } from "./request-identity";

/**
 * Everything an admitted generation needs in order to be submitted — and
 * nothing durable.
 *
 * **Deliberately not `ProviderGenerationInput`.** That type lives in
 * `@app/video-providers`, which depends on `@app/domain`; importing it here
 * would invert the dependency and create a cycle. The overlap is not
 * duplication of logic, only of shape: the adapter boundary is where a
 * provider-shaped request is built, and this is the domain's description of
 * what such a request must be made of.
 *
 * **Every field is either frozen or freshly derived, never current.** The
 * prompt and the four request settings come from the immutable snapshot
 * (ADR-0018, ADR-0023), so recomposition or a project settings change after
 * admission cannot alter what gets submitted. The source URL is the opposite:
 * derived at preparation time and never persisted, because a stored credential
 * outlives the reason it was issued (ADR-0018 §6).
 */
export interface PreparedGeneration {
  readonly generationId: string;
  /** Resolved by the execution port through `VideoProject`, never supplied. */
  readonly organizationId: string;

  readonly providerName: string;
  readonly providerModelId: string;

  /**
   * Short-lived signed URL for the normalized source image.
   *
   * A credential. Never persisted, never logged, never placed in an error
   * message or an audit entry.
   */
  readonly sourceImageUrl: string;
  /**
   * When {@link sourceImageUrl} stops working.
   *
   * Returned rather than kept private because the gap between preparing and
   * submitting is the caller's to manage: a submitter that finds this in the
   * past should refuse rather than spend money on a request whose image the
   * provider cannot fetch.
   */
  readonly sourceUrlExpiresAt: Date;

  readonly prompt: string;
  readonly durationSeconds: number;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly requestHash: string;
}

/**
 * Exactly the capabilities preparation needs, and not one more.
 *
 * Each dependency is narrowed with `Pick` rather than taken whole. Preflight
 * had no business calling `assets.update` or `storage.deleteObject`, but
 * holding the full interfaces meant only a comment said so — and a comment is
 * not what stops the next person, or the next milestone, from reaching for
 * them. Narrowing moves "preparation changes nothing" from a claim into
 * something the compiler enforces: the methods that could mutate an asset or
 * an object are not on these types at all.
 *
 * This complements the absent generation repository. Between them, nothing in
 * scope can move the row, touch the asset, or write to storage.
 */
export interface ExecutionPreflightDeps {
  /**
   * A single tenant-addressed read.
   *
   * Not a system-scoped port, and that is the point: Phase 4C-1b already
   * resolved `organizationId` through the owning `VideoProject`, so preflight
   * can address the ordinary repository with it. Ownership is then *proven* by
   * the scoped read rather than asserted — an asset belonging to another tenant
   * comes back `null`, with no cross-tenant row ever loaded. A second trusted
   * boundary here would repeat exactly what ADR-0025 §1 rejected.
   */
  readonly assets: Pick<MediaAssetRepository, "findById">;
  /**
   * Ask whether the object is there, and mint a short-lived read URL.
   *
   * No `putObject`, no `deleteObject`, and no `createSignedUploadUrl` — an
   * upload URL is a write credential, and preparation has no reason to hold
   * one. `getObject` is absent too: preflight proves the object exists and
   * lets the provider fetch it, rather than pulling image bytes through this
   * process.
   */
  readonly storage: Pick<ObjectStorage, "exists" | "createSignedDownloadUrl">;
  readonly capabilities: VideoModelCapabilityProvider;
}

/**
 * How long a prepared source URL stays valid.
 *
 * Deliberately its own constant rather than `DOWNLOAD_URL_TTL_SECONDS`, which
 * is sized for a human clicking a link. This one has to cover preparation, the
 * claim, the submission POST, and the provider's own fetch of the image — a
 * machine-to-machine window that is shorter in the happy case and much less
 * forgiving when it is not.
 */
export const PREFLIGHT_SOURCE_URL_TTL_SECONDS = 600;

/** What a source asset's current status means for executing this generation. */
type AssetExecutability = "READY" | "IN_PROGRESS" | "UPLOAD_FAILED" | "UNRECOVERABLE";

/**
 * The single classification of every source-asset status, and the one place a
 * new status has to be thought about.
 *
 * A `Record<MediaAssetStatus, …>` does not compile with a member missing, so
 * adding a status to the union forces a decision here rather than letting it
 * fall into whichever branch happens to catch it. This is the *only* exhaustive
 * map of these states; nothing restates it.
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
 * Prepare one `QUEUED` generation for a later submission, and change nothing.
 *
 * The row is still `QUEUED` when this returns. There is no claim here, no state
 * write, and no repository on {@link ExecutionPreflightDeps} that could perform
 * one — preparation is separated from claiming so the `SUBMITTING` window
 * covers the provider call alone rather than asset lookup, storage checks and
 * URL signing as well (ADR-0025 §3). `SUBMITTING` is the state whose only
 * honest recovery parks work for a human, so it is worth keeping small.
 *
 * Two workers may prepare the same row concurrently. That is safe and expected:
 * only one wins the later compare-and-swap, and the loser has spent a signed
 * URL and some assembly, neither of which is billable.
 *
 * Every failure is a {@link PreflightRefusalError} carrying a machine-readable
 * reason. None of them can mean the provider was charged, because preflight
 * never reaches a provider.
 *
 * @throws PreflightRefusalError when the generation cannot be prepared.
 * @throws AppError INTERNAL_ERROR when handed a generation that is not `QUEUED`.
 */
export async function prepareQueuedGeneration(
  deps: ExecutionPreflightDeps,
  candidate: SystemGenerationCandidate,
): Promise<PreparedGeneration> {
  const { organizationId, generation } = candidate;

  // A caller bug rather than a refusal: preparation is defined on queued work,
  // and a row in any other state has an owner who is not this caller. It gets
  // no refusal reason because there is no durable disposition that would make
  // sense — Phase 4C-2B maps refusals out of `QUEUED`, and this row has already
  // left it.
  if (generation.state !== "QUEUED") {
    throw new AppError("INTERNAL_ERROR", "Only a QUEUED generation can be prepared for submission");
  }

  // The immutable request, reconstructed from the row's own snapshot. Both
  // helpers already fail closed for rows admitted before their contract
  // existed; preflight only has to classify that refusal rather than re-decide
  // it. Reconstructing either from the current storyboard or the project's
  // present settings would forge a request the customer never approved.
  const facts = refuseOnThrow("LEGACY_SNAPSHOT_MISSING", () =>
    generationRequestFactsFrom(generation),
  );
  const prompt = refuseOnThrow("LEGACY_PROMPT_MISSING", () =>
    frozenExecutionPromptFrom(generation),
  );

  // The stored hash is checked against the facts stored beside it rather than
  // trusted. They are written together at admission and nothing may edit them
  // afterwards, so disagreement means the row was altered — and the hash is the
  // idempotency identity that stops a provider being paid twice for the same
  // request. A mismatch is the one signal that identity has already been lost.
  if (computeGenerationRequestHash(facts) !== generation.requestHash) {
    throw new PreflightRefusalError(
      "REQUEST_HASH_MISMATCH",
      "The stored request identity does not match the request facts recorded with it",
    );
  }

  // The admitted request names a provider and model. If the deployment has been
  // repointed since, this attempt was approved against a contract that is no
  // longer in force — a different model has a different price and a different
  // result, which is why both are inside the request hash.
  const capability = deps.capabilities.current();
  if (
    capability.providerName !== generation.providerName ||
    capability.providerModelId !== generation.providerModelId
  ) {
    throw new PreflightRefusalError(
      "PROVIDER_CONTRACT_CHANGED",
      "This attempt was admitted for a provider or model the deployment no longer serves",
    );
  }

  // Tenant-scoped by construction. `assetId` carries no foreign key, so this is
  // also the check that the asset still exists at all.
  const asset = await deps.assets.findById(organizationId, generation.assetId);
  if (asset === null) {
    throw new PreflightRefusalError(
      "ASSET_NOT_FOUND",
      "The source asset for this generation no longer exists in its organization",
    );
  }

  // `deletionRequestedAt` overrides the status rather than being checked beside
  // it: retention can be requested while the row still reads `READY`, and
  // submitting a photo whose deletion a customer has already asked for would be
  // worse than refusing. Deliberately unconditional.
  const executability: AssetExecutability =
    asset.deletionRequestedAt === null ? ASSET_EXECUTABILITY[asset.status] : "UNRECOVERABLE";

  // The three non-ready cases stay separate because a later policy has to treat
  // them differently. An in-progress asset may complete on its own or may be
  // waiting on the customer's client; a failed upload moves only when someone
  // calls `retryUpload`; an unrecoverable one never moves at all under this
  // identity. Collapsing the first two would let a future "try again after a
  // delay" policy spin forever on work that is waiting for a person, and would
  // tell an operator the wrong thing about why the row is parked.
  switch (executability) {
    case "READY":
      break;
    case "IN_PROGRESS":
      throw new PreflightRefusalError(
        "ASSET_NOT_READY",
        "The source asset for this generation is still being prepared",
      );
    case "UPLOAD_FAILED":
      throw new PreflightRefusalError(
        "ASSET_UPLOAD_FAILED",
        "The source asset for this generation failed to upload and has not been retried",
      );
    case "UNRECOVERABLE":
      throw new PreflightRefusalError(
        "ASSET_UNRECOVERABLE",
        "The source asset for this generation cannot become usable under its current identity",
      );
  }

  // Existence is asked of storage rather than inferred from the row. A `READY`
  // asset whose object is gone is exactly the case that would otherwise be
  // discovered by the provider, after the money was spent.
  const objectExists = await storageCall(() => deps.storage.exists(asset.storageKey));
  if (!objectExists) {
    throw new PreflightRefusalError(
      "SOURCE_OBJECT_MISSING",
      "The source asset record points at an object that is not in storage",
    );
  }

  const signed = await storageCall(() =>
    deps.storage.createSignedDownloadUrl(asset.storageKey, PREFLIGHT_SOURCE_URL_TTL_SECONDS),
  );

  // Built from the snapshot, field by field. Nothing here reads the asset's
  // current dimensions, the project's current settings, or the storyboard —
  // all three are mutable after admission, and any of them could change what is
  // submitted under a `requestHash` that still validated (ADR-0018 §3).
  return {
    generationId: generation.id,
    organizationId,
    providerName: generation.providerName,
    providerModelId: generation.providerModelId,
    sourceImageUrl: signed.url,
    sourceUrlExpiresAt: signed.expiresAt,
    prompt,
    durationSeconds: facts.durationSeconds,
    aspectRatio: facts.aspectRatio,
    resolution: facts.resolution,
    requestHash: generation.requestHash,
  };
}

/**
 * Run a reconstruction helper, converting its refusal into a classified one.
 *
 * The original error becomes `cause` rather than being re-messaged, so the
 * reason a row is unexecutable survives into logs without preflight restating
 * a message it does not own.
 */
function refuseOnThrow<T>(
  reason: "LEGACY_SNAPSHOT_MISSING" | "LEGACY_PROMPT_MISSING",
  read: () => T,
): T {
  try {
    return read();
  } catch (error) {
    throw new PreflightRefusalError(
      reason,
      reason === "LEGACY_PROMPT_MISSING"
        ? "This generation predates the execution prompt freeze and cannot be submitted"
        : "This generation predates the request snapshot and cannot be reconstructed",
      { cause: error },
    );
  }
}

/**
 * Wrap an object-storage call so a transport failure is classified rather than
 * escaping as an unrecognized error.
 *
 * Storage being unreachable says nothing about the asset, which is why it is a
 * separate reason from a missing object: the world may change, so a later
 * explicit retry policy could legitimately re-queue this attempt, where a
 * genuinely absent object never becomes present.
 */
async function storageCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new PreflightRefusalError(
      "STORAGE_UNAVAILABLE",
      "Object storage could not be reached while preparing this generation",
      { cause: error },
    );
  }
}
