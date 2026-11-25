import { createHmac } from "node:crypto";

/** The label the subject key is derived under, so `SESSION_SECRET` keys nothing else this way (ADR-0170). */
const SUBJECT_KEY_LABEL = "vtavision rate-limit subject v1";

/**
 * What a subject counts: a typed, normalized email address, a client
 * address's key (`v4:...` or `v6:.../64`) or a user id (ADR-0170).
 */
export type RateLimitSubjectFamily = "address" | "client" | "user";

/** The key every subject is made with: HMAC-SHA-256 of a fixed label under `SESSION_SECRET` (ADR-0170). */
export function rateLimitSubjectKey(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret).update(SUBJECT_KEY_LABEL).digest();
}

/**
 * The subject the limiter counts for `value` of `family`: HMAC-SHA-256 under
 * `key` of the family, a NUL and the value, in lowercase hex. The same value
 * in two families gives two subjects, and the store never sees the value
 * (ADR-0169 Decision 5).
 */
export function rateLimitSubject(key: Buffer, family: RateLimitSubjectFamily, value: string): string {
  return createHmac("sha256", key).update(`${family}\u0000${value}`).digest("hex");
}
