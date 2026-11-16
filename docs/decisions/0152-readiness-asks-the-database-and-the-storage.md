# ADR-0152 — Readiness asks the database and the storage

Status: Accepted (RD-2b, 2026-11-16). The second part of the second milestone
of production readiness, part 1, which the product owner approved on
2026-11-16 (`/mnt/project-files/cto/production-readiness-proposal.md`; gap
analysis `docs/production-readiness-gap-analysis.md`). RD-2a checked a
production start (ADR-0151). RD-2 is in parts for size: RD-2c is to propose
how readiness is limited, and a part after it is to make readiness report a
start that RD-2a could not check.

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

## Decision 2 — Readiness sets no time limit of its own in this change

A probe ends when its client answers or gives up. By default Prisma gives up
on a connection it cannot open after 5 seconds, and on waiting for one from
its pool after 10; a `DATABASE_URL` can change both. A query it has already
sent waits for the database, with no limit set.

So when Prisma has to open a connection, a database that is down, refuses
the sign-in or cannot be reached reads `503`, at once or after about 5
seconds. When it sends the query on a connection it holds, a database that
says nothing leaves the request waiting. That was measured with a frozen
database, below. A host lost without closing its connections is the same
case until the connection itself gives up, and was not measured.

Measured twice on the development server (`next dev`) against PostgreSQL 16,
with no time limit set in `DATABASE_URL` and every PostgreSQL process stopped
(SIGSTOP):

| The request's query | Readiness |
| --- | --- |
| goes out on a connection used just before | no answer after 60 seconds |
| finds its connection idle for 25 seconds | `503` after 10 seconds, `P2024` |
| waits for a pool of one (`connection_limit=1`), whose connection is in use | `503` after 10 seconds, `P2024` |
| needs a new connection | `503` after 5 seconds, `P1001` |

The second row reads as Prisma testing an idle connection before it uses it,
inside the pool's wait. The storage probe likewise has only its adapter's
limits, and neither the shared folder nor the in-memory adapter sets one.
Whatever asks for readiness must set a limit of its own and read no answer
as not ready.

A first version of this change gave a probe five seconds by
`AbortSignal.timeout`, a timer in the app's own code. CLAUDE.md admits none
without explicit CTO authorization: ADR-0054 Decision 7 records that
production code constructs none, and the guard in
`queue-status-dormancy.test.ts` names its one exception, the transport's
per-request deadline. That guard did not name `AbortSignal.timeout`, so the
first version passed it. This change adds no timer, and the guard now
refuses `AbortSignal.timeout` as it does `setTimeout`. RD-2c is to propose
how readiness is limited, as a decision of its own.

## Decision 3 — A probe that did not answer is logged by a code

The web app logs each probe that did not answer as a warning with the
component `readiness`, the probe's name and one code: the error's own code
when it is a single word of capitals, digits and underscores, as Prisma's
and the storage adapters' are (`P1001`, `CONFIGURATION_ERROR`,
`INTERNAL_ERROR`), and `UNEXPECTED` otherwise. The error's message is never
logged.

Prisma 5.22 gives a first connection that fails inside a query no code at
all. Asked to connect, it names the reason: `P1000` for a refused sign-in,
`P1001` for a database it cannot reach, `P1003` for one that does not exist.
So the probe asks it to connect before the query, which does nothing once
connected. A database lost after that fails the query itself, with `P1017`
or `P1001`, unless it says nothing (Decision 2).

A test in the database suite holds two of these against the installed
Prisma, for a database nothing listens for: no code inside a query, and
`P1001` when asked to connect. `P1000`, `P1003`, `P1017` and `P2024` were
read from a running app.

## Decision 4 — Liveness loads none of it

`apps/web/src/lib/health.ts` keeps the pure computation and now imports only
types. `apps/web/src/lib/readiness.ts` wires the real environment, provider,
database, storage and log. `GET /api/health` loads only the first, so a
database client or a storage package that fails to load cannot take liveness
down with readiness.

## Consequences

- New: `apps/web/src/lib/readiness.ts` and its test, the route's test
  `tests/api/health-ready-route.test.ts`,
  `tests/integration/readiness-database-code.db.test.ts` and
  `tests/e2e/readiness.spec.ts`. Changed: `apps/web/src/lib/health.ts` and
  its test, and the readiness route's import.
- Until readiness is limited, whatever watches it must set a limit of its
  own. The question is recorded in `docs/decisions/TODO.md`.
- The scheduler guard refuses `AbortSignal.timeout` in the sources it reads:
  the web app, the worker, and the database, storage and video-provider
  packages.
- A development machine with no database now reads `degraded` on readiness,
  where it read `ready`. Liveness, sign-in and every page are as before.
- The browser test reads readiness from its own PostgreSQL database and
  shared folder.
- No page, permission, migration or audit action changes.
- RD-3 is to add Google Cloud Storage as a storage adapter. Its `exists`
  would then be what readiness asks, with no change here.
