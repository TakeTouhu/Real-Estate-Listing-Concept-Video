import { AppError, sha256Hex } from "@app/shared";
import { recordAudit } from "../identity/audit";
import { authorizeOrganization } from "../identity/authorization";
import type { Clock, IdentityServiceDeps, IdGenerator } from "../identity/ports";
import { PropertyAuditAction } from "./audit";
import {
  buildAssetStorageKey,
  DUPLICATE_HAMMING_THRESHOLD,
  extensionFor,
  hammingDistanceHex,
  sniffMimeType,
} from "./media";
import type {
  ImageProcessor,
  MalwareScanner,
  MediaAssetRepository,
  ObjectStorage,
  PropertyRepository,
  SignedUrl,
} from "./ports";
import { DEFAULT_UPLOAD_LIMITS, type MediaAsset, type UploadLimits } from "./types";

export interface AssetServiceDeps {
  readonly identity: IdentityServiceDeps;
  readonly properties: PropertyRepository;
  readonly assets: MediaAssetRepository;
  readonly storage: ObjectStorage;
  readonly scanner: MalwareScanner;
  readonly images: ImageProcessor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly limits?: UploadLimits;
}

export interface RequestUploadInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly originalFilename: string;
  readonly declaredSizeBytes: number;
}

export interface RequestUploadResult {
  readonly asset: MediaAsset;
  readonly upload: SignedUrl;
}

export interface CompleteUploadResult {
  readonly asset: MediaAsset;
  /** Assets whose perceptual hash is within the near-duplicate threshold. */
  readonly duplicateOf: readonly string[];
}

/** TTLs for single-purpose signed URLs (short-lived by policy). */
export const UPLOAD_URL_TTL_SECONDS = 600;
export const DOWNLOAD_URL_TTL_SECONDS = 300;

/** Statuses that occupy a slot against the per-property file-count limit. */
const ACTIVE_STATUSES = new Set<MediaAsset["status"]>([
  "PENDING_UPLOAD",
  "UPLOADED",
  "SCANNING",
  "PROCESSING",
  "READY",
]);

export class AssetService {
  private readonly limits: UploadLimits;

  constructor(private readonly deps: AssetServiceDeps) {
    this.limits = deps.limits ?? DEFAULT_UPLOAD_LIMITS;
  }

  /**
   * Step 1 — reserve an asset row in PENDING_UPLOAD and issue a short-lived,
   * single-purpose signed upload URL for a tenant-scoped storage key.
   */
  async requestUpload(actorUserId: string, input: RequestUploadInput): Promise<RequestUploadResult> {
    await authorizeOrganization(
      this.deps.identity,
      actorUserId,
      input.organizationId,
      "property:write",
    );
    const property = await this.deps.properties.findById(input.organizationId, input.propertyId);
    if (!property || property.status === "DELETED") {
      throw new AppError("NOT_FOUND", "Property not found");
    }
    if (input.declaredSizeBytes > this.limits.maxFileSizeBytes) {
      throw new AppError(
        "VALIDATION_FAILED",
        `File exceeds the maximum size of ${this.limits.maxFileSizeBytes} bytes`,
      );
    }
    const active = await this.deps.assets.countActiveByProperty(
      input.organizationId,
      input.propertyId,
    );
    if (active >= this.limits.maxAssetsPerProperty) {
      throw new AppError(
        "VALIDATION_FAILED",
        `This property already has the maximum of ${this.limits.maxAssetsPerProperty} photos`,
      );
    }

    const assetId = this.deps.ids.generate("ast");
    const storageKey = buildAssetStorageKey({
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      assetId,
      variant: "original",
      extension: "bin",
    });
    const asset = await this.deps.assets.create({
      id: assetId,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      storageKey,
      originalFilename: sanitizeFilename(input.originalFilename),
      mimeType: null,
      sizeBytes: null,
      width: null,
      height: null,
      sha256: null,
      perceptualHash: null,
      status: "PENDING_UPLOAD",
      failureReason: null,
      thumbnailKey: null,
      createdBy: actorUserId,
      deletionRequestedAt: null,
      retentionExpiresAt: null,
    });
    const upload = await this.deps.storage.createSignedUploadUrl(storageKey, UPLOAD_URL_TTL_SECONDS);
    await recordAudit(this.deps.identity, {
      organizationId: input.organizationId,
      actorUserId,
      action: PropertyAuditAction.AssetUploadRequested,
      resourceType: "media_asset",
      resourceId: assetId,
      metadata: { propertyId: input.propertyId },
    });
    return { asset, upload };
  }

