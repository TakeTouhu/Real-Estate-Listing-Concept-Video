import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;

/**
 * Hash a password with scrypt and a per-password random salt. Encoded as
 * `scrypt$<saltB64url>$<hashB64url>`. No external dependency; uses node:crypto.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

/** Verify a password against a stored scrypt hash in constant time. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "base64url");
  const expected = Buffer.from(parts[2]!, "base64url");
  const derived = await scrypt(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** SHA-256 hex digest — used to store opaque tokens (sessions, invitations). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Cryptographically random, URL-safe token (raw secret; store only its hash). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Prefixed random identifier for public resource IDs. */
export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/** Normalize a name into a URL-safe organization slug. */
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base.length > 0 ? base : "org";
}
