# ADR-0153 — Readiness is limited by its clients' own settings

Status: Accepted (RD-2c, 2026-11-16). The third part of the second milestone
of production readiness, part 1, which the product owner approved on
2026-11-16 (`/mnt/project-files/cto/production-readiness-proposal.md`; gap
analysis `docs/production-readiness-gap-analysis.md`). RD-2b made readiness
ask the database and the storage (ADR-0152) and left how it is limited open.
RD-2d is to make readiness report a start that RD-2a could not check.

Builds on: ADR-0152 (what readiness asks, and the code a probe that did not
answer is logged by), ADR-0151 (a production start refuses the two
development storage adapters), ADR-0054 Decision 7 (production scheduler
activation stays blocked).

## Context

ADR-0152 Decision 2 left each probe with its client's limits alone. For the
database that client was the web app's one Prisma client, which keeps
Prisma's defaults unless its address sets others: it gives up on opening a
connection after 5 seconds and on waiting for one after 10, and waits
without limit for the answer to a query it has sent. Measured there, a
database that kept its connections and said nothing left the request with
no answer after 60 seconds, when its query had gone out on a connection the
client held.

Two ways were open (`docs/decisions/TODO.md`, "Open in RD-2b"). One was a
one-shot timer in the repository's own code. CLAUDE.md lets no timer be
introduced without explicit CTO authorization, and ADR-0152 Decision 2 took
such a timer out again, none having been given. The other was limits the
database client keeps itself. This decision takes the second, and Decision 1
says how it reads the rule.

## Decision 1 — The database probe asks a client of its own, limited by its own settings

The web process makes a second Prisma client for the readiness probe
(`getReadinessPrismaClient` in `packages/database/src/client.ts`). The probe
is its one caller, and nothing but its name keeps another from it. It is
built for the address in `DATABASE_URL`, with four of the address's settings
replaced and everything else it sets kept:

| Setting | Value | What it limits |
| --- | --- | --- |
| `connection_limit` | 1 | the connections the probe holds |
| `connect_timeout` | 3 seconds | opening a connection |
| `socket_timeout` | 3 seconds | waiting for a query's answer |
| `pool_timeout` | 4 seconds | waiting for the one connection |

The probe asks as before: the client connects, if it has not, and runs
`SELECT 1` (ADR-0152 Decisions 1 and 3).

### How this reads the rule on timers

Prisma's engine keeps these limits, and they are timers: three deadlines in
a dependency. Every Prisma client keeps two of them by default, at 5 and 10
seconds; this change shortens them on the probe's client and switches on
the third. Each exists only while a question is pending and can do nothing
but end it, so it starts nothing and repeats nothing.

CLAUDE.md says: "No cron, timer, loop, production credential or paid call
may be introduced without it", the explicit CTO authorization that
ADR-0054 Decision 7 asks for production scheduler activation. The guard
refuses a timer by its name, and ADR-0152 Decision 2 held a one-shot timer
for the probe to the rule and took it out.

This decision reads the rule as being about timers the repository's own
code starts. Such a timer can be started with no question pending and runs
whatever is attached to it; a deadline and a schedule are written with the
same name, and only reading the code tells them apart. It reads the rule as
not reaching a deadline that a client keeps for its own question: nothing
is scheduled by one, and the web app's own database client keeps two by
default. The reading is this decision's own. No authorization under the
rule was asked or given for it. If the rule is to reach such limits, the
four settings come out again and readiness has no limit of its own, as
ADR-0152 left it. The sources the guard reads still hold one timer, the
transport's deadline (Decision 3), and this change adds none.

### Why a client of its own, and these four settings

The limits are on a client of the probe's own because an address limits
every query of its client. The web app's own queries are not to be cut off
after three seconds, nor run one at a time.

The wait for the connection is a second longer than the time to open one.
With the two equal, a connection that was taken and never answered was
reported as a pool with none to give (`P2024`); with the second more, as a
database that cannot be reached (`P1001`), which it is. A test in the
database suite holds that.

The address is taken apart and put together again, so what else it sets may
come out spelled otherwise: a socket's folder, `/var/run/postgresql`, as
`%2Fvar%2Frun%2Fpostgresql`, and `%20` as `+`. Measured, Prisma connected
through the socket's folder and gave the same `application_name` for the
address as written and as limited. An address that is not a URL is refused
with an error that carries no part of it. The web app does not come that
far with one: its environment check refuses such a `DATABASE_URL`.

### What was measured

On the development server (`next dev`) against PostgreSQL 16, each case
twice with the same result. With every PostgreSQL process stopped (SIGSTOP),
and one request at a time:

| The probe's query | Readiness |
| --- | --- |
| goes out on its connection, used just before | `503` after 3 seconds, `P2010` |
| finds its connection idle for 25 seconds | `503` after 4 seconds, `P2024`; the next request after 3, `P1001` |
| needs a new connection | `503` after 3 seconds, `P1001` |

`P2010` is Prisma's code for any raw query that failed; here the client gave
the query up after `socket_timeout`. In the third row the processes were
stopped before readiness had been asked, so the development server compiled
the route inside the first request: that one took 5.4 and 5.5 seconds, of
which the server's log gives 2.0 and 2.2 to the compile, and the request
after it took 3.0. In each case readiness read `200` again at the first
request after the processes were resumed.

The client keeps a connection on which it gave a query up, and asks the
next question on it: in the first row every later request read `P2010`
after 3 seconds too. It gives up a connection that fails a test, and the
times fit a client that tests, before it uses it, a connection it has not
tested for about 15 seconds. That is read off the measurements below and
the second row above, not from Prisma's documentation.