  /**
   * Step 2 — after the client PUTs the bytes, validate and process them:
   * content-based MIME check, dimension limits, malware scan (quarantine on
   * detection), EXIF/orientation normalization, thumbnail, and perceptual hash.
   */
  async completeUpload(
    actorUserId: string,
    organizationId: string,
    assetId: string,
  ): Promise<CompleteUploadResult> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property:write");
    const asset = await this.requireAsset(organizationId, assetId);
    if (asset.status !== "PENDING_UPLOAD" && asset.status !== "FAILED") {
      throw new AppError("VALIDATION_FAILED", `Asset is not awaiting upload (status ${asset.status})`);
    }

    const data = await this.deps.storage.getObject(asset.storageKey);
    if (!data) {
      throw new AppError("VALIDATION_FAILED", "Uploaded object was not found in storage");
    }
    const now = this.deps.clock.now();
    let current: MediaAsset = this.mustOwnLifecycle(
      await this.deps.assets.updateIfCurrent(
        { ...asset, status: "UPLOADED", sizeBytes: data.byteLength, updatedAt: now },
        asset.status,
      ),
    );

    // Size limit re-checked against the actual bytes, not the client's claim.
    if (data.byteLength > this.limits.maxFileSizeBytes) {
      return { asset: await this.reject(actorUserId, current, "File exceeds the maximum size"), duplicateOf: [] };
    }

    // Content-based MIME validation.
    const sniffed = sniffMimeType(data);
    if (!sniffed || !this.limits.allowedMimeTypes.includes(sniffed)) {
      return {
        asset: await this.reject(actorUserId, current, "Unsupported or mismatched file type"),
        duplicateOf: [],
      };
    }

    // Malware scan hook → quarantine on detection.
    current = this.mustOwnLifecycle(
      await this.deps.assets.updateIfCurrent(
        { ...current, status: "SCANNING", mimeType: sniffed, updatedAt: this.deps.clock.now() },
        "UPLOADED",
      ),
    );
    const scan = await this.deps.scanner.scan(data);
    if (scan.verdict === "INFECTED") {
      return { asset: await this.quarantine(actorUserId, current), duplicateOf: [] };
    }
    if (scan.verdict === "SCAN_FAILED") {
      return {
        asset: await this.fail(actorUserId, current, "Malware scan could not be completed"),
        duplicateOf: [],
      };
    }

    // Normalize: strip EXIF/GPS, correct orientation, build thumbnail + pHash.
    current = this.mustOwnLifecycle(
      await this.deps.assets.updateIfCurrent(
        { ...current, status: "PROCESSING", updatedAt: this.deps.clock.now() },
        "SCANNING",
      ),
    );
    let processed;
    try {
      processed = await this.deps.images.process(data);
    } catch {
      return {
        asset: await this.fail(actorUserId, current, "Image could not be processed"),
        duplicateOf: [],
      };
    }

    const smallestSide = Math.min(processed.width, processed.height);
    const largestSide = Math.max(processed.width, processed.height);
    if (smallestSide < this.limits.minImageDimensionPx) {
      return {
        asset: await this.reject(
          actorUserId,
          current,
          `Image is too small (minimum ${this.limits.minImageDimensionPx}px on the shorter side)`,
        ),
        duplicateOf: [],
      };
    }
    if (largestSide > this.limits.maxImageDimensionPx) {
      return {
        asset: await this.reject(actorUserId, current, "Image dimensions are too large"),
        duplicateOf: [],
      };
    }

