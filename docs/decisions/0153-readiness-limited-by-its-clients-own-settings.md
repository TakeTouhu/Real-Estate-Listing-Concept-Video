# ADR-0153 — Readiness is limited by its clients' own settings

Status: Accepted (RD-2c, 2026-11-16). The third part of the second milestone
of production readiness, part 1, which the product owner approved on
2026-11-16 (`/mnt/project-files/cto/production-readiness-proposal.md`; gap
analysis `docs/production-readiness-gap-analysis.md`). RD-2b made readiness
ask the database and the storage (ADR-0152) and left how it is limited open.
RD-2d is to make readiness report a start that RD-2a could not check.

Builds on: ADR-0152 (what readiness asks, and the code a probe that did not
answer is logged by), ADR-0151 (a production start refuses the two
development storage adapters).

## Context

ADR-0152 Decision 2 left each probe with its client's limits alone. For the
database that client was the web app's one Prisma client, whose address sets
none: it gives up on opening a connection after 5 seconds and on waiting for
one after 10, and waits without limit for the answer to a query it has sent.
Measured there, a database that kept its connections and said nothing left
the request with no answer after 60 seconds.

Two ways were open (`docs/decisions/TODO.md`, "Open in RD-2b"): a one-shot
timer in the app's own code, which CLAUDE.md admits only by explicit CTO
authorization (ADR-0152 Decision 2), or limits the database client keeps
itself. This decision takes the second.

## Decision 1 — The database probe asks a client of its own, limited by its own settings

The web process makes a second Prisma client, which the readiness probe
alone uses (`getReadinessPrismaClient` in `packages/database/src/client.ts`).
It is built for the address in `DATABASE_URL`, with four of the address's
settings replaced and everything else it sets kept:

| Setting | Value | What it limits |
| --- | --- | --- |
| `connection_limit` | 1 | the connections the probe holds |
| `connect_timeout` | 3 seconds | opening a connection |
| `socket_timeout` | 3 seconds | waiting for a query's answer |
| `pool_timeout` | 4 seconds | waiting for the one connection |

The probe asks as before: the client connects, if it has not, and runs
`SELECT 1` (ADR-0152 Decisions 1 and 3).

Prisma's engine keeps these limits. Each ends one question, and none starts
or repeats anything: a deadline and not a cadence, which is how the scheduler
guard tells its one exception apart. The app's own code still holds no
timer, and Decision 3 widens the guard that says so.

The limits are on a client of the probe's own because an address limits
every query of its client. The web app's own queries are not to be cut off
after three seconds, nor run one at a time.

The wait for the connection is a second longer than the time to open one.
With the two equal, a connection that was taken and never answered was
reported as a pool with none to give (`P2024`); with the second more, as a
database that cannot be reached (`P1001`), which it is. A test in the
database suite holds that.

Measured on the development server (`next dev`) against PostgreSQL 16, with
every PostgreSQL process stopped (SIGSTOP), twice with the same result:

| The probe's query | Readiness |
| --- | --- |
| goes out on its connection, used just before | `503` after 3 seconds, `P2010` |
| finds its connection idle for 25 seconds | `503` after 4 seconds, `P2024`; the next request after 3, `P1001` |
| needs a new connection | `503` after 3 seconds, `P1001` |

`P2010` is Prisma's code for any raw query that failed; here the client gave
the query up after `socket_timeout`. The times leave out the 3 seconds the
development server takes to compile the route at its first request. In each
case readiness read `200` again at the first request after the processes
were resumed. A listener that takes a connection and says nothing reads as
the third row; before this change it read `503` after 5 seconds. The cases
that fail at once read as they did: a database that is stopped or refuses
the connection (`P1017`, `P1001`), a refused sign-in (`P1000`) and a
database that does not exist (`P1003`).

Readiness requests that arrive together take the probe's one connection in
turn, and one that waits four seconds for it reads `P2024`. Measured, five
requests at once to a frozen database read `503` after 3, 4, 4, 4 and 6
seconds: the first and the last by `P2010`, the three between by `P2024`.
Requests are not made to share one pending question: the limits already end
each of them, and a shared question that never ended would be every later
request's.

What the decision costs, and what it does not say:

- One more database connection for each web process, opened when readiness
  is first asked and kept. A process that had only been asked for readiness
  held one.
- Readiness says that the database answers, not that the web app's own
  client can ask it. An app whose own pool has no connection to give still
  reads `ready`.
- The web app's own client keeps Prisma's defaults. A request of its own
  whose query the database never answers waits as before; readiness no
  longer waits with it. Whether that client is to be limited is recorded in
  `docs/decisions/TODO.md`.
- With no `DATABASE_URL`, which a production start refuses (ADR-0151), the
  probe's client is a plain one, as before this change.

## Decision 2 — The storage probe is limited by its adapter

Readiness asks the chosen adapter whether one key holds an object, as before
(ADR-0152 Decision 1), with that adapter's limits alone. The two adapters
that exist set none, and neither asks over a network: the in-memory adapter
looks in a map, and the shared-folder adapter asks the file system. A
production start refuses both (ADR-0151).

A production storage adapter is to end its own `exists`. RD-3 adds the
first, for Google Cloud Storage. It is to decide how that question is
limited, within the rule on timers, and to measure it against a stand-in
that says nothing.

## Decision 3 — The scheduler guard reads every source tree

The guard in `packages/video-providers/src/fal/queue-status-dormancy.test.ts`
read five source trees of eleven (ADR-0152, Consequences). It now reads
every `apps/*/src` and `packages/*/src` there is, so a tree added later is
read too, and refuses in them:

- `setInterval` and `setTimeout`, as bare names, so that an alias is refused
  as a call is;
- `AbortSignal.timeout`;
- the word `timers`, which Node.js's `timers` and `timers/promises` modules
  are loaded by, with or without `node:`;
- `node-cron` and `cron.schedule`.

Its one exception is named by its path,
`packages/video-providers/src/http.ts`: the transport's deadline for one
request. The test also fails if that timer is no longer there.

The guard reads names in the text of sources that are not tests, comments
removed. It does not see a timer a dependency keeps, as Prisma keeps the
limits of Decision 1, nor a name put together when the code runs. It calls a
change to a reviewer's attention and proves nothing more.

## Consequences

- Changed: `packages/database/src/client.ts` and its test, the package's
  exports, `apps/web/src/lib/readiness.ts` and its test, and the scheduler
  guard's test. New:
  `tests/integration/readiness-database-limit.db.test.ts`, which holds the
  three limits against the installed Prisma and the suite's database: a
  wait for the one connection (`P2024`), a connection taken and never
  answered (`P1001`) and a query not answered in time (`P2010`).
- `GET /api/health/ready` answers `503` within 3 or 4 seconds in each case
  measured with a database that says nothing and one request at a time,
  where it could wait without end. Each step has its own limit, 3 seconds
  to open a connection, 4 to wait for it and 3 for the answer, so a probe
  that passed each just inside it could take 10. Whatever watches readiness
  still reads no answer within its own limit as not ready.
- The answer's shape, its checks and the log line are unchanged. No page,
  permission, migration or audit action changes.
- `docs/decisions/TODO.md`: the item "Open in RD-2b" is closed. Two are
  opened: how RD-3 limits the Google Cloud Storage adapter's `exists`, and
  whether the web app's own database client is to be limited.
