export type PropertyStatus = "ACTIVE" | "ARCHIVED" | "DELETED";
export type PropertyType = "APARTMENT" | "HOUSE" | "OFFICE" | "RETAIL" | "OTHER";

export const PROPERTY_TYPES: readonly PropertyType[] = [
  "APARTMENT",
  "HOUSE",
  "OFFICE",
  "RETAIL",
  "OTHER",
];

export interface Property {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly propertyType: PropertyType;
  readonly addressMasked: string | null;
  readonly description: string | null;
  readonly status: PropertyStatus;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * MediaAsset upload lifecycle:
 *
 *   PENDING_UPLOAD → UPLOADED → SCANNING → PROCESSING → READY
 *                                  ↓            ↓
 *                             QUARANTINED   REJECTED / FAILED
 *   READY → DELETION_PENDING → DELETED
 *
 * PENDING_UPLOAD assets whose signed upload window lapses can be re-requested
 * (failed-upload recovery) or garbage-collected.
 */
export type MediaAssetStatus =
  | "PENDING_UPLOAD"
  | "UPLOADED"
  | "SCANNING"
  | "QUARANTINED"
  | "PROCESSING"
  | "READY"
  | "REJECTED"
  | "FAILED"
  | "DELETION_PENDING"
  | "DELETED";

export interface MediaAsset {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly storageKey: string;
  readonly originalFilename: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly sha256: string | null;
  readonly perceptualHash: string | null;
  readonly status: MediaAssetStatus;
  readonly failureReason: string | null;
  readonly thumbnailKey: string | null;
  readonly createdBy: string;
  readonly deletionRequestedAt: Date | null;
  readonly retentionExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Upload constraints, configuration data (not hard-coded at call sites). */
export interface UploadLimits {
  readonly maxFileSizeBytes: number;
  readonly maxAssetsPerProperty: number;
  readonly minImageDimensionPx: number;
  readonly maxImageDimensionPx: number;
  readonly allowedMimeTypes: readonly string[];
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxFileSizeBytes: 25 * 1024 * 1024,
  maxAssetsPerProperty: 20,
  minImageDimensionPx: 480,
  maxImageDimensionPx: 12000,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
};
