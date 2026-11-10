# API Changes — AT-4b-2

A password reset link replaces the password, once, and ends every session of
the account (ADR-0132). **No migration, route, page or permission; nothing in
either application uses it yet.**

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `PasswordResetService.checkResetLink(token)` | `"USABLE"` or `"INVALID"`; writes nothing |
| `PasswordResetService.resetPassword(token, password)` | `"RESET"` or `"INVALID"`. Raises `VALIDATION_FAILED` "Password is too short" for a usable link and a password under 10 characters, leaving the link unused |
| `ResetLinkState`, `ResetPasswordOutcome` | the two answers above |
| `MIN_PASSWORD_LENGTH` | `10`, shared by sign-up and reset (was internal to `AuthService`) |
| `UsePasswordResetLinkInput` | `{ linkId, userId, email, usedAt, passwordHash, audit }` |
| `AccountLinkRepository.useForPasswordReset(input)` | `"APPLIED"` or `"STALE"`: marks the link used, replaces the password, deletes every session and the other unused reset links, and audits, in one transaction; `STALE` writes nothing |
| `AuditAction.PasswordReset` | `user.password_reset`, with `organizationId` null, the user as actor and resource, and `metadata: { linkId, email }` |

### Added: `@app/database`

`accountLinks.useForPasswordReset` runs under READ COMMITTED, locks the user's
row `FOR NO KEY UPDATE` first, and writes as above.

### Changed: `@app/domain/testing`

The in-memory account links take the credentials and sessions, and a reset
writes all three with no `await` in between, taking every write back if the
audit entry fails. The in-memory sessions gain `removeAllOf(userId)`.
