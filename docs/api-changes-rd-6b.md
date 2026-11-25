# API Changes — RD-6b

Mailpit in CI. **No migration, no route, no page, no setting and no
change to the product.**

## HTTP

No change.

## Internal API

No change.

## Tests and CI

| What | Where |
| --- | --- |
| `pnpm test:smtp`, the SMTP email sender against Mailpit | `vitest.smtp.config.ts`, `tests/email/*.smtp.test.ts` |
| `MAILPIT_TEST_SMTP_PORT`, `MAILPIT_TEST_API_PORT`: Mailpit's ports on this machine, for the suite alone | `tests/email/smtp.ts` |
| Mailpit `v1.33.1`, pinned by digest, in the `storage` job | `.github/workflows/ci.yml` |

The two variables are read by the suite, never by the apps.
