/**
 * Email delivered by an SMTP server (ADR-0166). A subpath of its own, so nothing that loads `@app/storage` (the
 * worker, the upload routes) loads the mail library; nothing in the apps builds it yet.
 */
export { SMTP_LIMITS_MS, createSmtpEmailSender, smtpFailureCode } from "./smtp-email-sender";
export type { SmtpEmailSenderOptions, SmtpTls } from "./smtp-email-sender";
