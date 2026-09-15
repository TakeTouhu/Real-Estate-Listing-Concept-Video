import { hasExactlyOwnKeys, isPlainRecord } from "../submission/untrusted";
import type { ManagedGenerationOutputKey, ManagedOutputVerificationReceipt } from "../completion/output";

/**
 * Whether the bytes already published at a managed-output key are *media* — a
 * question deliberately separate from whether they are the *right bytes*.
 *
 * ## Why this is not `OUTPUT_VERIFIED`
 *
 * `OUTPUT_VERIFIED` means, and continues to mean, exactly one thing: the
 * canonical managed bytes were copied and their byte-level integrity was
 * verified against a SHA-256 and a byte count. It does **not** mean the object
 * is playable video, and this phase does not redefine it. A digest proves the
 * object at the key is the object that was streamed; it says nothing about
 * container, streams, or duration.
 *
 * This port adds the missing, orthogonal question — "is this an MP4-family
 * container with a usable video stream and a real duration?" — as a capability
 * nothing in the current runner calls. No durable state is added, and where
 * media validity eventually enters the attempt lifecycle is a later, reviewed
 * decision. Keeping the two facts distinct is what lets that decision be made
 * later without retroactively changing what an already-`OUTPUT_VERIFIED` row
 * claimed.
 *
 * ## What the port may and may not see
 *
 * A destination key and the receipt the transfer already computed. No provider
 * URL, no prediction id, no signed location, no bucket — the adapter's own
 * configuration supplies storage coordinates, and nothing provider-shaped
 * crosses this boundary.
 */
export interface ManagedOutputMediaValidationInput {
  readonly destinationKey: ManagedGenerationOutputKey;
  readonly expectedReceipt: ManagedOutputVerificationReceipt;
}

/**
 * The validation port. Returns `unknown` for the same reason every
 * infrastructure port in this pipeline does: the implementation is an adapter
 * over a storage client and a subprocess, and the consumer validates what comes
 * back rather than trusting a type it cannot enforce at the boundary.
 */
export interface ManagedOutputMediaValidationPort {
  validate(input: ManagedOutputMediaValidationInput): Promise<unknown>;
}

/**
 * The container families this repository is willing to name. Closed and
 * application-owned: an adapter cannot invent a family, and a raw `format_name`
 * string never crosses the boundary.
 */
export const ISO_BMFF_CONTAINER = "ISO_BMFF";
export type ManagedOutputContainerFamily = typeof ISO_BMFF_CONTAINER;

/**
 * The normalized media facts a successful validation may report — and nothing
 * else.
 *
 * Deliberately small. There is no raw ffprobe JSON here, no `format_name`, no
 * codec prose, no filename, no temp path, no bucket, no key, no AWS metadata,
 * no command string and no process output. Those are adapter-internal transient
 * values, and a field that travels is a field something will eventually log.
 *
 * Audio is *optional*: `audioStreamCount` may legitimately be `0`. A generated
 * walkthrough with no audio track is valid media, and requiring audio here
 * would encode a product rule this phase has no authority to make.
 *
 * The dimensions are facts about the bytes, not a contract check. They are
 * deliberately **not** compared against `targetOutputResolution`: this
 * repository distinguishes the customer's target output resolution from the
 * provider's native generation resolution, and conflating them here would
 * invent a rule neither one states.
 */
export interface ManagedOutputMediaFacts {
  readonly container: ManagedOutputContainerFamily;
  readonly durationMs: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly videoStreamCount: number;
  readonly audioStreamCount: number;
}

/**
 * Why media was judged invalid. Fixed, closed, application-owned codes.
 *
 * `PROBE_REJECTED` is the structurally-unreadable case: the inspector ran and
 * refused the file. It carries no inspector output — an external tool's stderr
 * is external data, and there is no field here to carry it.
 */
export const MEDIA_INVALID_REASONS = [
  "CONTAINER_UNSUPPORTED",
  "VIDEO_STREAM_MISSING",
  "VIDEO_DIMENSIONS_INVALID",
  "DURATION_INVALID",
  "PROBE_REJECTED",
] as const;
export type ManagedOutputMediaInvalidReason = (typeof MEDIA_INVALID_REASONS)[number];

/**
 * What one validation can conclude, and deliberately nothing else.
 *
 * ```text
 * VALID               MP4-family container, a usable video stream, a real duration
 * INVALID_MEDIA       the bytes are not media this pipeline will accept
 * INTEGRITY_MISMATCH  the object at the key is not the bytes the receipt describes
 * RETRYABLE_FAILURE   not now — storage, materialization or inspector transient
 * ```
 *
 * `INTEGRITY_MISMATCH` is distinct from `INVALID_MEDIA` on purpose. "The object
 * is not what we published" and "the object is not video" call for different
 * responses, and collapsing them would let a corrupted or replaced object be
 * reported as a media problem.
 *
 * No arm carries a message, a path, a storage diagnostic or process output.
 */
