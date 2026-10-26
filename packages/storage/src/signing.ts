import { createHmac } from "node:crypto";
import { assertSignableStorageKey, isSignableStorageKey, type SignedUrl } from "@app/domain";
import { timingSafeEqualString } from "@app/shared";

export type SignedPurpose = "upload" | "download";

export interface SignedKeyToken {
  readonly key: string;
  readonly purpose: SignedPurpose;
  readonly expiresAtSeconds: number;
}

function payloadOf(token: SignedKeyToken): string {
  return Buffer.from(
    JSON.stringify([token.key, token.purpose, token.expiresAtSeconds]),
    "utf8",
  ).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Create a single-purpose, expiring token that authorizes exactly one storage
 * key for exactly one operation. Upload tokens cannot be used to download and
 * vice versa (SecurityCompliance.md: "Input URLs are single-purpose").
 *
 * Throws for an internal-only key (ADR-0074): the Clean Master, and anything
 * else under `org/{organizationId}/internal/`, is never given a URL. Nor is a
 * key that is not canonical, which a store could map onto another object.
 */
export function signStorageToken(token: SignedKeyToken, secret: string): string {
  assertSignableStorageKey(token.key);
  const payload = payloadOf(token);
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * A signed URL for one key and one purpose, served under `basePath`. Every
 * signing store makes its URLs here, so each refuses an internal-only key the
 * same way.
 */
export function signedStorageUrl(input: {
  readonly key: string;
  readonly purpose: SignedPurpose;
  readonly ttlSeconds: number;
  readonly secret: string;
  readonly basePath: string;
  readonly now: Date;
}): SignedUrl {
  const expiresAtSeconds = Math.floor(input.now.getTime() / 1000) + input.ttlSeconds;
  const token = signStorageToken(
    { key: input.key, purpose: input.purpose, expiresAtSeconds },
    input.secret,
  );
  return {
    url: `${input.basePath}/${input.purpose}?token=${encodeURIComponent(token)}`,
    expiresAt: new Date(expiresAtSeconds * 1000),
  };
}

/**
 * Verify a storage token. Returns the token when the signature is valid, the
 * purpose matches, and it has not expired; otherwise null.
 *
 * Also null for an internal-only or non-canonical key, however the token was
 * made (ADR-0074), so a route that redeems tokens serves and accepts nothing in
 * the internal namespace, and answers exactly as it does for a forged token.
 */
export function verifyStorageToken(
  raw: string,
  secret: string,
  expectedPurpose: SignedPurpose,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SignedKeyToken | null {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!timingSafeEqualString(signature, sign(payload, secret))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [key, purpose, expiresAtSeconds] = parsed as [unknown, unknown, unknown];
  if (
    typeof key !== "string" ||
    (purpose !== "upload" && purpose !== "download") ||
    typeof expiresAtSeconds !== "number"
  ) {
    return null;
  }
  if (purpose !== expectedPurpose) return null;
  if (expiresAtSeconds <= nowSeconds) return null;
  if (!isSignableStorageKey(key)) return null;
  return { key, purpose, expiresAtSeconds };
}
