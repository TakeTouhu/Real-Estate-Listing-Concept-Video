import { base32Encode, sha256Hex } from "@app/shared";
import type { MfaRandom } from "./ports";

/** How many recovery codes a set holds. */
export const RECOVERY_CODE_COUNT = 10;
/** Crockford base32: no I, L, O or U, so a code copied by hand reads back. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new recovery code: 80 random bits as 16 characters, `XXXX-XXXX-XXXX-XXXX`. */
export function generateRecoveryCode(random: MfaRandom): string {
  return base32Encode(random.bytes(10), CROCKFORD).replace(/(.{4})(?!$)/g, "$1-");
}

/** A recovery code as typed, in its stored form; null if it cannot be one. */
export function normalizeRecoveryCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(compact) ? compact : null;
}

/** What is stored for a normalized code. 80 random bits need no slow hash. */
export function hashRecoveryCode(normalized: string): string {
  return sha256Hex(normalized);
}
