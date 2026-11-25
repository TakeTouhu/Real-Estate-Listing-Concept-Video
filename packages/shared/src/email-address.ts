/**
 * The rule for an email address that the domain, the environment and the SMTP sender share (ADR-0126, ADR-0167).
 * Moved here from `@app/domain` so the environment can judge `EMAIL_FROM` with it; the domain re-exports it.
 */

/** The longest address mail can carry (RFC 5321's path limit, less its brackets). */
export const EMAIL_ADDRESS_MAX_LENGTH = 254;
/** The longest local part, before the `@` (RFC 5321). */
export const EMAIL_LOCAL_PART_MAX_LENGTH = 64;

// RFC 5322's dot-atom: atext runs joined by single dots. No quoted local part,
// no comments, no display name, no list: one bare ASCII address.
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
// Two or more DNS labels of letters, digits and inner hyphens. An
// internationalized domain is accepted in its ASCII (punycode) form.
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** An address as the product stores it: trimmed, in lower case. The domain's `normalizeEmail` returns this. */
export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Whether mail can be addressed to this address: one plain ASCII address,
 * `local@domain`, after the product's normalization (trimmed, lower case). It
 * judges the form only; whether the mailbox exists is the delivery's to find.
 */
export function isDeliverableEmailAddress(address: string): boolean {
  const normalized = normalizeEmailAddress(address);
  if (normalized.length > EMAIL_ADDRESS_MAX_LENGTH) return false;
  const at = normalized.indexOf("@");
  // A second "@" falls in the domain, which no domain label admits.
  if (at < 0) return false;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return local.length <= EMAIL_LOCAL_PART_MAX_LENGTH && LOCAL_PART.test(local) && DOMAIN.test(domain);
}

/**
 * Whether `value` is one deliverable address already in the product's form, so nothing about it is changed
 * silently: what a configured sender must be (ADR-0166, ADR-0167).
 */
export function isPlainEmailAddress(value: string): boolean {
  return value === normalizeEmailAddress(value) && isDeliverableEmailAddress(value);
}