| The case | Readiness |
| --- | --- |
| Asked every 5 seconds for 40, then every PostgreSQL process stopped | `503` after 3 seconds (`P2010`) at the first request, after 4 (`P2024`) at the next, 8 seconds later, and after 3 (`P1001`) at each of four more |
| The server process of the probe's own connection stopped, the database answering every other client | `503` after 3 seconds (`P2010`) when asked at once and 8 or 9 seconds later; `200` after 3 seconds when asked at 16 or 17, on a new connection, and at once from then on |

In the second case readiness read `503` of a database that answered every
other client, for about 20 seconds, and then mended itself. The database
kept the silent connection, beside the new one, until its process ran
again: two connections for the probe, not one.

A listener that takes a connection and says nothing reads as the third row
of the first table; before this change it read `503` after 5 seconds. The
cases that fail at once read as they did: a database that is stopped or
refuses the connection (`P1017`, `P1001`), a refused sign-in (`P1000`) and
a database that does not exist (`P1003`).

### Requests that arrive together

Readiness requests that arrive together take the probe's one connection in
turn, and one that waits four seconds for it reads `P2024`. Measured, five
requests at once to a frozen database read `503` after 3, 4, 4, 4 and 6
seconds: the first and the last by `P2010`, the three between by `P2024`.

The same holds for a database that answers, only slowly. Measured on a bare
client with these settings and not through the web app, twice: of three
questions asked together, each answered 2.5 seconds after it was sent, two
were answered, after 2.5 and 5 seconds, and the third read `P2024` after 4.
A watcher that asks one question at a time does not meet either.

Requests are not made to share one pending question. An earlier form of
this change shared it, for both probes. It was taken out for three reasons:
the limits already end each question to the database; the storage probe has
no limit of its own (Decision 2), so a shared question that never ended
would have been every later request's; and the change was to stay near the
size a pull request is held to. Sharing would have spared the database
probe what the two paragraphs above describe, and `docs/decisions/TODO.md`
records it.

### What the decision costs, and what it does not say

- One more database connection for each web process, opened when readiness
  is first asked and kept. A process that had only been asked for readiness
  held one.
- One more Prisma engine in each web process. Measured three times in a
  bare Node.js process, not in the web app: the first client took 16.4 to
  16.5 MB of resident memory to connect and ask, and a second one 1.7 to
  2.0 MB more, with 22 to 23 ms to connect.
- Readiness says that the database answers, not that the web app's own
  client can ask it. An app whose own pool has no connection to give still
  reads `ready`.
- The web app's own client keeps Prisma's defaults. A request of its own
  whose query the database never answers waits as before; readiness no
  longer waits with it. Whether that client is to be limited is recorded in
  `docs/decisions/TODO.md`.
- Three seconds is chosen, not derived. It is under the 5 that Prisma gives
  by default to open a connection, which a readiness request waited before
  this change, and far over the 0.02 to 0.06 seconds a whole readiness
  request took where it was measured. What watches readiness in production,
  and with what limit of its own, is not known until part 2 of the plan
  (`docs/decisions/TODO.md`).
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

## Decision 3 — The scheduler guard reads every source tree, as text

The guard in `packages/video-providers/src/fal/queue-status-dormancy.test.ts`
read five source trees of eleven (ADR-0152, Consequences). It now reads
every `apps/*/src` and `packages/*/src` there is, so a tree added later is
read too. In each file there that ends in `.ts` or `.tsx` and is not a test,
it counts these names in the whole text:

- `setInterval` and `setTimeout`, as bare names, so that an alias is counted
  as a call is;
- `AbortSignal.timeout`;
- the word `timers`, which Node.js's `timers` and `timers/promises` modules
  are loaded by, with or without `node:`;
- `node-cron` and `cron.schedule`.

It allows one of them once: `setTimeout` in
`packages/video-providers/src/http.ts`, the transport's deadline for one
request. A second timer in that file fails the test, and so does that one
gone.

Comments are read with the rest, so no source there may name a timer even
in prose. A first form of this guard took comments out before it looked, and
with them whatever followed `//` or `/*` inside a string: a timer on a line
after an address was not seen.

What the guard does not see:

- a timer a dependency keeps, as Prisma keeps the limits of Decision 1;
- a name put together when the code runs or reached another way, as
  `AbortSignal["timeout"]` is;
- a loop or a wait that names no timer;
- a test, a file that is not `.ts` or `.tsx`, or one outside those trees:
  `apps/web/next.config.mjs`, the `tests` folder, the CI workflow.

It calls a change to a reviewer's attention and proves nothing more.

## Consequences

- Changed: `packages/database/src/client.ts` and its test, the package's
  exports, `apps/web/src/lib/readiness.ts` and its test, a comment in
  `apps/web/src/lib/health.ts`, and the scheduler guard's test. New:
  `tests/integration/readiness-database-limit.db.test.ts`, which holds the
  three limits against the installed Prisma, at one second where the web
  app gives three: against the suite's database, a wait for the one
  connection (`P2024`) and a query not answered in time (`P2010`, given up
  before the database answers it); against a listener of its own, a
  connection taken and never answered (`P1001`).
- `GET /api/health/ready` answers `503` within 3 or 4 seconds in each case
  measured with a database that says nothing and one request at a time,
  where it could wait without end. Each step has its own limit, 3 seconds
  to open a connection, 4 to wait for it and 3 for the answer, so a probe
  that passed each just inside it could take 10. Whatever watches readiness
  still reads no answer within its own limit as not ready.
- The answer's shape, its checks and the log line are unchanged. No page,
  permission, migration or audit action changes.
- `docs/decisions/TODO.md`: the item "Open in RD-2b" is closed. Three are
  opened: how RD-3 limits the Google Cloud Storage adapter's `exists`,
  whether the web app's own database client is to be limited, and what the
  readiness limit is to be once what watches readiness is known.
