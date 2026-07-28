import type { AnalysisResult, AnalysisProviderError, AnalysisProviderErrorKind } from "./ports";
import { DEFAULT_UPLOAD_LIMITS } from "../property/types";
import { isRoomType, type DetectedObject, type SafetyFlag } from "./types";

/** Clamp any provider-supplied score into the normalized 0..1 range. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

const RETRYABLE: ReadonlySet<AnalysisProviderErrorKind> = new Set<AnalysisProviderErrorKind>([
  "RATE_LIMITED",
  "TIMEOUT",
  "PROVIDER",
]);

export function analysisProviderError(init: {
  readonly kind: AnalysisProviderErrorKind;
  readonly code: string;
  readonly messageSanitized: string;
  readonly retryable?: boolean;
}): AnalysisProviderError {
  return {
    kind: init.kind,
    code: init.code,
    messageSanitized: init.messageSanitized,
    retryable: init.retryable ?? RETRYABLE.has(init.kind),
  };
}

/**
 * Normalize a raw provider result: clamp scores, drop unknown room types to
 * OTHER with zero confidence, and bound the object/flag collections. This runs
 * for every provider so downstream code can trust the value ranges.
 */
export function normalizeAnalysisResult(raw: {
  readonly roomType?: unknown;
  readonly confidence?: unknown;
  readonly qualityScore?: unknown;
  readonly brightnessScore?: unknown;
  readonly blurScore?: unknown;
  readonly detectedObjects?: unknown;
  readonly safetyFlags?: unknown;
}): AnalysisResult {
  const roomType = isRoomType(raw.roomType) ? raw.roomType : "OTHER";
  const confidence = isRoomType(raw.roomType) ? clampScore(Number(raw.confidence)) : 0;
  const objects = Array.isArray(raw.detectedObjects) ? raw.detectedObjects : [];
  const flags = Array.isArray(raw.safetyFlags) ? raw.safetyFlags : [];

  return {
    roomType,
    confidence,
    qualityScore: clampScore(Number(raw.qualityScore)),
    brightnessScore: clampScore(Number(raw.brightnessScore)),
    blurScore: clampScore(Number(raw.blurScore)),
    detectedObjects: objects.slice(0, 50).map(
      (o): DetectedObject => ({
        label: String((o as DetectedObject).label ?? "unknown").slice(0, 64),
        confidence: clampScore(Number((o as DetectedObject).confidence)),
      }),
    ),
    safetyFlags: flags.slice(0, 20) as readonly SafetyFlag[],
  };
}

/**
 * Derive resolution/blur/exposure findings from normalized scores and image
 * dimensions. These are platform rules, not provider output, so every provider
 * yields consistent warnings.
 */
export function deriveQualityFlags(input: {
  readonly width: number;
  readonly height: number;
  readonly blurScore: number;
  readonly brightnessScore: number;
}): SafetyFlag[] {
  const flags: SafetyFlag[] = [];
  if (Math.min(input.width, input.height) < DEFAULT_UPLOAD_LIMITS.minImageDimensionPx) {
    flags.push({
      code: "LOW_RESOLUTION",
      severity: "WARNING",
      message: "This photo is smaller than the recommended resolution.",
    });
  }
  if (input.blurScore >= 0.6) {
    flags.push({
      code: "BLURRY",
      severity: "WARNING",
      message: "This photo appears blurry.",
    });
  }
  if (input.brightnessScore <= 0.2 || input.brightnessScore >= 0.9) {
    flags.push({
      code: "EXPOSURE_PROBLEM",
      severity: "WARNING",
      message: "This photo looks under- or over-exposed.",
    });
  }
  return flags;
}
