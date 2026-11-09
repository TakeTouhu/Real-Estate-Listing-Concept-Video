# API Changes — AT-4a

An account is registered in one transaction (ADR-0130). **No migration,
route, page, permission or audit action.**

## HTTP

| Route | Change |
| --- | --- |
| `POST /api/auth/register` | A sign-up that loses a race for its email to another one answers as for any taken email: 303 to `/login?error=Email is already registered`, instead of `Registration failed`. Nothing else changes |

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `UserRepository.register(input)` | Writes the user, its password and `audit` in one transaction. `{ outcome: "CREATED", user }`, or `{ outcome: "EMAIL_TAKEN" }` having written nothing when another account has the email or takes it first. Any other failure is raised |
| `RegisterUserInput` | `user` (`id`, `email`, `name`, `status`), `passwordHash`, `audit` |
| `RegisterUserOutcome` | the two answers above |

### Removed: `@app/domain`

| Export | Why |
| --- | --- |
| `UserRepository.create` | replaced by `register`; no product code called it otherwise |
| `CredentialRepository.create` | a password is written only with its account |

### Changed: `@app/domain`

| Export | Change |
| --- | --- |
| `AuthService.register` | Writes through `UserRepository.register`. Still checks first whether the email is taken, so no password is hashed for a taken one, and answers `EMAIL_TAKEN` the same way: `VALIDATION_FAILED` "Email is already registered" |

### Changed: `@app/domain/testing`

The in-memory users write the user and its password with no `await` in
between, answer `EMAIL_TAKEN` for a taken email, refuse a taken identifier,
and take both back out when the audit entry cannot be appended.
