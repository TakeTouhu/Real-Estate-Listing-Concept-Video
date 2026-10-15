import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/** RFC 4648 base32, the alphabet authenticator apps read a TOTP secret in. */
export const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 of `bytes` in a 32-character `alphabet`, without padding. */
export function base32Encode(bytes: Uint8Array, alphabet: string = BASE32_ALPHABET): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += alphabet.charAt((buffer >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet.charAt((buffer << (5 - bits)) & 31);
  return out;
}

/** RFC 4226 HOTP: the `digits`-digit code for `counter` (HMAC-SHA-1, dynamic truncation). */
export function hotp(secret: Uint8Array, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM encryption bound to `associatedData`: base64url of iv, tag and ciphertext. */
export function sealAesGcm(key: Uint8Array, plaintext: Uint8Array, associatedData: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Decrypt what `sealAesGcm` produced; throws if it was altered or sealed under another key or associated data. */
export function openAesGcm(key: Uint8Array, sealed: string, associatedData: string): Buffer {
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Sealed value is too short");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/** A short, stable id for a key (a SHA-256 prefix), stored beside what it sealed. */
export function keyFingerprint(key: Uint8Array): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** Cryptographically random bytes. */
export function secureRandomBytes(count: number): Uint8Array {
  return randomBytes(count);
}
