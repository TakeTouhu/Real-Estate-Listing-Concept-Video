# API Changes — AT-3b

Email verification is required (ADR-0129). **No migration, permission or
audit action.** Two routes and one page; sign-up, sign-in and the session gate
change.

## HTTP

### Added

| Route | Who | Does |
| --- | --- | --- |
| `GET /verify-email?token=…` | anyone | One button that posts the token. No button for a token that is empty, repeated or over 128 characters. `Referrer-Policy` `no-referrer` by meta tag |
| `GET /verify-email` | a sign-in whose address is not verified | The address, a button that sends the link again, sign-out. Any other sign-in is sent to its next page, no sign-in to `/login` |
| `GET /verify-email?notice=verified` / `invalid` | anyone | The link's outcome, with a link onward. A sign-in whose address is not verified sees `invalid` on its own page |
| `POST /api/auth/verify-email` (form `token`) | anyone; the token is the proof | `verifyEmail(token)`, then 303 to `/verify-email?notice=verified` (verified, now or before) or `?notice=invalid` (anything else) |
| `POST /api/auth/verify-email/resend` | a sign-in whose address is not verified | Mails a new link, then 303 to `/verify-email?notice=sent`, or `?notice=not-sent`. Another sign-in: 303 to its next page (`/` once verified); none: 303 to `/login` |

The verify page shows only the notices `sent`, `not-sent`, `invalid` and
`verified`, never text the address carries.

### Changed

| Route | Change |
| --- | --- |
| `POST /api/auth/register` | Refuses an address no email can reach: 303 to `/login?error=Enter an email address that can receive email`, nothing written. Otherwise mails a verification link and answers 303 to `/verify-email` (`?notice=not-sent` when the email was not sent; the account and the sign-in stay) instead of `/` |
| `POST /api/auth/login` | A sign-in whose address is not verified goes to `/verify-email`, after `/login/mfa` when it owes an MFA code |
| Every page and route that needs a user | A sign-in whose address is not verified is not signed in: pages send it to `/login`, which sends it to `/verify-email`; routes refuse it as they refuse no sign-in (the MFA routes answer 401) |
| `GET /login`, `GET /login/mfa`, `GET /security` | Send a sign-in whose address is not verified to `/verify-email` |

### Sequence

See ADR-0129, "Sequence".

## Configuration

| Setting | Shape |
| --- | --- |
| `APP_BASE_URL` (new, optional) | The web app's own address, which emailed links start with: an http(s) origin with no user, path, query or fragment; https when `NODE_ENV=production`. Unset, no link is emailed |
| `EMAIL_OUTBOX_DIR` (ADR-0126) | Now read by the web app: its emails are written there. Unset, no email is sent |

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `SignInStep` | `MfaSignInStep` or `"EMAIL_VERIFICATION_REQUIRED"` |
| `signInStep(deps, user, session)` | `CODE_REQUIRED` while an MFA code is owed; then `EMAIL_VERIFICATION_REQUIRED` while `user.emailVerifiedAt` is null; then `mfaSignInStep`'s answer |
| `ACCOUNT_LINK_TOKEN_MAX_LENGTH` | `128` |

### Changed: `@app/domain`

| Export | Change |
| --- | --- |
| `AuthService.register` | Refuses with `VALIDATION_FAILED` "Enter an email address that can receive email" an address `isDeliverableEmailAddress` refuses, before anything is written |
| `EmailVerificationService.verifyEmail` | Answers `INVALID` for a token over 128 characters without hashing or looking it up |

### Added: `@app/domain/testing`

`markEmailVerified(deps, userId)` marks an in-memory user's address verified,
for tests of what a verified account does.

### Added: web app (`apps/web/src/lib/email-verification.ts`)

`getEmailVerificationService()`, `sendVerificationLinkTo(userId)` (`SENT`,
`ALREADY_VERIFIED` or `NOT_SENT`, logging only the error code and the user's
id), `verificationUrl(baseUrl, token)`, `verifyEmailPage(requestUrl, notice?)`,
`VERIFY_EMAIL_NOTICES` and `verifyEmailNotice(param)`.