export type ManagedOutputMediaValidationOutcome =
  | { readonly kind: "VALID"; readonly facts: ManagedOutputMediaFacts }
  | { readonly kind: "INVALID_MEDIA"; readonly reason: ManagedOutputMediaInvalidReason }
  | { readonly kind: "INTEGRITY_MISMATCH" }
  | { readonly kind: "RETRYABLE_FAILURE" };

/** The complete own-property set of each arm. Exhaustive, not a minimum. */
export const VALID_MEDIA_KEYS: readonly string[] = ["kind", "facts"];
export const INVALID_MEDIA_KEYS: readonly string[] = ["kind", "reason"];
export const INTEGRITY_MISMATCH_KEYS: readonly string[] = ["kind"];
export const RETRYABLE_MEDIA_KEYS: readonly string[] = ["kind"];
export const MEDIA_FACTS_KEYS: readonly string[] = [
  "container",
  "durationMs",
  "videoWidth",
  "videoHeight",
  "videoStreamCount",
  "audioStreamCount",
];

/** A positive, finite, safe-integer count of milliseconds or pixels. */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A non-negative safe-integer stream count — zero audio streams is legal. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Read media facts once, under a guard, into a fresh plain object — or `null`.
 *
 * Total over hostile objects. The value arrived from an adapter, so reading any
 * property may invoke a getter, and enumerating own keys may hit a proxy trap. A
 * getter that throws is not a fact; the answer is `null`, never the getter's own
 * error escaping. Every property is read exactly once, inside the guard, and the
 * caller receives a plain object with exactly six own data properties that
 * cannot surprise it on a second read.
 */
export function parseManagedOutputMediaFacts(value: unknown): ManagedOutputMediaFacts | null {
  if (!isPlainRecord(value)) return null;
  try {
    if (!hasExactlyOwnKeys(value, MEDIA_FACTS_KEYS)) return null;
    const container: unknown = value.container;
    const durationMs: unknown = value.durationMs;
    const videoWidth: unknown = value.videoWidth;
    const videoHeight: unknown = value.videoHeight;
    const videoStreamCount: unknown = value.videoStreamCount;
    const audioStreamCount: unknown = value.audioStreamCount;
    if (container !== ISO_BMFF_CONTAINER) return null;
    if (!isPositiveSafeInteger(durationMs)) return null;
    if (!isPositiveSafeInteger(videoWidth)) return null;
    if (!isPositiveSafeInteger(videoHeight)) return null;
    // A VALID result must describe at least one video stream; audio may be zero.
    if (!isPositiveSafeInteger(videoStreamCount)) return null;
    if (!isNonNegativeSafeInteger(audioStreamCount)) return null;
    return {
      container: ISO_BMFF_CONTAINER,
      durationMs,
      videoWidth,
      videoHeight,
      videoStreamCount,
      audioStreamCount,
    };
  } catch {
    return null;
  }
}

/**
 * Read a validation outcome once, under a guard, into a fresh plain object — or
 * `null`.
 *
 * The single authority on what an adapter returned. `kind` is read exactly once
 * into a local and everything below acts on that local, so a stateful getter
 * that answers once and then throws — or answers differently — cannot pass
 * validation and then explode in the caller's dispatch. The caller never has to
 * re-read the raw adapter output, and no adapter value is carried through: the
 * facts are re-materialized by {@link parseManagedOutputMediaFacts}, and the
 * reason must be one of the closed codes.
 */
export function parseManagedOutputMediaValidationOutcome(
  value: unknown,
): ManagedOutputMediaValidationOutcome | null {
  if (!isPlainRecord(value)) return null;
  try {
    const kind: unknown = value.kind;
    switch (kind) {
      case "VALID": {
        if (!hasExactlyOwnKeys(value, VALID_MEDIA_KEYS)) return null;
        const facts = parseManagedOutputMediaFacts(value.facts);
        return facts === null ? null : { kind: "VALID", facts };
      }
      case "INVALID_MEDIA": {
        if (!hasExactlyOwnKeys(value, INVALID_MEDIA_KEYS)) return null;
        const reason: unknown = value.reason;
        return typeof reason === "string" &&
          (MEDIA_INVALID_REASONS as readonly string[]).includes(reason)
          ? { kind: "INVALID_MEDIA", reason: reason as ManagedOutputMediaInvalidReason }
          : null;
      }
      case "INTEGRITY_MISMATCH":
        return hasExactlyOwnKeys(value, INTEGRITY_MISMATCH_KEYS)
          ? { kind: "INTEGRITY_MISMATCH" }
          : null;
      case "RETRYABLE_FAILURE":
        return hasExactlyOwnKeys(value, RETRYABLE_MEDIA_KEYS)
          ? { kind: "RETRYABLE_FAILURE" }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Whether a value is a usable validation outcome. */
export function isWellFormedMediaValidationOutcome(
  value: unknown,
): value is ManagedOutputMediaValidationOutcome {
  return parseManagedOutputMediaValidationOutcome(value) !== null;
}
