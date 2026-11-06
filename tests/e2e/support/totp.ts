import { createHmac } from "node:crypto";

/**
 * An authenticator app, for the browser test (GS-13a, ADR-0121): the code RFC
 * 6238 gives for a key typed in base32, with the settings the app offers
 * (SHA-1, 6 digits, 30 seconds). Written apart from the app's own, so the test
 * checks the app against the standard and not against itself.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function decodeBase32(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.replace(/[\s=]/g, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("The key is not base32");
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The HOTP value (RFC 4226) of `counter`, as `digits` digits. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const number = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 10 ** digits).padStart(digits, "0");
}

/** The code an authenticator app shows at `at` for a base32 key. */
export function totp(base32Key: string, at: Date = new Date()): string {
  return hotp(decodeBase32(base32Key), Math.floor(at.getTime() / 1000 / 30));
}
