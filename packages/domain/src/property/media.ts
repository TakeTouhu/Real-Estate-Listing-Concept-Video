/**
 * Content-based MIME detection. The declared filename/Content-Type from the
 * client is untrusted; the real type is derived from magic bytes
 * (SecurityCompliance.md: "Verify MIME type from file bytes").
 */
export type SniffedMime = "image/jpeg" | "image/png" | "image/webp" | null;

function startsWith(data: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false;
  return bytes.every((b, i) => data[offset + i] === b);
}

export function sniffMimeType(data: Uint8Array): SniffedMime {
  // JPEG: FF D8 FF
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // WebP: "RIFF" .... "WEBP"
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

/** Map a sniffed MIME type to a canonical file extension. */
export function extensionFor(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

/**
 * Build an organization-prefixed, opaque storage key. Keys must not contain
 * customer names, addresses, or secrets (WaveSpeedAIIntegration.md /
 * SecurityCompliance.md) — only internal ids.
 */
export function buildAssetStorageKey(input: {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly assetId: string;
  readonly variant: "original" | "normalized" | "thumbnail";
  readonly extension: string;
}): string {
  return [
    "org",
    input.organizationId,
    "properties",
    input.propertyId,
    "assets",
    input.assetId,
    `${input.variant}.${input.extension}`,
  ].join("/");
}

/** Extract the organization id from a storage key, or null if malformed. */
export function organizationIdFromStorageKey(key: string): string | null {
  const parts = key.split("/");
  return parts[0] === "org" && typeof parts[1] === "string" && parts[1].length > 0 ? parts[1] : null;
}

/**
 * Hamming distance between two equal-length hex perceptual hashes. Lower means
 * more similar; 0 means the downscaled luminance signature is identical.
 */
export function hammingDistanceHex(a: string, b: string): number {
  if (a.length !== b.length) throw new Error("perceptual hashes must be the same length");
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const xor = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    distance += ((xor >> 3) & 1) + ((xor >> 2) & 1) + ((xor >> 1) & 1) + (xor & 1);
  }
  return distance;
}

/** Default threshold for treating two images as near-duplicates. */
export const DUPLICATE_HAMMING_THRESHOLD = 6;
