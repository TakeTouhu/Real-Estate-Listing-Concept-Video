# ADR-0152 — Readiness asks the database and the storage

Status: Accepted (RD-2b, 2026-11-16). The second part of the second milestone
of production readiness, part 1, which the product owner approved on
2026-11-16 (`/mnt/project-files/cto/production-readiness-proposal.md`; gap
analysis `docs/production-readiness-gap-analysis.md`). RD-2a checked a
production start (ADR-0151). RD-2 is now in three parts for size: RD-2c makes
readiness report a start that RD-2a could not check.

Builds on: ADR-0065 Decision 17 (readiness reports whether the MFA key is
set), ADR-0150 (the web app's adapters chosen in one place).

## Context

On the base, `GET /api/health/ready` runs an offline self-check of the video
provider's adapter and reports whether the MFA key is set. It asks neither the
database nor the object storage, so a web app that can reach neither still
answers `ready`, and whatever sends it traffic learns of it from failed
requests.

## Decision 1 — Readiness asks the database and the storage to answer

`GET /api/health/ready` gains two checks:

- `database`: the web app's Prisma client connects, if it has not, and runs
  `SELECT 1`.
- `storage`: the chosen storage adapter is built and asked whether
  `readiness/probe`, a key nothing writes, holds an object.

Neither writes a row or an object, and the two are asked at the same time.
Each reports whether it answered, and the storage check names its adapter
(ADR-0150). Either failing makes the status `degraded` and the route's answer
`503`, as the provider and MFA checks do.

Readiness reports that a service did not answer and never what it threw: an
error can name a host, a user or a path. The route stays behind the
operator's token, which it checks before it asks anything.

## Decision 2 — A probe has five seconds

A probe that has not answered within 5 seconds counts as not answering, and
readiness answers without it. Whatever asks for readiness is itself timed, and
a probe that waits on a silent host would otherwise turn "not ready" into no
answer at all.

The limit is `AbortSignal.timeout`, the platform's one-shot deadline for one
request. The code schedules nothing itself: no `setTimeout`, no interval and
no loop. The repository's guard against schedulers
(`queue-status-dormancy.test.ts`) therefore stands as it is, with no new
exception, and nothing here can become a cadence (ADR-0054 Decision 7).

Five seconds is a starting value for a local network, not a measured one,
and no setting changes it. A probe that ran out of time is not cancelled: its
query ends by the client's own limits.

## Decision 3 — A probe that did not answer is logged by a code

The web app logs each probe that did not answer as a warning with the
component `readiness`, the probe's name and one code: the error's own code
when it is a single word of capitals, digits and underscores, as Prisma's,
Node.js's and the storage adapters' are (`P1001`, `ECONNREFUSED`,
`INTERNAL_ERROR`), `TIMEOUT` when the five seconds ran out, and `UNEXPECTED`
otherwise. The error's message is never logged.

Prisma 5.22 gives a first connection that fails inside a query no code at
all. Asked to connect, it names the reason: `P1000` for a refused sign-in,
`P1001` for a database it cannot reach, `P1003` for one that does not exist.
So the probe asks it to connect before the query, which does nothing once
connected. A database lost after that fails the query itself, with `P1017`
or `P1001`.

## Decision 4 — Liveness loads none of it

`apps/web/src/lib/health.ts` keeps the pure computation and now imports only
types. `apps/web/src/lib/readiness.ts` wires the real environment, provider,
database, storage and log. `GET /api/health` loads only the first, so a
database client or a storage package that fails to load cannot take liveness
down with readiness.

## Consequences

- New: `apps/web/src/lib/readiness.ts` and its test,
  `tests/e2e/readiness.spec.ts`. Changed: `apps/web/src/lib/health.ts` and the
  readiness route's import.
- A development machine with no database now reads `degraded` on readiness,
  where it read `ready`. Liveness, sign-in and every page are as before.
- The browser test reads readiness from its own PostgreSQL database and
  shared folder.
- No page, permission, migration or audit action changes.
- RD-3 adds Google Cloud Storage as a storage adapter. Its `exists` is then
  what readiness asks, with no change here.
