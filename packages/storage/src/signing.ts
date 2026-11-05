import { createHmac } from "node:crypto";
import {
  assertAttachmentFilename,
  assertSignableStorageKey,
  isAttachmentFilename,
  isSignableStorageKey,
  type SignedUrl,
} from "@app/domain";
import { AppError, timingSafeEqualString } from "@app/shared";

export type SignedPurpose = "upload" | "download";

export interface SignedKeyToken {
  readonly key: string;
  readonly purpose: SignedPurpose;
  readonly expiresAtSeconds: number;
  /**
   * A download only: the name the object is saved under, served as an
   * attachment (ADR-0118). Without it, the object is served to be shown.
   */
  readonly attachmentFilename?: string;
}

function payloadOf(token: SignedKeyToken): string {
  const fields: unknown[] = [token.key, token.purpose, token.expiresAtSeconds];
  if (token.attachmentFilename !== undefined) fields.push(token.attachmentFilename);
  return Buffer.from(JSON.stringify(fields), "utf8").toString("base64url");
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
 * scene video under `org/{organizationId}/generations/` (ADR-0115), nor a key
 * that is not canonical, which a store could map onto another object.
 *
 * A file name is signed with a download only, and only one safe to send
 * (ADR-0118): an upload names no file, and is refused like any other defect.
 */
export function signStorageToken(token: SignedKeyToken, secret: string): string {
  assertSignableStorageKey(token.key);
  if (token.attachmentFilename !== undefined) {
    if (token.purpose !== "download") {
      throw new AppError("INTERNAL_ERROR", "Only a download is saved under a file name");
    }
    assertAttachmentFilename(token.attachmentFilename);
  }
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
  /** A download to be saved under this name (ADR-0118). */
  readonly attachmentFilename?: string;
}): SignedUrl {
  const expiresAtSeconds = Math.floor(input.now.getTime() / 1000) + input.ttlSeconds;
  const { key, purpose, attachmentFilename } = input;
  const token = signStorageToken(
    attachmentFilename === undefined
      ? { key, purpose, expiresAtSeconds }
      : { key, purpose, expiresAtSeconds, attachmentFilename },
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
 * Also null for an internal-only, scene or non-canonical key, however the
 * token was made (ADR-0074, ADR-0115), so a route that redeems tokens serves and
 * accepts nothing in the internal namespace and no scene video, and answers
 * exactly as it does for a forged token. Null too for a file name on an upload,
 * or one not safe to send (ADR-0118).
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
  if (!Array.isArray(parsed) || (parsed.length !== 3 && parsed.length !== 4)) return null;
  const [key, purpose, expiresAtSeconds, attachmentFilename] = parsed as [unknown, unknown, unknown, unknown];
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
  if (parsed.length === 3) return { key, purpose, expiresAtSeconds };
  if (purpose !== "download" || typeof attachmentFilename !== "string") return null;
  if (!isAttachmentFilename(attachmentFilename)) return null;
  return { key, purpose, expiresAtSeconds, attachmentFilename };
}
