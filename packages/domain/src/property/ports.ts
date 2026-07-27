import type { MediaAsset, MediaAssetStatus, Property } from "./types";

// --- Repositories -----------------------------------------------------------

export interface PropertyRepository {
  create(input: Omit<Property, "createdAt" | "updatedAt">): Promise<Property>;
  /** Find by id WITHIN an organization scope — never across tenants. */
  findById(organizationId: string, id: string): Promise<Property | null>;
  listByOrganization(organizationId: string): Promise<Property[]>;
  update(property: Property): Promise<Property>;
}

export interface MediaAssetRepository {
  create(input: Omit<MediaAsset, "createdAt" | "updatedAt">): Promise<MediaAsset>;
  findById(organizationId: string, id: string): Promise<MediaAsset | null>;
  listByProperty(organizationId: string, propertyId: string): Promise<MediaAsset[]>;
  update(asset: MediaAsset): Promise<MediaAsset>;
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
