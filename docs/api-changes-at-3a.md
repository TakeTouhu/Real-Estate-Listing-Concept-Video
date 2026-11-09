# API Changes — AT-3a

Email verification links and the service that sends and checks them
(ADR-0128). **Migration 33. No route, page or permission; nothing in either
application uses them yet.**

## HTTP

No change. Sign-up still signs the person in at once; the verify page, the
link in the sign-up email and the guard arrive in AT-3b.

## Database (migration 33)

| Change | Shape |
| --- | --- |
| `users."emailVerifiedAt"` | `TIMESTAMP(3)`, nullable; null for every existing user |
| enum `AccountLinkPurpose` | `EMAIL_VERIFICATION`, `PASSWORD_RESET` |
| table `account_links` | `id`, `userId` (cascade on user delete), `purpose`, `tokenHash` (unique), `email`, `expiresAt`, `usedAt` (nullable), `createdAt`; index on (`userId`, `purpose`) |
| CHECK `account_links_tokenHash_check` | `tokenHash` is 64 lower-case hex characters |
| CHECK `account_links_window_check` | `expiresAt > createdAt`, and `usedAt` is null or not before `createdAt` |

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `EmailVerificationService` | `sendVerificationLink(userId)` → `"SENT"` or `"ALREADY_VERIFIED"`; raises `NOT_FOUND` "Account not found" for a missing or not `ACTIVE` account, `VALIDATION_FAILED` for an address mail cannot reach. `verifyEmail(token)` → `"VERIFIED"`, `"ALREADY_VERIFIED"` or `"INVALID"` |
| `EmailVerificationDeps` | the identity dependencies, plus `email: EmailSender` and `verificationUrl(token)`, which the application builds from its configured base URL |
| `SendVerificationOutcome`, `VerifyEmailOutcome` | the two answers above |
| `EMAIL_VERIFICATION_LINK_TTL_SECONDS` | `86400` (24 hours) |
| `emailVerificationMessage(to, url)` | the verification email, an `OutgoingEmail` of kind `EMAIL_VERIFICATION` |
| `AccountLink`, `AccountLinkPurpose` | a link as stored: `id`, `userId`, `purpose`, `tokenHash`, `email`, `createdAt`, `expiresAt`, `usedAt` |
| `AccountLinkRepository` | `create(link, audit)` keeps a link with its audit entry in one transaction; `findByTokenHash(hash)`; `useForEmailVerification({ linkId, userId, email, usedAt, audit })` → `"APPLIED"` or `"STALE"`, marking the link used, the address verified and writing `audit` in one transaction, or writing nothing |
| `AccountLinkAudit`, `UseEmailVerificationLinkInput` | their inputs |
| `IdentityRepositories.accountLinks` | the repository above |
| `AuditAction.EmailVerificationLinkCreated`, `AuditAction.EmailVerified` | `user.email_verification_link_created` (written with the link, before its email is handed over), `user.email_verified`; both with `organizationId` null, the user as actor and resource, and `metadata: { linkId, email }` |

### Changed: `@app/domain`

| Export | Change |
| --- | --- |
| `User` | adds `emailVerifiedAt: Date \| null` |
| `UserRepository.create` | takes no `emailVerifiedAt`; a new user is unverified |

### Added: `@app/database`

`createPrismaIdentityRepositories` returns `accountLinks`, backed by
`account_links`.
