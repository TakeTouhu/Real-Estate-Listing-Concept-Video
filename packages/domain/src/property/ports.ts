import type { AuditLog } from "../identity/types";
import type { Reach } from "./reach";
import type { MediaAsset, MediaAssetStatus, Property } from "./types";

// --- Repositories -----------------------------------------------------------

/** The audit entry a Property change commits together with the change itself. */
export type PropertyChangeAudit = Omit<AuditLog, "id" | "createdAt">;

/** A Property's two assignments (ADR-0052 Decision 10, ADR-0062); null is unset. */
export interface PropertyAssignment {
  readonly responsibleUserId: string | null;
  readonly groupId: string | null;
}

/**
 * How a creation ended. `STALE`: its responsible user is no longer a member of
 * the organization, or its group is gone; nothing was written.
 */
export type PropertyCreation =
  | { readonly outcome: "CREATED"; readonly property: Property }
  | { readonly outcome: "STALE" };

/**
 * How a reassignment ended. `STALE`: the Property is gone or deleted, no longer
 * has the assignments the change was checked against, or the new responsible
 * user or group is gone; nothing was written.
 */
export type PropertyReassignment =
  | { readonly outcome: "ASSIGNED"; readonly property: Property }
  | { readonly outcome: "STALE" };

export interface PropertyRepository {
  /**
   * Record a Property, with its initial assignments, and its audit entry
   * atomically. The foreign keys refuse a responsible user who is not a member
   * of the organization and a group of another organization.
   */
  create(input: Omit<Property, "createdAt" | "updatedAt">, audit: PropertyChangeAudit): Promise<PropertyCreation>;
  /** Find by id WITHIN an organization scope — never across tenants. */
  findById(organizationId: string, id: string): Promise<Property | null>;
  /**
   * The organization's Properties that `reach` reaches, deleted ones excluded.
   * Filtered in the query, never after loading (Phase 6I).
   */
  listReachable(reach: Reach): Promise<Property[]>;
  /** Write a Property's own fields. Never its assignments, which only {@link assign} changes. */
  update(property: Property): Promise<Property>;
  /**
   * Change a Property's assignments from `expected` to `next` and record
   * `audit`, atomically, only while the Property is not deleted and still has
   * `expected`.
   */
  assign(
    organizationId: string,
    propertyId: string,
    expected: PropertyAssignment,
    next: PropertyAssignment,
    audit: PropertyChangeAudit,
  ): Promise<PropertyReassignment>;
}

export interface MediaAssetRepository {
  create(input: Omit<MediaAsset, "createdAt" | "updatedAt">): Promise<MediaAsset>;
  findById(organizationId: string, id: string): Promise<MediaAsset | null>;
  listByProperty(organizationId: string, propertyId: string): Promise<MediaAsset[]>;

  /**
   * Ordinary lifecycle mutation, conditional on the row still being where the
   * caller thinks it is.
   *
   * Replaces an unconditional whole-entity `update`. That method addressed rows
   * by id alone and wrote **every** column from the caller's snapshot,
   * `deletionRequestedAt` included — so any writer holding a pre-deletion copy
   * silently erased a deletion request, and the longest of them
   * (`completeUpload`, which reads once and then scans and reprocesses an image
   * before its final write) could restore a deleted asset to `READY` with a
   * fresh storage key.
   *
   * Two predicates prevent that, and both are enforced by the database rather
   * than by any caller remembering to check:
   *
   * - **`deletionRequestedAt` must still be null.** Deletion intent is
   *   monotonic; once established, ordinary lifecycle work can never clear it.
   * - **The durable status must equal `expectedStatus`.** A caller names the
   *   state it believes it is replacing, so a stale snapshot cannot overwrite a
   *   row another writer already moved.
   *
   * `deletionRequestedAt` is **not** in the written columns at all, so a stale
   * `null` on the passed entity is not merely rejected — it is unwritable.
   *
   * This is **not** the deletion API. It cannot legitimately be used to reach
   * `DELETION_PENDING` or `DELETED`; {@link requestDeletion} owns that.
   *
   * `null` means: the durable row no longer satisfies the predicate this
   * mutation expected — deletion won, another writer moved the status, the
   * organization does not own it, or it does not exist. The caller's next
   * action is the same in every case: stop.
   */
  updateIfCurrent(
    asset: MediaAsset,
    expectedStatus: MediaAssetStatus,
  ): Promise<MediaAsset | null>;

  /**
   * Establish deletion intent, exactly once.
   *
   * The only method that may set `deletionRequestedAt`. Conditional on the
   * intent not already existing and on the row not being `DELETED`, so two
   * concurrent requests produce one winner and one `null` — decided by the
   * database, not by anything a caller observed beforehand.
   *
   * Writes only the two deletion-owned fields. Nothing else on the row is
   * touched, so a deletion request cannot disturb the storage key, hashes, or
   * dimensions that an in-flight lifecycle writer may still be depending on.
   */
  requestDeletion(
    organizationId: string,
    assetId: string,
    requestedAt: Date,
  ): Promise<MediaAsset | null>;

  countActiveByProperty(organizationId: string, propertyId: string): Promise<number>;
  findBySha256(organizationId: string, sha256: string): Promise<MediaAsset[]>;
  /** Assets in the organization that already carry a perceptual hash. */
  listWithPerceptualHash(organizationId: string): Promise<MediaAsset[]>;
}

// --- Object storage ---------------------------------------------------------

export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * Object-storage abstraction. Keys are opaque, organization-prefixed paths.
 * Signed URLs are short-lived and single-purpose (upload XOR download).
 */
export interface ObjectStorage {
  createSignedUploadUrl(key: string, ttlSeconds: number): Promise<SignedUrl>;
  createSignedDownloadUrl(key: string, ttlSeconds: number): Promise<SignedUrl>;
  putObject(key: string, data: Uint8Array): Promise<void>;
  getObject(key: string): Promise<Uint8Array | null>;
  deleteObject(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

// --- Media pipeline ---------------------------------------------------------

export type ScanVerdict = "CLEAN" | "INFECTED" | "SCAN_FAILED";

/** Malware-scanning hook. A verdict of INFECTED quarantines the asset. */
export interface MalwareScanner {
  scan(data: Uint8Array): Promise<{ verdict: ScanVerdict; detail?: string }>;
}

export interface ProcessedImage {
  /** Normalized master image (EXIF/GPS stripped, orientation applied). */
  readonly normalized: Uint8Array;
  readonly normalizedMimeType: string;
  readonly thumbnail: Uint8Array;
  readonly thumbnailMimeType: string;
  readonly width: number;
  readonly height: number;
  /** 64-bit perceptual hash, 16 hex chars. */
  readonly perceptualHash: string;
}

/**
 * Image-processing abstraction: EXIF/sensitive-metadata removal, orientation
 * correction, normalization, thumbnail generation, and perceptual hashing.
 */
export interface ImageProcessor {
  process(data: Uint8Array): Promise<ProcessedImage>;
}

// --- Convenience aggregate --------------------------------------------------

export interface MediaPipeline {
  readonly storage: ObjectStorage;
  readonly scanner: MalwareScanner;
  readonly images: ImageProcessor;
}

export function isTerminalAssetStatus(status: MediaAssetStatus): boolean {
  return (
    status === "READY" ||
    status === "QUARANTINED" ||
    status === "REJECTED" ||
    status === "FAILED" ||
    status === "DELETED"
  );
}
