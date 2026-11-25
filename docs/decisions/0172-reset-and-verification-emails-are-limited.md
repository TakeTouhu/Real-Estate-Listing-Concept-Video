# ADR-0172 — Reset and verification emails are limited

Status: Accepted (RD-7e, 2026-11-25). The fifth and last part of the
seventh milestone of production readiness, part 1, which the product
owner approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`). It puts the
limiter of ADR-0171 in front of the reset and verification emails, lets
a completed reset clear a held sign-in, and makes sign-in hash a password
for an address without an account. RD-7 is complete.

Builds on: ADR-0169 (the rule; a limiter that fails refuses), ADR-0170
(the settings, the client address and the subjects), ADR-0171 (the
limiter, its keys in order, refusals logged by code), ADR-0129 (sign-up
mails a link; the verify page), ADR-0131 and ADR-0133 (the reset
request's answer). Supersedes ADR-0133 Decision 2 for a refused request
only.

## Context

Anyone could ask for reset links to any address, and an unverified
account could ask for verification links, without end, each one an
email (`TODO.md`, "Add rate limiting as one cross-cutting milestone").
The approved default is 3 emails per hour per address. The reports in
`/mnt/project-files/cto/rd-7/` settle how (`decision.md` there, choice
9, and the critic's §3 rows 8, 9, 12, 14, 15 and 23, and §6.1).

## Decision 1 — A reset request is counted by two keys, before any lookup

`POST /api/auth/reset-password/request` hits the client address's key,
when the request has one (20 an hour by default), then the typed
address's key, normalized, whether or not an account uses it (3 an
hour). Both are hit before the address is looked up. A request the
limits let through counts against both keys, and no success gives a hit
back. A request the typed address's key refuses counts against neither:
the limiter gives back the client address's hit (ADR-0171 Decision 7),
so the client address's 20 are requests its address keys let through.

## Decision 2 — A refused request says when to try again

A refused request answers 303 to
`/reset-password?notice=limited&retry=N`, N the wait in whole minutes,
rounded up, at least 1, whichever key refused it, the same for every
address. The page shows "Too many reset requests. Try again in N
minutes."; with `retry` missing or not a whole number from 1 to 99,999,
"Try again later." This supersedes ADR-0133 Decision 2's "whatever
happened" for this case alone, as the approved "every refusal says when
to try again" asks; every other request still answers `sent`. A refusal
tells that the address was asked about often, not whether it has an
account, and it returns before the lookup.

## Decision 3 — Verification emails are counted per stored address

Each verification email, the resend's and sign-up's own, hits the key of
the account's stored address before it is sent (3 an hour); there is no
client-address key (critic W10). A refused resend answers
`/verify-email?notice=limited&retry=N`: "Too many verification emails.
Try again in N minutes." A refused sign-up email keeps the account and
its sign-in and sends nothing; sign-up answers the verify page with the
same notice, from which the person asks again later. The design left
sign-up's refusal open. No path reaches it today: no account is deleted
or changes its address, so a new account's address has had no
verification email; the choice is for a later path that does.

## Decision 4 — A completed reset forgets the address's sign-in key

The link proves the mailbox, and the reset already ends every session.
`PasswordResetService.resetPasswordReturningAddress` answers the address
the link was sent to, and the route forgets that address's
`sign-in.address` key: a person held out by a stranger's wrong passwords
can sign in at once with the new password. The client-address key is
left as it is. When the forget fails, the password is still changed and
the answer is still `reset`; the failure is logged by its code, and the
count stays until its window or cooldown ends.

## Decision 5 — Sign-in hashes for an address without an account

`AuthService.login` checks the password against
`PLACEHOLDER_PASSWORD_HASH`, a scrypt hash of a random password nobody
kept, when the address has no account or the account no password, so it
does the same scrypt work either way, as its comment said it did. An
account that is not active is now checked against its own hash too,
which it was not before; its answer is unchanged. This makes the code
match its comment. It does not close enumeration: sign-up
still says "Email is already registered", a reset for an address with
an account still takes longer (`TODO.md`), and sign-in still reads an
account's password row, one indexed lookup more.

## Decision 6 — A limiter that fails sends nothing

A reset request whose limiter fails answers `sent`, as any other error
does (ADR-0133 Decision 2), and sends nothing. A resend whose limiter
fails answers `not-sent`, and sign-up's keeps the account and answers
`not-sent` too. Each failure is logged by its code alone, under the
component's own name: "A password reset request could not be counted" or
"A verification email could not be counted", with no address or user.
Refusals are logged as ADR-0171 Decision 5 says, with the action
`PASSWORD_RESET_EMAIL` or `VERIFICATION_EMAIL`.

## Considered and not done

- **The same `sent` for a refused request.** A person would wait for an
  email that never comes, with no reason given.
- **"Too many requests for this address."** The client address may be
  what refused it.
- **A client-address key on resends.** Each account mails only its own
  address, already limited; many accounts is sign-up's case, RD-8's.
- **Forgetting the client address's key on a reset.** The reset proves
  a mailbox, not a network.

## What was measured

`tests/api/password-reset-routes.test.ts` refuses the fourth request in
an hour for an address with an account and one without, typed in
another case, with the minutes left, and lets the hour's end through;
refuses the 21st from one client address, whatever the address; answers
`sent` and mails nothing when the limiter fails; lets a held address
sign in after a reset; and still answers `reset` when the forget fails.
`tests/api/email-verification-routes.test.ts` counts sign-up's email,
refuses the fourth with its wait, keeps the account when sign-up's email
is refused, and answers `not-sent`, mailing nothing, when the limiter
fails. The pages' tests show the wait only for a whole number of
minutes. `rate-limit.test.ts` records the store's calls: a reset
request's client address first, its hit given back when the typed
address refuses, nothing after the client address refuses.
`password-reset.test.ts` and `email-verification.test.ts` check that
each failure line holds the code and no address, user or link.
`identity.test.ts` sees the placeholder checked for an unknown
address. Timed over the in-memory repositories with the scrypt hasher,
the median of 40 wrong-password sign-ins was 40 to 45 ms for an address
with an account and one without; on the base, 43 ms against 0.01 ms.
A test failed for each change that undid a part: no forget after a
reset, no client-address key, no placeholder, sign-up's email not
counted, a refusal ignored, or an email sent, or `limited` answered,
when the limiter fails.

## Consequences

- `@app/domain` exports `PLACEHOLDER_PASSWORD_HASH`, and
  `PasswordResetService` gains `resetPasswordReturningAddress`;
  `resetPassword` is unchanged.
- On the limiter's own client, a reset request costs up to three
  statements more (two hits and a give-back), a verification email one
  and a completed reset one.
- No migration, setting or dependency. `RATE_LIMIT_PASSWORD_RESET_EMAIL`,
  `RATE_LIMIT_PASSWORD_RESET_EMAIL_PER_IP` and
  `RATE_LIMIT_VERIFICATION_EMAIL` now take effect.
- The invitation limit waits for RD-8, so no deployment is to set
  `SMTP_HOST` yet (`TODO.md`).
