# ADR-0132 — Resetting a password with a link

Status: Accepted (AT-4b-2, 2026-11-10). Third part of the accounts-and-team
plan's AT-4, password reset, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`), with its defaults: the
link works once, for 1 hour; a reset ends every session of the account; the
page answers the same whether or not the account exists; MFA is still asked
at the next sign-in; requests and resets are audited.
Builds on: ADR-0128 (account links), ADR-0130 (an account's password is
written only with it), ADR-0131 (asking for a link, and a sign-in makes its
session only with the password it checked).

## Context

ADR-0131 lets a `PASSWORD_RESET` link be asked for and mailed, and makes a
sign-in lock the user's row `FOR SHARE` before it makes a session. Nothing uses
the link yet. This ADR uses it to replace the password. AT-4c adds the pages
and routes; until then nothing reaches any of it.

---

## Decision 1 — Which links work

`PasswordResetService.checkResetLink(token)` answers `USABLE` or `INVALID` and
writes nothing. A link is `INVALID` when the token is empty or longer than
ADR-0129's cap (128 characters), when no link has its hash, when the link is
not a `PASSWORD_RESET` link, when it was used, when its hour has ended (at
`expiresAt` it no longer works), when its account is not `ACTIVE` or no longer
has the address the link was sent to, or when the account has no password.
The reasons are not told apart.

## Decision 2 — Resetting

`PasswordResetService.resetPassword(token, password)` answers `RESET` or
`INVALID`:

- The link is checked first, as in Decision 1. An unusable link answers
  `INVALID` whatever the password.
- A password shorter than sign-up's minimum (`MIN_PASSWORD_LENGTH`, 10) is
  refused with `VALIDATION_FAILED` "Password is too short", and the link stays
  unused, so the person can try again.
- The new password is hashed before the transaction opens, so no lock is held
  while it hashes.
- `AccountLinkRepository.useForPasswordReset` then does the reset in one
  transaction (Decision 3). If the link or the account changed since the
  check, it writes nothing and the answer is `INVALID`.

A link opened several times at once resets once; every other attempt answers
`INVALID`.

## Decision 3 — The transaction

In one READ COMMITTED transaction:

1. Lock the user's row `FOR NO KEY UPDATE`. Go no further unless the account
   is `ACTIVE` and still has the link's address.
2. Read the password, and go no further if there is none. Nothing has been
   written yet.
3. Mark the link used, only while it is the user's unused `PASSWORD_RESET` link
   for that address and has not expired at that moment. Go no further if no
   link was marked.
4. Replace the password.
5. Delete every session of the account.
6. Delete the account's other unused `PASSWORD_RESET` links. The used link
   stays, with `usedAt`.
7. Write `user.password_reset`.

A failure at any step, the audit entry included, takes back every write.

The lock is the one ADR-0131 Decision 3 names, and its two orders both leave no
session made with the old password:

- **A reset holds the row first.** A sign-in's `FOR SHARE` waits, then reads
  the new password and makes nothing.
- **A sign-in holds the row first.** The reset waits for it to commit. Each
  later statement takes a new snapshot under READ COMMITTED, so step 5 deletes
  the session that sign-in made. Under REPEATABLE READ the snapshot would be
  taken before the wait and the session would survive, and a reset waiting
  for an email verification that updated the row would fail with a
  serialization error. So the level is set explicitly.

Two resets of one account, or a reset and an email verification, take the
same lock, so one waits for the other. Of two links of one account opened at
once, the first reset deletes the other link, and the second answers
`INVALID`.

Step 6 is this ADR's choice, which ADR-0131 left open: once a password has
been chosen, an older reset email left in the mailbox no longer works.

## Decision 4 — What a reset leaves as it is

- **MFA.** The authenticator and recovery codes stay. The next sign-in asks
  for a code, as the approved plan says. A reset proves the mailbox, not the
  device.
- **The address's verification.** `emailVerifiedAt` is not changed, and the
  account's verification links stay. Opening the link shows the person holds
  the mailbox, but verification keeps its own step and its own audit entry,
  so the two entries each mean one thing. An unverified account still sees
  only the verify page after signing in (ADR-0129).
- **Organizations and memberships.** Nothing else of the account changes.

## Decision 5 — The audit entry

`user.password_reset` names the user as actor (`actorUserId`), unlike the
request (ADR-0131 Decision 1). Opening a link sent to the account's own
address is the account holder's act. `organizationId` is null, the resource is
the user, and `metadata` is `{ linkId, email }`.

## Consequences

- **No migration**, no route, page or permission. One audit action is added,
  `user.password_reset`. Nothing reaches the service until AT-4c; a test pins
  that no application uses it.
- A reset signs the account out everywhere, including the browser that opened
  the link, if it was signed in.
- Someone who signed up with another person's address can be shut out by its
  owner with a reset (`docs/decisions/TODO.md`, "Take back an account someone
  else made with your address"). If that person set up MFA, the owner still
  cannot sign in. That needs the operator-assisted MFA recovery that ADR-0065
  left open; the TODO item stays open and says so.
- AT-4c's route must answer the same for every `INVALID` link, and only a
  usable link may show the password form.
