# ADR-0130 — An account is registered in one transaction

Status: Accepted (AT-4a, 2026-11-10). First part of the accounts-and-team
plan's AT-4, password reset, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`). Closes the open item
*Register an account in one transaction* in `docs/decisions/TODO.md`.
Builds on: ADR-0059 and ADR-0127 (a change and its audit entry in one
repository transaction), ADR-0129 (sign-up).

## Context

Sign-up (`POST /api/auth/register`, reachable today) wrote the user, its
password and `user.registered` in three steps. A crash or a failed write
between them left one of two states:

- an account with no password, which no one can sign in to and whose email
  can never be registered again;
- an account created with no audit entry.

The same steps read whether the email was taken, then wrote. Two sign-ups for
one email at once both passed the read, and the second failed on the email's
unique key with "Registration failed".

Password reset writes passwords too, so this is closed before it.

---

## Decision 1 — One repository call writes all three

`UserRepository.register` writes the user, its password and
`user.registered` in one database transaction. All three are written, or none
is, whichever write fails.

The service still decides everything: the normalized email, the name, the
identifier, the password's hash and the audit entry's content, which is as
before (`metadata: { email }`). The user starts `ACTIVE`, with its email not
verified, as before. The password is hashed before the transaction opens, so
the transaction holds no lock while it is hashed.

`UserRepository.create` and `CredentialRepository.create` are removed: no
product code wrote a user or a password any other way, and a test pins that
only the registration transaction creates either.

## Decision 2 — An email taken meanwhile is refused as taken

When the email's unique key refuses the user, because another sign-up
committed that email first, the whole registration rolls back and the
repository answers `EMAIL_TAKEN`. It recognizes this from the error itself:
a unique conflict on the user's `email`. Any other failure, a taken
identifier included, is raised as it was.

The service answers `EMAIL_TAKEN` as it answers an email it finds taken
before hashing: `VALIDATION_FAILED` "Email is already registered". Of several
sign-ups for one email at once, one is made and the others are told the email
is taken.

## Consequences

- No account is made without its password or without its `user.registered`
  entry. Accounts made before AT-4a are not checked or repaired.
- The route, the page and the success path are unchanged; a sign-up that loses
  a race for its email now sees "Email is already registered" instead of
  "Registration failed".
- **No migration**, no new route, permission, page or audit action.
