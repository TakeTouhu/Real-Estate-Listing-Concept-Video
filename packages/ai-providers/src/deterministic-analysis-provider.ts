import { createHash } from "node:crypto";
import {
  ROOM_TYPES,
  analysisProviderError,
  normalizeAnalysisResult,
  type AnalysisProviderError,
  type AnalysisRequest,
  type AnalysisResult,
  type ImageAnalysisProvider,
  type RoomType,
  type SafetyFlag,
} from "@app/domain";

export interface DeterministicAnalysisProviderOptions {
  /**
   * Room type forced for every request. When omitted the room type is derived
   * from a hash of the asset id, so results are stable per asset yet varied
   * across a property.
   */
  readonly forcedRoomType?: RoomType;
  /** Force a specific confidence, e.g. to exercise the low-confidence path. */
  readonly forcedConfidence?: number;
  /** Extra safety flags to attach, e.g. to exercise blocking behaviour. */
  readonly extraFlags?: readonly SafetyFlag[];
  /** When true, `analyze` rejects — used to exercise the FAILED path. */
  readonly failWith?: Error;
}

/** Stable 0..1 value derived from a seed string. */
function hashUnit(seed: string, salt: string): number {
  const digest = createHash("sha256").update(`${salt}:${seed}`).digest();
  // Use two bytes for a reasonable granularity.
  return ((digest[0]! << 8) | digest[1]!) / 65535;
}

/**
 * Deterministic, fully offline image-analysis adapter.
 *
 * Phase 3 ships this as the only analysis provider (see ADR-0009): it performs
 * no network I/O and derives every score from the asset id and image bytes, so
 * results are reproducible in tests and CI. It is a structural stand-in, not a
 * real classifier — it makes no claim about the actual content of a photo.
 */
export class DeterministicImageAnalysisProvider implements ImageAnalysisProvider {
  readonly name = "deterministic";
  private readonly options: DeterministicAnalysisProviderOptions;

  constructor(options: DeterministicAnalysisProviderOptions = {}) {
    this.options = options;
  }

  analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    if (this.options.failWith) {
      return Promise.reject(this.options.failWith);
    }
    if (request.imageBytes.byteLength === 0) {
      return Promise.reject(
        analysisProviderError({
          kind: "INVALID_INPUT",
          code: "EMPTY_IMAGE",
          messageSanitized: "The image contained no data",
        }),
      );
    }

    const seed = request.assetId;
    const roomIndex = Math.floor(hashUnit(seed, "room") * ROOM_TYPES.length);
    const roomType = this.options.forcedRoomType ?? ROOM_TYPES[Math.min(roomIndex, ROOM_TYPES.length - 1)]!;
    const confidence = this.options.forcedConfidence ?? 0.65 + hashUnit(seed, "conf") * 0.34;

    // Brightness is measured from the actual bytes so the value responds to the
    // image, while remaining deterministic for identical input.
    const brightnessScore = meanByte(request.imageBytes) / 255;
    const blurScore = hashUnit(seed, "blur") * 0.5;
    const qualityScore = clamp01(
      0.5 + (1 - blurScore) * 0.3 + (isWellExposed(brightnessScore) ? 0.2 : 0),
    );

    return Promise.resolve(
      normalizeAnalysisResult({
        roomType,
        confidence,
        qualityScore,
        brightnessScore,
        blurScore,
        detectedObjects: [
          { label: "window", confidence: hashUnit(seed, "window") },
          { label: "floor", confidence: hashUnit(seed, "floor") },
        ],
        safetyFlags: this.options.extraFlags ?? [],
      }),
    );
  }

  normalizeError(error: unknown): AnalysisProviderError {
    if (
      error !== null &&
      typeof error === "object" &&
      "kind" in error &&
      "retryable" in error &&
      "messageSanitized" in error
    ) {
      return error as AnalysisProviderError;
    }
    return analysisProviderError({
      kind: "UNKNOWN",
      code: "DETERMINISTIC_PROVIDER_ERROR",
      messageSanitized: "Image analysis could not be completed",
    });
  }
}

function meanByte(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  // Sample at most 4096 bytes for a stable, bounded computation.
  const step = Math.max(1, Math.floor(bytes.byteLength / 4096));
  let total = 0;
  let count = 0;
  for (let i = 0; i < bytes.byteLength; i += step) {
    total += bytes[i]!;
    count += 1;
  }
  return count === 0 ? 0 : total / count;
}

function isWellExposed(brightness: number): boolean {
  return brightness > 0.2 && brightness < 0.9;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
