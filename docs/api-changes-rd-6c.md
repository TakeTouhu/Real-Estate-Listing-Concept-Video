# API Changes — RD-6c

The SMTP settings (ADR-0167). **No migration, no route, no page and no
dependency.** The schema checks the settings, and nothing uses them
yet; RD-6d gives the web app the SMTP sender.

## HTTP

No change.

## Environment

| Setting | Taken | Required |
| --- | --- | --- |
| `SMTP_HOST` | a DNS name, with no port and not an IP address | no; never beside `EMAIL_OUTBOX_DIR` |
| `SMTP_PORT` | plain digits, 1 to 65535 | with `SMTP_HOST`, and only with it |
| `SMTP_TLS` | `implicit` or `starttls` | with `SMTP_HOST`, and only with it |
| `SMTP_USER` | any text but empty | with `SMTP_HOST`, and only with it |
| `SMTP_PASSWORD` | any text but empty; a secret | with `SMTP_HOST`, and only with it |
| `SMTP_EHLO_NAME` | a DNS name, not an IP address | with `SMTP_HOST`, and only with it |
| `EMAIL_FROM` | one plain address in lower case, with no name | with `SMTP_HOST`, and only with it |
| `NODE_TLS_REJECT_UNAUTHORIZED` | anything but production; there, empty only | no |

## Internal API

| Change | Where |
| --- | --- |
| `serverEnvSchema` and `ServerEnv` gain the eight settings | `@app/shared` `env.ts` |
| New: `SMTP_SETTINGS`, `isNetworkPort`, `isDnsName`, `isSmtpTlsMode` | `@app/shared` `env.ts` |
| `isClamAvPort` returns `isNetworkPort` | `@app/shared` `env.ts` |
| New: `normalizeEmailAddress`, `isPlainEmailAddress` | `@app/shared` `email-address.ts` |
| `isDeliverableEmailAddress`, `EMAIL_ADDRESS_MAX_LENGTH`, `EMAIL_LOCAL_PART_MAX_LENGTH` defined here, re-exported unchanged by `@app/domain` | `@app/shared` `email-address.ts` |
| `normalizeEmail` returns `normalizeEmailAddress` | `@app/domain` `identity/util.ts` |
| `createSmtpEmailSender` judges its sender, certificate name and EHLO name by the shared rules, with the same messages; a certificate or EHLO name whose last label is a number, such as `127.1` or `0x7f000001`, is now refused too | `@app/storage/smtp` |
| `e2eEnvironment` refuses each SMTP setting | `tests/e2e/support/environment.ts` |

Unchanged: `EmailSender`, `outgoingEmail`, the mailer, the four flows
that send, readiness, the start check's adapter list and the worker.

## Tests and CI

No suite added or changed in what it runs; `tests/README.md` is
unchanged. `SecurityCompliance.md` and `SaaSOperations.md`: Not
applicable; their secret and logging rules already cover an SMTP
password, and no mail service is chosen.
