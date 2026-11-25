# API Changes — RD-7e

Reset and verification emails are limited (ADR-0172). **No migration, no
setting and no dependency.** RD-7 is complete.

## HTTP

| Route | Change |
| --- | --- |
| `POST /api/auth/reset-password/request` | Counted per client address, when the request has one, then per typed address, whether or not an account uses it, before any lookup. The fourth request for an address within the hour, or the 21st from a client address that its address keys let through, by default, answers 303 to `/reset-password?notice=limited&retry=N` and sends nothing, the same for every address. Otherwise `notice=sent`, as before. A limiter error answers `notice=sent` and sends nothing. |
| `POST /api/auth/verify-email/resend` | Counted per the account's address before the email. The fourth within the hour, sign-up's included, answers 303 to `/verify-email?notice=limited&retry=N` and sends nothing. A limiter error answers `notice=not-sent`. |
| `POST /api/auth/register` | Sign-up's verification email is counted the same way. A refused one keeps the account and the sign-in, sends nothing and answers `/verify-email?notice=limited&retry=N`; a limiter error answers `notice=not-sent`. |
| `POST /api/auth/reset-password` | A completed reset forgets the address's failed sign-ins, so the new password signs in at once. A failure to forget still answers `notice=reset`. |
| `POST /api/auth/login` | An address with no account, or none with a password, is checked against a placeholder hash, so the answer costs the same scrypt work; an account that is not active is now checked against its own hash. The answers are unchanged. |

N is the wait in whole minutes, rounded up, at least 1.

## Pages

| Page | Change |
| --- | --- |
| `/reset-password` | New notice `limited`: "Too many reset requests. Try again in N minutes." with `retry=N` a whole number from 1 to 99,999; "Try again later." otherwise. |
| `/verify-email` | New notice `limited`: "Too many verification emails. Try again in N minutes.", read the same way. |

## Environment

No new setting. `RATE_LIMIT_PASSWORD_RESET_EMAIL`,
`RATE_LIMIT_PASSWORD_RESET_EMAIL_PER_IP` and
`RATE_LIMIT_VERIFICATION_EMAIL` (ADR-0170) now take effect.

## Internal API

| Change | Where |
| --- | --- |
| New export: `PLACEHOLDER_PASSWORD_HASH` | `@app/domain` `identity/auth-service.ts` |
| New: `PasswordResetService.resetPasswordReturningAddress(token, password)`; `resetPassword` unchanged | `@app/domain` `identity/password-reset-service.ts` |
| New: `WebRateLimits.passwordResetEmail`, `verificationEmail`, `forgetSignInAddress`; `LimitedEmail`, `refusalText`, `retryMinutes`; two more `RateLimitedAction` values | `apps/web/src/lib/rate-limit.ts` |
| New: `askForLimitedResetLink`, `resetPasswordNoticeText`; `resetPasswordPage` takes the wait | `apps/web/src/lib/password-reset.ts` |
| New: `sendLimitedVerificationLinkTo`, `verifyEmailNoticeText`, `LimitedSend`; `verifyEmailPage` takes the wait | `apps/web/src/lib/email-verification.ts` |

## Logs

`warn` `{ code: "RATE_LIMITED", action: "PASSWORD_RESET_EMAIL" |
"VERIFICATION_EMAIL", dimension: "address" | "client" }` per refusal.
`error` `{ code }` for "A password reset request could not be counted",
"A verification email could not be counted" and "A reset could not
forget the address's failed sign-ins". None names an address, an IP, a
subject or a user. Refusals are not audited.

## Tests and CI

No suite added. `apps/web/src/lib/password-reset.test.ts` replaces
`@/lib/rate-limit`'s limiter with one on the in-memory store, as the
four route test files do.
