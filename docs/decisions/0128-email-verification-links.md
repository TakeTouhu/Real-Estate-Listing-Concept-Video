# ADR-0128 — Email verification links

Status: Accepted (AT-3a, 2026-11-09). Third milestone of the
accounts-and-team plan the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`, default 2: an unverified
account can sign in but sees only the verify page; its link lasts 24 hours).
Implements the first half of ADR-0052 Decision 18's mandatory email
verification. Builds on: ADR-0126 (the email port), ADR-0059 (a change and
its audit entry in one repository transaction).

## Context

ADR-0052 Decision 18 makes email verification mandatory for the initial
release. Today sign-up signs the person in at once and nothing records whether
the address is theirs. AT-1 gave the product a way to send email; nothing
sends yet.

The plan's AT-3 is larger than one reviewable pull request, so it is split:

- **AT-3a (this ADR):** where verification is recorded, the link and its
  rules, and the service that sends and checks it. Dormant: no route, page or
  guard uses it.
- **AT-3b:** sign-up sends the link, the verify page, the guard that keeps an
  unverified account on that page, and the browser tests reading the outbox.

---

## Decision 1 — Where verification is recorded

`users.emailVerifiedAt` is when the person opened a verification link sent to
the account's address, or null. Every user existing at migration 33 reads as
unverified; no row is changed. Nothing checks the column until AT-3b. No
production deployment is recorded (ADR-0054's activation gates are open), so
only development and CI databases are known to hold users; AT-3b must confirm
that before its guard ships (`docs/decisions/TODO.md`).

## Decision 2 — A link is a table row holding only its token's hash

`account_links` holds the one-time links mailed to a user: what the link is
for (`EMAIL_VERIFICATION`, or `PASSWORD_RESET` from AT-4), the SHA-256 of its
token as hex, the address it was sent to, when it was made, when it expires
and when it was used. The token itself, 32 random bytes in base64url, exists
only in the email. Lookups are by hash, as for sessions.

The table refuses, by CHECK, a hash that is not 64 lower-case hex characters
(so a token as mailed can never be stored), a link that expires when or before
it is made, and a use before it was made. Deleting a user deletes its links.

## Decision 3 — Sending a link

`EmailVerificationService.sendVerificationLink(userId)`:

- refuses an account that does not exist or is not `ACTIVE` (`NOT_FOUND`);
- answers `ALREADY_VERIFIED`, making and sending nothing, when the address is
  verified;
- builds the email first, so an address mail cannot be sent to is refused
  (`VALIDATION_FAILED`) before anything is written;
- keeps the link with `user.email_verification_link_created` in one
  transaction, **then** sends the email. No email carries a link that was
  never recorded. If the email is not accepted, the link stays, unused;
  asking again makes a new one. The entry is named for what it records, a
  link made: written before the email is handed over, it cannot say the email
  was accepted.

Both audit entries name the link and the address they concern, in
`metadata: { linkId, email }`, so the audit trail still shows which address
was verified once the link itself is deleted.

Each request makes a new link valid for 24 hours. **An earlier link still
works** until it is used or expires: a person who asks twice and opens the
first email is not refused. Limiting how often a link may be asked for is rate
limiting, out of this plan's scope; the rate-limiting item in
`docs/decisions/TODO.md` now lists these sends.

The address in the link comes from a function the application supplies, built
from its own configured base URL (AT-3b), never from a request's `Host`
header, so a forged header cannot point the email elsewhere.

The email is plain text in English, like the product's screens: one line on
what the link does, the link, that it works once and expires in 24 hours, and
that it can be ignored by someone who did not create an account.

## Decision 4 — Opening a link

`verifyEmail(token)` answers one of three:

- `VERIFIED`: the link is the account's, for verification, unused, unexpired,
  and the account is `ACTIVE` and still has the address the link was sent to.
  One transaction marks the link used and sets `emailVerifiedAt`, both to the
  same moment, and writes `user.email_verified`.
- `ALREADY_VERIFIED`: the link is the account's and for the address the
  account has, and that address is verified already, whatever the link's own
  state. Opening a link again, or another link of the same account, writes
  nothing. This is asked before whether the link is used or expired, so that
  opening the link that verified the address says so rather than `INVALID`;
  the one thing it tells is that the address the link was mailed to is
  verified, which its recipient already knows or can find out by signing in.
- `INVALID`: anything else. An unknown token, a link of another purpose, a
  used or expired link, a link for an address the account no longer has, an
  account disabled or gone. The reason is not told apart, so an `INVALID`
  link reveals nothing about the account it names.

A link works until the last moment before 24 hours and not at 24 hours.

Opening a link needs no sign-in: the token is the proof. The person may open
the email on another device.

## Decision 5 — Concurrent opening

The transaction locks the user's row (`FOR NO KEY UPDATE`, the lock its own
update takes anyway) before it touches a link, and checks the account again
under that lock. A sign-in or a new link only references the row, so neither
waits for it. Opening one link several times at once, or two
links of the same account at once, verifies once: one `VERIFIED` and one
`user.email_verified`; the rest answer `ALREADY_VERIFIED`. Making a link
touches no existing link, so it and an opening never wait on each other in
opposite orders. A password reset (AT-4) must also take the user's lock first.

## Consequences

- The product can record a verified address and send and check the link, but
  **nothing uses it**: sign-up still signs the person in at once and no page
  or route asks for verification. A test pins that neither application uses
  the service.
- Used and expired links stay in the table. Deleting them needs a scheduled
  job, which stays blocked (ADR-0054 Decision 7); recorded in
  `docs/decisions/TODO.md`.
- A verification is bound to the address it was sent to. No product path
  changes a user's address today; if one is added, it must clear
  `emailVerifiedAt` (recorded in `docs/decisions/TODO.md`).
- Sign-up accepts today an email that mail cannot be sent to, which could
  then never be verified. AT-3b must refuse it at sign-up (recorded in
  `docs/decisions/TODO.md`).
- **Migration 33**: one enum, one column, one table with two CHECKs. No route,
  permission or page.
