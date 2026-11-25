# API Changes — RD-6d

SMTP in the web app (ADR-0168). **No migration, no route, no page, no
setting and no dependency.**

## HTTP

No change in any response. With `SMTP_HOST` set, sign-up, asking for a
verification email again, a password reset and an invitation hand their
email to the SMTP server; a send that fails answers as a failed send
did before. Readiness asks no SMTP server. Its `start` check, which gives
what the start check refuses (ADR-0154), no longer names email for a
production environment with `SMTP_HOST` set; with Google's store, ClamAV
and the three production settings beside it, it now passes, so the probe
answers `ready` where it answered `degraded`.

## Internal API

| Change | Where |
| --- | --- |
| `WebAdapterChoice.email` is `"smtp"`, `"outbox"` or `"none"`; `smtp` when `SMTP_HOST` is set | `apps/web/src/lib/adapter-choice.ts` |
| `createWebAdapters(env).email()` builds the SMTP sender for each email, wrapped so a failed send is logged by its code | `apps/web/src/lib/adapters.ts` |
| New: `emailFailureCode`, `loggingEmailFailures` | `apps/web/src/lib/adapters.ts` |
| `PRODUCTION_ADAPTERS.email` is `["smtp"]` | `apps/web/src/lib/startup.ts` |
| `createSmtpEmailSender`'s rejection gains `details: { smtpCode }` | `@app/storage/smtp` |
| The outbox's production refusal names the SMTP settings as what to set | `@app/storage` |

Unchanged: `EmailSender`, `outgoingEmail`, the mailer's behaviour, the
four flows that send, and the worker, which never builds the SMTP
sender.

## Logs

| Line | When |
| --- | --- |
| `warn`, component `email`, `An email was not accepted for delivery`, `code` | an SMTP send rejects; `code` is the sender's code or `UNEXPECTED` |

## Tests and CI

`apps/web/src/lib/adapters-email.test.ts` is new and runs in `pnpm test`;
no suite is added or changed in what it runs, so `tests/README.md` is
unchanged. `SecurityCompliance.md` and `SaaSOperations.md`: Not
applicable; their secret and logging rules already cover the SMTP
password and the new line, and no mail service is chosen.
