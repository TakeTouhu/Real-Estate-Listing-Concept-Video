/**
 * Email delivered by an SMTP server (ADR-0166). A subpath of its own, so the worker, which loads `@app/storage`,
 * never loads the mail library; the web app's adapters build it for each email when `SMTP_HOST` is set, so every
 * route that loads them loads the library too (ADR-0168).
 */
export { SMTP_LIMITS_MS, createSmtpEmailSender, smtpFailureCode } from "./smtp-email-sender";
export type { SmtpEmailSenderOptions, SmtpTls } from "./smtp-email-sender";
