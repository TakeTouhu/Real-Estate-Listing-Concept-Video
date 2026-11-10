# ADR-0131 — Password reset links, and a sign-in with a replaced password

Status: Accepted (AT-4b-1, 2026-11-10). Second part of the accounts-and-team
plan's AT-4, password reset, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`), with its defaults: the
link works once, for 1 hour; a reset ends every session of the account; the
page answers the same whether or not the account exists; MFA is still asked
at the next sign-in; requests and resets are audited.
Builds on: ADR-0128 (account links), ADR-0129 (the verify page and its
token cap), ADR-0130 (an account's password is written only with it).

## Context

ADR-0052 Decision 18 requires password reset. ADR-0128 made the
`account_links` table with a `PASSWORD_RESET` purpose and left it unused.

A reset is to end every session of the account. A sign-in checks the password
and only then makes its session, outside any transaction. A reset that
committed between the two would leave behind a session made with the old
password, which someone holding the old password could keep for the
session's whole lifetime, by signing in again and again while the owner
resets.

AT-4 is split: AT-4b-1 (this ADR) lets a link be asked for and closes that
gap; AT-4b-2 uses the link to replace the password; AT-4c adds the pages and
routes. Until AT-4c, nothing reaches any of it.

---

## Decision 1 — Asking for a link

`PasswordResetService.requestReset(address)` takes an address, as typed, and
answers nothing, whatever happens to it:

- The address is normalized as at sign-in.
- An address mail cannot be sent to, one with no account, or one whose
  account is not `ACTIVE` writes nothing, sends nothing and audits nothing.
  Recording requests for unknown addresses would store whatever anyone types,
  for nobody.
- Otherwise it keeps a `PASSWORD_RESET` link, valid for 1 hour, with
  `user.password_reset_link_created` in one transaction (ADR-0128's
  `create`), **then** sends the email, as verification does. If the email is
  not accepted, the error is raised and the link stays, unused.

An unverified address is not refused: the link goes to the account's own
address, and opening it proves the person holds that mailbox.

The entry names **no actor** (`actorUserId` null): anyone may ask for a link
for any address, so the request is not the account owner's act. Its resource
is the user, and `metadata: { linkId, email }`, as for verification links.

Each request makes a new link; an earlier one is not withdrawn. What a reset
does to the others is AT-4b-2's decision.

The service is built with the application's own `resetUrl(token)`, from its
configured base URL, never from a request's headers (as ADR-0128 Decision 3).

## Decision 2 — The email

Plain text in English, like the product's screens: what the link does, the
link, that it works once and expires in 1 hour, that choosing a new password
signs the account out everywhere, and that it can be ignored by someone who
did not ask. Subject "Reset your password", kind `PASSWORD_RESET`.

## Decision 3 — A sign-in makes its session only with the password it checked

`SessionRepository.create(input, passwordHash)` takes the hash the sign-in
checked the password against. In one transaction it locks the user's row
`FOR SHARE`, reads the account's password, and makes the session only if the
hash is still the same; otherwise it makes nothing and answers `null`, which
the sign-in answers as any wrong password: "Invalid email or password".

A reset (AT-4b-2) is to lock the same row `FOR NO KEY UPDATE`, which
`FOR SHARE` conflicts with:

- a sign-in arriving while a reset holds the row waits for it, then reads the
  new password and makes nothing;
- a reset arriving while a sign-in holds the row waits for it, then ends the
  session that sign-in made.

Either way no session made with the old password survives a reset.

The transaction is pinned to READ COMMITTED, and the password is read by a
statement of its own after the lock, so that statement's snapshot holds a
reset that committed while the sign-in waited. Under REPEATABLE READ, or with
the password joined into the locking statement, it would still read the old
password.

This changes one sentence of ADR-0128 Decision 5: a sign-in no longer only
references the user's row, so it now waits, briefly, for an email
verification committing on the same account. A new link still does not.

## Consequences

- A link can be asked for and is kept and mailed, but **nothing asks for one
  yet**: no page or route uses the service until AT-4c. A test pins that no
  application uses it.
- `requestReset` takes longer for an address with an account, which writes a
  link and sends mail, than for one without. The answer is the same, but its
  timing can tell them apart. Asking is to be rate limited with the rest of
  `/api/auth/*`, which the rate-limiting item in `docs/decisions/TODO.md`
  already lists ("password reset").
- Any failure after the account is found (keeping the link or its entry, or
  the mail service refusing the email) raises an error that an address with
  no account never raises. AT-4c's route must answer the same whatever the
  error.
- Every sign-in now takes a short transaction and a row lock on its user.
- **No migration**, no route, page or permission. One audit action is added,
  `user.password_reset_link_created`.
