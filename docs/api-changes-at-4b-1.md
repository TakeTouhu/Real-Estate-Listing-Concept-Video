# API Changes — AT-4b-1

Password reset links can be asked for, and a sign-in makes its session only
with the password it checked (ADR-0131). **No migration, route, page or
permission; nothing in either application asks for a link yet.**

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `PasswordResetService` | `requestReset(address)` → `undefined` whatever happens: keeps a `PASSWORD_RESET` link with its audit entry and then mails it, for an `ACTIVE` account with that address; for any other address writes and sends nothing. Raises only when the link, its entry or the email fails |
| `PasswordResetDeps` | the identity dependencies, plus `email: EmailSender` and `resetUrl(token)`, which the application builds from its configured base URL |
| `PASSWORD_RESET_LINK_TTL_SECONDS` | `3600` (1 hour) |
| `passwordResetMessage(to, url)` | the reset email, an `OutgoingEmail` of kind `PASSWORD_RESET` |
| `AuditAction.PasswordResetLinkCreated` | `user.password_reset_link_created`, with `organizationId` and `actorUserId` null, the user as resource and `metadata: { linkId, email }` |

### Changed: `@app/domain`

| Export | Change |
| --- | --- |
| `SessionRepository.create(input, passwordHash)` | takes the hash the sign-in checked; makes the session only while the account's password is still that hash, and answers `null` otherwise |
| `AuthService.login` | answers `UNAUTHENTICATED` "Invalid email or password" when no session was made because the password was replaced meanwhile |

### Changed: `@app/database`

`sessions.create` locks the user's row `FOR SHARE`, compares the password and
inserts the session in one transaction.

### Changed: `@app/domain/testing`

The in-memory sessions compare the password before making a session, with no
`await` in between. `TestRepositories.credentials` is the in-memory
credential store, with `peek(userId)`.
