import type { MediaAssetRepository } from "../property/ports";
import type { AssetAnalysis, DetectedObject, RoomType, SafetyFlag } from "./types";

/**
 * Normalized request handed to any analysis provider. Contains only internal
 * identifiers and image bytes/metadata — never customer names or addresses.
 */
export interface AnalysisRequest {
  readonly assetId: string;
  readonly imageBytes: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  /** Perceptual hash produced in Phase 2, used for duplicate grouping. */
  readonly perceptualHash: string | null;
}

/**
 * Normalized provider result. Every provider maps its own payload into this
 * shape inside its adapter; no vendor-specific field crosses the boundary.
 */
export interface AnalysisResult {
  readonly roomType: RoomType;
  readonly confidence: number;
  readonly qualityScore: number;
  readonly brightnessScore: number;
  readonly blurScore: number;
  readonly detectedObjects: readonly DetectedObject[];
  readonly safetyFlags: readonly SafetyFlag[];
}

export type AnalysisProviderErrorKind =
  | "INVALID_INPUT"
  | "UNSUPPORTED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "PROVIDER"
  | "UNKNOWN";

/** Normalized provider error; `messageSanitized` is safe for logs and support. */
export interface AnalysisProviderError {
  readonly kind: AnalysisProviderErrorKind;
  readonly retryable: boolean;
  readonly code: string;
  readonly messageSanitized: string;
}

/**
 * The single seam through which the platform performs image analysis. Phase 3
 * ships deterministic offline adapters only; a real vision vendor would be a
 * new implementation of this interface plus its own ADR (see ADR-0009).
 */
export interface ImageAnalysisProvider {
  readonly name: string;
  analyze(request: AnalysisRequest): Promise<AnalysisResult>;
  normalizeError(error: unknown): AnalysisProviderError;
}

/** Tenant-scoped persistence port for analysis records. */
export interface AssetAnalysisRepository {
  create(input: Omit<AssetAnalysis, "createdAt" | "updatedAt">): Promise<AssetAnalysis>;
  /** Organization-scoped read; another tenant's row is never returned. */
  findById(organizationId: string, id: string): Promise<AssetAnalysis | null>;
  findByAssetId(organizationId: string, assetId: string): Promise<AssetAnalysis | null>;
  listByAssetIds(
    organizationId: string,
    assetIds: readonly string[],
  ): Promise<AssetAnalysis[]>;
  update(analysis: AssetAnalysis): Promise<AssetAnalysis>;
}

/** The repositories a review decision writes to, bound to one transaction. */
export interface ReviewRepositories {
  readonly analyses: AssetAnalysisRepository;
  readonly assets: MediaAssetRepository;
}

/**
 * Runs a review decision's writes inside a single database transaction.
 *
 * Rejecting an asset updates two rows — the analysis review state and the
 * asset's status — and they must not partially commit. Everything inside `run`
 * either commits together or not at all; a throw rolls the whole unit back and
 * propagates.
 *
 * The audit entry is deliberately **outside** this boundary. Audit atomicity
 * needs a shared transaction with the audit table or a transactional outbox,
 * which remains an open item in `docs/decisions/TODO.md`; this port does not
 * provide it and must not be described as if it does.
 */
export interface ReviewTransaction {
  run<T>(fn: (repos: ReviewRepositories) => Promise<T>): Promise<T>;
}
