import { AppError } from "@app/shared";
import { normalizeEmail } from "../identity/util";

/**
 * The emails the product sends (ADR-0126): the link that verifies an account's
 * email and the link that resets a password (ADR-0052 Decision 18), and an
 * invitation to an organization. Each is a kind, so a reader of the outbox, or
 * a delivery service's category, can tell them apart without reading the text.
 */
export const EMAIL_KINDS = ["EMAIL_VERIFICATION", "PASSWORD_RESET", "INVITATION"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** The longest address mail can carry (RFC 5321's path limit, less its brackets). */
export const EMAIL_ADDRESS_MAX_LENGTH = 254;
/** The longest local part, before the `@` (RFC 5321). */
export const EMAIL_LOCAL_PART_MAX_LENGTH = 64;
/** The longest subject, in characters. */
export const EMAIL_SUBJECT_MAX_LENGTH = 200;
/** The longest body, in characters. */
export const EMAIL_TEXT_MAX_LENGTH = 10_000;

declare const outgoingEmailBrand: unique symbol;

/**
 * One email, checked, produced only by {@link outgoingEmail}. Plain text only:
 * no HTML, no headers, no attachments, one recipient.
 */
export type OutgoingEmail = {
  readonly kind: EmailKind;
  /** The recipient, normalized as the product stores every email address. */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
} & { readonly [outgoingEmailBrand]: "OutgoingEmail" };

// RFC 5322's dot-atom: atext runs joined by single dots. No quoted local part,
// no comments, no display name, no list: one bare ASCII address.
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
// Two or more DNS labels of letters, digits and inner hyphens. An
// internationalized domain is accepted in its ASCII (punycode) form.
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// A control character, or a line or paragraph separator: anything that could
// end a header line, or hide in one.
const SUBJECT_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
// A control character. The body breaks lines with "\n" alone, so that one is
// taken out before this is asked; every other, a carriage return included, is
// refused.
const CONTROL = /\p{Cc}/u;

/**
 * Whether mail can be addressed to this address: one plain ASCII address,
 * `local@domain`, after the product's normalization (trimmed, lower case). It
 * judges the form only; whether the mailbox exists is the delivery's to find.
 */
export function isDeliverableEmailAddress(address: string): boolean {
  const normalized = normalizeEmail(address);
  if (normalized.length > EMAIL_ADDRESS_MAX_LENGTH) return false;
  const at = normalized.indexOf("@");
  if (at < 0 || at !== normalized.lastIndexOf("@")) return false;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return local.length <= EMAIL_LOCAL_PART_MAX_LENGTH && LOCAL_PART.test(local) && DOMAIN.test(domain);
}

function characters(value: string): number {
  return Array.from(value).length;
}

/**
 * The one place an email is made. Refuses, with `VALIDATION_FAILED`, a
 * recipient mail cannot be addressed to, a blank or over-long subject or body,
 * a subject with a control character or line break, a body with any control
 * character but "\n", and a kind the product does not send. No message names
 * the address or quotes the text, so a refusal is safe to log.
 */
export function outgoingEmail(input: {
  readonly kind: EmailKind;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}): OutgoingEmail {
  if (!(EMAIL_KINDS as readonly string[]).includes(input.kind)) {
    throw new AppError("VALIDATION_FAILED", "The product sends no email of this kind");
  }
  if (!isDeliverableEmailAddress(input.to)) {
    throw new AppError("VALIDATION_FAILED", "The email's recipient is not an address mail can be sent to");
  }
  if (input.subject.trim() === "" || characters(input.subject) > EMAIL_SUBJECT_MAX_LENGTH) {
    throw new AppError("VALIDATION_FAILED", `The email's subject must be 1 to ${EMAIL_SUBJECT_MAX_LENGTH} characters`);
  }
  if (SUBJECT_FORBIDDEN.test(input.subject)) {
    throw new AppError("VALIDATION_FAILED", "The email's subject must be one line with no control characters");
  }
  if (input.text.trim() === "" || characters(input.text) > EMAIL_TEXT_MAX_LENGTH) {
    throw new AppError("VALIDATION_FAILED", `The email's text must be 1 to ${EMAIL_TEXT_MAX_LENGTH} characters`);
  }
  if (CONTROL.test(input.text.replaceAll("\n", ""))) {
    throw new AppError(
      "VALIDATION_FAILED",
      'The email\'s text must break lines with "\\n" and hold no other control character',
    );
  }
  return Object.freeze({
    kind: input.kind,
    to: normalizeEmail(input.to),
    subject: input.subject,
    text: input.text,
  }) as OutgoingEmail;
}
