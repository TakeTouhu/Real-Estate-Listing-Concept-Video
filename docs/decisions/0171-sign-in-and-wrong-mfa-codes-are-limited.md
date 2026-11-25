# ADR-0171 — Sign-in and wrong MFA codes are limited

Status: Accepted (RD-7d, 2026-11-25). The fourth part of the seventh
milestone of production readiness, part 1, which the product owner
approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`). It adds the
limiter that hits one attempt's keys, moved here from RD-7c, and puts it
in front of the password and the MFA code at sign-in. RD-7e limits the
reset and verification emails.

Builds on: ADR-0169 (the rule; count first, give back only on success,
which Decision 7 narrows; a limiter that fails refuses), ADR-0170 (the
settings, the client address and the subjects), ADR-0054 Decision 5
(rate limiting with a growing cooldown), ADR-0065 Decision 8 (the five
wrong codes of one sign-in), ADR-0153 Decision 1 (limits a database
keeps for a query).

## Context

Anyone could try passwords without end, and anyone with the password
could sign in again for five more codes each time (`TODO.md`, "Decide
what MFA leaves open", item 4). The reports in
`/mnt/project-files/cto/rd-7/` settle how (`decision.md` there, and the
critic's §3 rows 4 to 7, 10, 11, 13, 15, 16 and 22). Every route here is a form
answered with a 303 to a page that shows `?error=` as text.

## Decision 1 — Sign-in is counted by two keys, before the lookup

- `POST /api/auth/login` hits the client address's key, when the request
  has one, then the typed address's key, normalized as sign-in looks it
  up, whether or not an account uses it. Both are hit before the account
  is looked up, so an address with an account is refused as one without.
- When the password is right, the address's key is forgotten and the
  client address's hit given back, whatever step comes next: an MFA
  code, MFA set-up or the verify page. The password is proven; the code
  has its own key.
- A wrong password keeps both hits. Only a success gives a hit back, or
  a later key's refusal (Decision 7).

## Decision 2 — Wrong codes are counted per user

`POST /api/auth/mfa` hits the sign-in's user's key before the code,
authenticator or recovery, is checked. An accepted code forgets it. A
refused attempt keeps the sign-in: no code is checked, so the sign-in's
own five (ADR-0065 Decision 8), which stays, is not counted.

## Decision 3 — The answer

A refusal answers as the route answers a failed attempt: a 303 to its
form with "Too many sign-in attempts. Try again in N minutes." or "Too
many wrong codes. Try again in N minutes.", N being the wait in whole
minutes, rounded up, at least 1 ("1 minute"). No 429 and no
`Retry-After` on a form: a 303 with one would only delay the message.

## Decision 4 — Not limited

- `POST /api/mfa/disable`: it needs a sign-in that passed MFA, whose
  fifth wrong code ends it, and a new one needs the limited code step.
- `POST /api/mfa/setup/confirm`: it checks a secret just shown.

## Decision 5 — Refusals are logged by code, not audited

One line at `warn` per refusal: `{ code: "RATE_LIMITED", action,
dimension }`, the action `SIGN_IN` or `MFA_CODE` and the dimension the
refusing policy's last word (`address`, `client` or `user`). A request
without a client address logs `{ code: "CLIENT_ADDRESS_UNAVAILABLE",
reason }` and keeps its other keys, unless the setting is not set. No
line, refusal or message names an address, an IP, a subject or a user.

## Decision 6 — The limiter's own database client

The limiter runs on a PrismaClient of its own, so a flood on one key
waits for its connections, never the web app's: at most 3 connections,
and `options=-c statement_timeout=1000`, a limit PostgreSQL keeps for
each statement, as ADR-0153 allows. Options the address already sends
are kept. Prisma's own waits to open a connection or get one from the
pool are unchanged; no limit is kept in application code.

## Decision 7 — One attempt's keys, hit in order

`RateLimiter.hit` hits the keys in the order given, the client
address's first. At the first refusal it gives back the earlier keys'
hits and hits no later key, so a refused attempt counts against no key
but the one that refused. This narrows ADR-0169 Decision 3, under which
only a success gives back: an attempt of several keys that one refuses
is no attempt for the others. Its answer is that key's wait, which it
names. The design said the longest wait answers (critic §4 and §6.1),
reading every key as hit; a later key is never hit here, so its wait is
not known, and the earlier keys allowed the attempt, so the refusing
key's wait is the longest the attempt was counted for. When every key
allows the attempt, each hit is returned for its success to give back.

## Decision 8 — A limiter that fails refuses, through the route

Any error of the limiter, a hit, a give-back or a forget, ends in the
route's own answer to an error, "Sign in failed" for a database's: on
the sign-in page, or on the code page with the sign-in kept. A session
made by a right password before a forget or give-back failed gets no
cookie, and ends unused; its `UserLoggedIn` audit row stays, and so do
the hits, but the address's when only the give-back failed. A code is accepted before its user's count is forgotten, so
when that forget fails the sign-in has already passed: the answer
names the error, the code page sends the person on, and the count
stays until its window ends.

## Considered and not done

- **Forgive any failure but a wrong password.** A later error code
  after a wrong password would make guessing free (critic W1).
- **Count wrong codes by the sign-in address's key.** A right password
  forgets it, so it never fills (critic W6).
- **A 429 with `Retry-After`.** A form would show the browser's page.
- **Answer the longest wait.** Decision 7.
- **Limit `disable` now.** Decision 4; with RD-8's first JSON route.
- **The web app's own client.** A hot key would hold its connections.

## What was measured

`limiter.test.ts` holds Decision 7 with a store that records each call.
`apps/web/src/lib/rate-limit.test.ts` rounds the minutes, builds each
key and checks every logged line repeats no address, IP, subject or
user. `tests/api/mfa-routes.test.ts` refuses the sixth sign-in for an
address with an account and one without, counts and gives back the
client address, forgets on success, refuses wrong codes across sign-ins
keeping the sign-in and its count, forgets on an accepted authenticator
or recovery code, and fails closed on a failed hit, forget or
give-back. `rate-limit.test.ts` also records the store's calls: the
client address first, nothing after a refusal, and the give-backs.
`rate-limit-store.db.test.ts` hits
over the limiter's own client and sees PostgreSQL end a statement after
a second.

## Consequences

- `@app/domain` exports `RateLimiter`, `RateLimitKey`, `RateLimitHit` and
  `RateLimiterDecision`; `@app/database` exports
  `statementLimitedDatabaseUrl` and `getRateLimitPrismaClient`.
- A sign-in costs up to four statements more; the limiter's 3
  connections count against the database's connection budget. Every
  sign-in and code shares them: a flood that holds all three makes the
  others wait for one, up to Prisma's pool wait (10 s by default), then
  fail closed. `TODO.md` records it.
- No migration, setting, page or dependency. A person can be held out
  by a stranger's wrong passwords; `TODO.md` records it.
