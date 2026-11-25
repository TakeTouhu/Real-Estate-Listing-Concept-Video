# ADR-0169 — Abuse limits counted in PostgreSQL, on the request path

Status: Accepted (RD-7a, 2026-11-25). The first part of the seventh
milestone of production readiness, part 1, which the product owner
approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`). It settles
the rule every abuse limit follows and adds the store's port, an
in-memory store and the cases every store must pass. Nothing builds a
limiter yet: RD-7b adds the PostgreSQL store, RD-7c the settings and the
client address, RD-7d and RD-7e the routes.

Builds on: ADR-0054 Decision 5 (rate limiting, progressive cooldown,
separate from plan concurrency), ADR-0024 (no broker), ADR-0065
Decision 8 (the per-sign-in five wrong codes, which leaves the rest to
this limiter).

## Context

Nothing limits sign-in, password reset requests or verification emails,
and wrong MFA codes are limited only within one sign-in, which ADR-0065
Decision 8 ends at the fifth (`TODO.md`, "Add rate limiting as one
cross-cutting milestone"). The approved default is 5 failures per 15 minutes per
account and per IP, then a growing cooldown, and 3 reset or verification
emails per hour per address, as documented, configurable values.

Five reports in `/mnt/project-files/cto/rd-7/` (`code.md`, `store.md`,
`ip-and-http.md`, `ci-and-records.md`, `critic.md`) read the routes,
measured a counters table on PostgreSQL 16 and checked each other;
`decision.md` there records the choices. What this decision rests on:

- With "check, then record the failure", 50 of 50 wrong passwords sent at
  once reached the password check; with "count, then check", exactly 5
  did.
- One `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` per key lost no
  count: 200 hits over 90 connections ended at 200, 20 times of 20. A
  read-then-write control lost 198 of 200. A hit took about 0.8 ms at the
  median on a local database, 1.2 ms with Decision 6's pruning.
- Inside a caller's transaction a rollback took the count back, and at
  stricter isolation 19 of 20 simultaneous hits failed. Several keys in
  one statement deadlocked when two requests took them in opposite
  orders.
- Deleting two expired rows in each hit kept the table at the live set,
  18,001 rows, where it grew to 60,000 without.

## Decision 1 — One counter per policy and subject, in PostgreSQL

A policy names a limit: `limit` hits per `windowSeconds`, a cooldown base
and cap, and a decay. A subject is what is counted, such as an address
or a client address. Each (policy, subject) pair is one row of one table
in the application's database: no broker (ADR-0024), no timer and no
scheduled job. Every decision is made on the request that asks.

## Decision 2 — The rule

- A window starts at the first hit, or when a cooldown ends, and lasts
  `windowSeconds`; the first hit after it starts a new one.
- The hit after `limit` in a window is refused. With a cooldown base
  above 0 it starts a cooldown of `min(base * 2^(level - 1), cap)`
  seconds, the level one more than the last when the last cooldown ended
  less than `decaySeconds` ago, else 1. The next window starts when the
  cooldown ends.
- A hit during a cooldown is refused and changes nothing.
- With a base of 0 there is no cooldown, and the cap and decay are 0
  too: the subject waits for its window to end.
- A store works the cooldown out without overflowing at any level.
- A refusal says when to try again: the end of the cooldown, else the end
  of the window.

The cases in `packages/domain/src/testing/rate-limit-contract.ts` are
the rule: every store must pass them, and where this text and the cases
differ, the cases win and this ADR is amended by a new one.

## Decision 3 — Count first; give back only on success

Every attempt is a hit before the step it guards, so attempts made at
once cannot pass together. A success may give back the hit it made, or
forget the subject; nothing else gives anything back. Giving back takes
one hit from the window it was made in, never below 0, and never during
a cooldown or after a refusal. The operations are `hit`, `giveBack` and
`forget`; "consume" stays the word for a Unit.

## Decision 4 — One statement per hit, alone

The PostgreSQL store (RD-7b) runs each hit as one statement in its own
transaction at READ COMMITTED, never inside a caller's, one key at a
time. Its clock is the caller's, passed in, as sign-in already decides
when a session starts and ends by the application's clock.

## Decision 5 — The store sees no address

A subject is 64 lowercase hex characters, an HMAC computed by the caller
(RD-7c). The store refuses anything else, so no address or IP is kept in
the table.

## Decision 6 — Expired rows removed by later hits

A row says nothing once its window has ended and its level has decayed.
Each hit deletes up to two such rows of other keys (RD-7b), so the
table follows recent traffic without a sweeper.

## Decision 7 — A limiter that fails refuses

When the store cannot answer, the request is refused through the route's
own answer; it is never let through unlimited (RD-7d, RD-7e).

## Considered and not done

- **Redis or another broker.** ADR-0024 rejected one; a counter needs a
  row, not a queue.
- **A token bucket, GCRA or a sliding window.** None reads as "5 failures
  in 15 minutes, then a wait that grows"; their refusals depend on
  fractional refill and are harder to test exactly.
- **Check, then record.** Measured above: it lets every attempt in flight
  through.
- **The rule in TypeScript inside a locking transaction.** It holds the
  row's lock across several round trips; one statement does not.
- **An unlogged table, a sweeper, auditing refusals.** A restart would
  forget every cooldown; a sweeper is a scheduled job; refusals are logged
  by code (RD-7d).

## What was measured

`packages/domain/src/rate-limit/rate-limit.test.ts` runs the twenty-two
contract cases on the in-memory store, checks that a store allowing every
hit fails each case, and refuses policies out of range and subjects that
are not 64 lowercase hex characters, without repeating them. Each of 31
changes tried on the in-memory store failed at least one case: among
them `<` for `<=` at each boundary, a missing cap or decay, a
window after a cooldown opened at the next hit, a refusal that moves the
window, a give-back without its window, floor or after-refusal guard or
keyed by subject alone, a forget that keeps the cooldown, and the
system's clock read in place of the caller's.

## Consequences

- `@app/domain` exports `RateLimitPolicy`, `rateLimitPolicy`,
  `checkRateLimitPolicy`, `checkRateLimitSubject`, `RateLimitDecision`,
  `RateLimitStore` and the name and subject patterns; `@app/domain/testing`
  exports `InMemoryRateLimitStore` and the contract cases.
- No migration, route, page, setting or dependency.