    // Store processed derivatives under tenant-scoped keys.
    const normalizedKey = buildAssetStorageKey({
      organizationId,
      propertyId: current.propertyId,
      assetId: current.id,
      variant: "normalized",
      extension: extensionFor(processed.normalizedMimeType),
    });
    const thumbnailKey = buildAssetStorageKey({
      organizationId,
      propertyId: current.propertyId,
      assetId: current.id,
      variant: "thumbnail",
      extension: extensionFor(processed.thumbnailMimeType),
    });
    await this.deps.storage.putObject(normalizedKey, processed.normalized);
    await this.deps.storage.putObject(thumbnailKey, processed.thumbnail);

    const sha256 = sha256Hex(Buffer.from(processed.normalized).toString("base64"));
    const duplicateOf = await this.findDuplicates(organizationId, current.id, processed.perceptualHash);

    // The write this milestone exists for. Everything between the `PROCESSING`
    // claim and here — scanning, image processing, two storage writes — runs on
    // a snapshot taken before any of it. Without the predicate, a deletion
    // committed during that stretch would be erased and the asset resurrected
    // as `READY` under a fresh key.
    const readyOrLost = await this.deps.assets.updateIfCurrent(
      {
        ...current,
        storageKey: normalizedKey,
        thumbnailKey,
        mimeType: processed.normalizedMimeType,
        sizeBytes: processed.normalized.byteLength,
        width: processed.width,
        height: processed.height,
        sha256,
        perceptualHash: processed.perceptualHash,
        status: "READY",
        failureReason: null,
        updatedAt: this.deps.clock.now(),
      },
      "PROCESSING",
    );
    if (readyOrLost === null) {
      // The two derivatives are already in storage, and the write that would
      // have named them is the one that just lost. Nothing in the durable row
      // points at them, so a retention worker walking asset rows could never
      // find them — they would be unreferenced *and* unreachable, and they are
      // derivatives of an asset someone has asked to delete.
      await this.discardUnreferencedDerivatives(organizationId, assetId, [
        normalizedKey,
        thumbnailKey,
      ]);
      // Only then the ordinary lost-lifecycle refusal. Compensating first means
      // the caller's error still describes what happened to *them*, while the
      // storage this operation created does not outlive it.
      this.lostLifecycle();
    }
    const ready = readyOrLost;
    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: PropertyAuditAction.AssetUploadCompleted,
      resourceType: "media_asset",
      resourceId: current.id,
      metadata: { mimeType: ready.mimeType, width: ready.width, height: ready.height },
    });
    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: PropertyAuditAction.AssetReady,
      resourceType: "media_asset",
      resourceId: current.id,
      metadata: { duplicateCount: duplicateOf.length },
    });
    return { asset: ready, duplicateOf };
  }

  async list(actorUserId: string, organizationId: string, propertyId: string): Promise<MediaAsset[]> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId);
    return this.deps.assets.listByProperty(organizationId, propertyId);
  }

  /**
   * Issue a short-lived signed download/preview URL. Only READY assets are
   * downloadable; quarantined/rejected content is never served.
   */
  async createDownloadUrl(
    actorUserId: string,
    organizationId: string,
    assetId: string,
    variant: "normalized" | "thumbnail" = "normalized",
  ): Promise<SignedUrl> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId);
    const asset = await this.requireAsset(organizationId, assetId);
    if (asset.status !== "READY") {
      throw new AppError("VALIDATION_FAILED", "Asset is not available for download");
    }
    const key = variant === "thumbnail" ? asset.thumbnailKey : asset.storageKey;
    if (!key) throw new AppError("NOT_FOUND", "Requested asset variant is not available");
    const url = await this.deps.storage.createSignedDownloadUrl(key, DOWNLOAD_URL_TTL_SECONDS);
    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: PropertyAuditAction.AssetDownloaded,
      resourceType: "media_asset",
      resourceId: assetId,
      metadata: { variant },
    });
    return url;
  }

  /**
   * Failed-upload recovery: re-issue a signed upload URL for an asset that is
   * still pending or previously failed, without creating a duplicate row.
   */
  async retryUpload(
    actorUserId: string,
    organizationId: string,
    assetId: string,
  ): Promise<RequestUploadResult> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property:write");
    const asset = await this.requireAsset(organizationId, assetId);
    if (asset.status !== "PENDING_UPLOAD" && asset.status !== "FAILED") {
      throw new AppError("VALIDATION_FAILED", "Only pending or failed uploads can be retried");
    }
    const originalKey = buildAssetStorageKey({
      organizationId,
      propertyId: asset.propertyId,
      assetId: asset.id,
      variant: "original",
      extension: "bin",
    });
    // Guarded before the upload URL is minted: an upload credential for an
    // asset this call no longer owns is worse than a refusal.
    const reset = this.mustOwnLifecycle(
      await this.deps.assets.updateIfCurrent(
        {
          ...asset,
          storageKey: originalKey,
          status: "PENDING_UPLOAD",
          failureReason: null,
          updatedAt: this.deps.clock.now(),
        },
        asset.status,
      ),
    );
    const upload = await this.deps.storage.createSignedUploadUrl(originalKey, UPLOAD_URL_TTL_SECONDS);
    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: PropertyAuditAction.AssetUploadRequested,
      resourceType: "media_asset",
      resourceId: asset.id,
      metadata: { retry: true },
    });
    return { asset: reset, upload };
  }

  /** Request deletion; physical removal happens after the recovery window. */
  async requestDeletion(
    actorUserId: string,
    organizationId: string,
    assetId: string,
  ): Promise<MediaAsset> {
    await authorizeOrganization(this.deps.identity, actorUserId, organizationId, "property:write");
    const asset = await this.requireAsset(organizationId, assetId);
    const now = this.deps.clock.now();
    const updated = await this.deps.assets.requestDeletion(organizationId, asset.id, now);
    if (updated === null) {
      // Losing the CAS is not an error here. Deletion is idempotent by nature:
      // a caller asking for something that has already happened has got what it
      // asked for. One authoritative re-read decides which of the two
      // non-winning worlds this is.
      const current = await this.requireAsset(organizationId, assetId);
      if (current.status === "DELETION_PENDING" || current.deletionRequestedAt !== null) {
        // Converged — and this invocation still audits.
        //
        // An earlier revision suppressed the entry here, reasoning that one
        // decision must not be recorded twice. That was wrong in a way review
        // caught: the rule cannot tell "already audited" from "never audited",
        // so a first call whose CAS committed and whose audit then failed left
        // a durable deletion with no record, and every retry silently refused
        // to write one. The gap became unrepairable.
        //
        // `AssetDeletionRequested` is therefore an audit of a **successful
        // request invocation**, not of the first durable state transition. Two
        // API calls legitimately produce two entries: two people asked. That is
        // not duplication — it is what happened.
        await this.recordDeletionRequested(actorUserId, organizationId, assetId);
        return current;
      }
      // The predicate refused, yet the row is an ordinary non-deleting asset.
      // Nothing the service can explain: reporting it as success would claim a
      // deletion that did not happen, and retrying would loop against a
      // condition that has already disagreed with itself once.
      throw new AppError(
        "INTERNAL_ERROR",
        "Asset deletion request did not converge to a deletion-pending state",
      );
    }
    await this.recordDeletionRequested(actorUserId, organizationId, assetId);
    return updated;
  }

  /**
   * Audit one deletion-request invocation, before it may report success.
   *
   * Both paths that return success go through here, and both `await` it: the
   * guarantee this milestone can honestly make is **"no
   * `requestDeletion` invocation returns success unless its own audit write
   * succeeded"**, and nothing stronger.
   *
   * It is deliberately *not* "every durable deletion has an audit row". The
   * mutation commits before this runs and they share no transaction, so an
   * audit failure leaves deletion intent durable and unrecorded — and the call
   * fails, which is the point. The intent is not rolled back, because it is
   * true: the deletion *was* requested. What a later retry gets is the chance
   * to converge on that intent and write the entry that is missing.
   *
   * No outbox, no audit uniqueness constraint, no idempotency key. Repairability
   * comes from the retry path, not from infrastructure.
   */
  private async recordDeletionRequested(
    actorUserId: string,
    organizationId: string,
    assetId: string,
  ): Promise<void> {
    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: PropertyAuditAction.AssetDeletionRequested,
      resourceType: "media_asset",
      resourceId: assetId,
    });
  }

  /** Count assets occupying a per-property slot (used by the UI and limits). */
  countsTowardLimit(asset: MediaAsset): boolean {
    return ACTIVE_STATUSES.has(asset.status);
  }

  private async findDuplicates(
    organizationId: string,
    selfId: string,
    perceptualHash: string,
  ): Promise<string[]> {
    const candidates = await this.deps.assets.listWithPerceptualHash(organizationId);
    return candidates
      .filter(
        (a) =>
          a.id !== selfId &&
          a.perceptualHash !== null &&
          a.perceptualHash.length === perceptualHash.length &&
          hammingDistanceHex(a.perceptualHash, perceptualHash) <= DUPLICATE_HAMMING_THRESHOLD,
      )
      .map((a) => a.id);
  }

  /**
   * Insist that this operation still owns the asset's lifecycle.
   *
   * `updateIfCurrent` returns `null` when the durable row moved on — deletion
   * won, or another writer changed the status. Every customer-facing path here
   * must **stop** at that point rather than continue: the stages that follow
   * (scanning, image processing, storage writes, minting an upload URL) all act
   * on an asset this call no longer controls, and the worst of them would end
   * by resurrecting a deleted asset as `READY`.
   *
   * `VALIDATION_FAILED` rather than `INTERNAL_ERROR`: nothing is broken. The
   * customer asked for something that stopped being possible while it ran, and
   * a 5xx would blame the system for a legitimate concurrent decision. The
   * message is fixed text naming neither the winning writer nor the row's
   * current state — which of the two happened is not the caller's business, and
   * saying would leak another actor's action.
   */
  private mustOwnLifecycle(updated: MediaAsset | null): MediaAsset {
    if (updated === null) this.lostLifecycle();
    return updated;
  }

  /** The refusal itself, callable where a `MediaAsset` is not the return type. */
  private lostLifecycle(): never {
    throw new AppError(
      "VALIDATION_FAILED",
      "This asset changed or deletion was requested while the operation was in progress",
    );
  }

  /**
   * Remove derivatives this operation wrote, once its final write has lost.
   *
   * Scoped deliberately narrowly: only the post-storage, final-`READY` losing
   * path calls this. Earlier lifecycle losses happen before anything is
   * written, and a successful transition owns what it wrote.
   *
   * **Authority comes from durable deletion intent, not from the reference
   * check.** See the reasoning inline below: a key that is unreferenced *now*
   * can be legitimately claimed later, because the keys are deterministic.
   *
   * **A key the durable row points at is still never deleted.** That check
   * remains as defence in depth — it stops this path removing an object the
   * deletion-pending row itself names — but it grants nothing.
   *
   * Finding the row referenced, or finding no deletion intent, is **not**
   * success for this invocation: it lost ownership either way, and the caller
   * still gets the lost-lifecycle refusal.
   *
   * Both keys are attempted even if the first fails, so one storage error
   * cannot strand the other object.
   */
  private async discardUnreferencedDerivatives(
    organizationId: string,
    assetId: string,
    keys: readonly string[],
  ): Promise<void> {
    const current = await this.deps.assets.findById(organizationId, assetId);

    // **Durable deletion intent is what authorizes deleting anything**, and an
    // earlier revision got this wrong by treating "unreferenced right now" as
    // sufficient. It is not. `buildAssetStorageKey` is deterministic, so the
    // normalized and thumbnail keys for an asset are the same every time it is
    // processed. On a loss that is *not* a deletion, this could happen:
    //
    //   1. this loser re-reads and sees the key unreferenced
    //   2. a later legitimate lifecycle run writes that same deterministic key
    //   3. this loser deletes it
    //
    // A one-time read cannot order a deletion against a *future* owner, and no
    // second read would fix that — the window reopens after every read.
    //
    // `deletionRequestedAt !== null` closes it, and does so using the invariant
    // this milestone establishes rather than a new mechanism: once intent is
    // durable, `updateIfCurrent` refuses **every** ordinary lifecycle mutation
    // for that asset, permanently. No future writer can legitimately take
    // ownership of these keys, so there is no later owner to steal from.
    if (current === null || current.deletionRequestedAt === null) return;

    const referenced = new Set(
      [current.storageKey, current.thumbnailKey].filter((k) => k !== null),
    );

    let failed = false;
    for (const key of keys) {
      if (referenced.has(key)) continue;
      try {
        await this.deps.storage.deleteObject(key);
      } catch {
        // Swallowed only so the remaining key is still attempted; the failure
        // is not swallowed as an outcome — it is reported below. The caught
        // value is dropped rather than wrapped: a storage error can carry a
        // key or a credential, and this one reaches a customer.
        failed = true;
      }
    }

    if (failed) {
      // Not reported as the ordinary lost-lifecycle refusal, because something
      // beyond a lost race went wrong and the residue is real: an unreferenced
      // object that the asset row does not name, so no row-walking cleanup can
      // ever discover it. Recovering it needs storage-side reconciliation.
      throw new AppError(
        "INTERNAL_ERROR",
        "Processed image derivatives could not be cleaned up after the asset changed",
      );
    }
  }

  private async requireAsset(organizationId: string, assetId: string): Promise<MediaAsset> {
    const asset = await this.deps.assets.findById(organizationId, assetId);
    if (!asset || asset.status === "DELETED") {
      throw new AppError("NOT_FOUND", "Asset not found");
    }
    return asset;
  }

  private async reject(actorUserId: string, asset: MediaAsset, reason: string): Promise<MediaAsset> {
    const updated = this.mustOwnLifecycle(
      await this.deps.assets.updateIfCurrent(
        {
          ...asset,
          status: "REJECTED",
          failureReason: reason,
          updatedAt: this.deps.clock.now(),
        },
        asset.status,
      ),
    );
    await recordAudit(this.deps.identity, {
      organizationId: asset.organizationId,
      actorUserId,
      action: PropertyAuditAction.AssetRejected,
      resourceType: "media_asset",
      resourceId: asset.id,
      metadata: { reason },
    });
    return updated;
  }

  private async quarantine(actorUserId: string, asset: MediaAsset): Promise<MediaAsset> {
    const updated = this.mustOwnLifecycle(
      await this.deps.assets.updateIfCurrent(
        {
          ...asset,
          status: "QUARANTINED",
          failureReason: "Malware scan flagged this file",
          updatedAt: this.deps.clock.now(),
        },
        asset.status,
      ),
    );
    await recordAudit(this.deps.identity, {
      organizationId: asset.organizationId,
      actorUserId,
      action: PropertyAuditAction.AssetQuarantined,
      resourceType: "media_asset",
      resourceId: asset.id,
    });
    return updated;
  }

  private async fail(actorUserId: string, asset: MediaAsset, reason: string): Promise<MediaAsset> {
    const updated = this.mustOwnLifecycle(
      await this.deps.assets.updateIfCurrent(
        {
          ...asset,
          status: "FAILED",
          failureReason: reason,
          updatedAt: this.deps.clock.now(),
        },
        asset.status,
      ),
    );
    await recordAudit(this.deps.identity, {
      organizationId: asset.organizationId,
      actorUserId,
      action: PropertyAuditAction.AssetFailed,
      resourceType: "media_asset",
      resourceId: asset.id,
      metadata: { reason },
    });
    return updated;
  }
}

/** Strip path components and control characters from a client filename. */
function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "upload";
  // Control characters are stripped deliberately (header/log injection safety).
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 255) || "upload";
}
