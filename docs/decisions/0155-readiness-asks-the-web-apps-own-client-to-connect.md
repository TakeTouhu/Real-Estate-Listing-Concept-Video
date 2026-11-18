# ADR-0155 — Readiness asks the web app's own client to connect

Status: Accepted (RD-2e, 2026-11-17). The fifth and last part of the second
milestone of production readiness, part 1, which the product owner approved
on 2026-11-16 (`/mnt/project-files/cto/production-readiness-proposal.md`;
gap analysis `docs/production-readiness-gap-analysis.md`). It decides where
an address the web app's own database client cannot read is refused, which
ADR-0153 opened and ADR-0154 left to it.

Builds on: ADR-0152 (what readiness asks, and how it answers and logs),
ADR-0153 (the probe's own client and its limits, and the reading of the
rule on timers), ADR-0151 Decision 5 (the start hook loads no database
code).

## Context

The web app keeps two database clients in a process
(`packages/database/src/client.ts`). Its own reads `DATABASE_URL` as it is
written. The readiness probe's is given that address taken apart and put
together again, with four settings replaced (ADR-0153 Decision 1). Putting
it together again puts right addresses that Prisma refuses as written, so
readiness read `ready` while no request could ask the database.

Measured on bare clients of the installed Prisma (5.22.0), one fresh
process a case, in two or three runs with the same result: of 81 kinds of
address, 35 were answered through the limited address and not as written.

| As written | Kinds | The web app's own kind of client, asked to connect |
| --- | --- | --- |
| does not begin with `postgresql://` or `postgres://` exactly: the protocol in capitals, white space before it, or a tab or newline inside its word | 10 | refused with `P1012`, each time it is asked |
| the last value of `connection_limit`, `connect_timeout`, `socket_timeout` or `pool_timeout` is not a number Prisma reads: `10s`, `abc`, `1.5`, `-1`, empty, twenty digits | 24 | refused with `P1013`, each time it is asked |
| `socket_timeout=0` | 1 | connects; its queries then fail now and then |

The environment check passes each of the 35 (`z.string().url()`). A client
that reads `DATABASE_URL` and one given the same string connected or were
refused alike, with the same code, in all 223 rows, and no kind was found
that is answered as written and not as limited. A refusal took 9 to 22 ms
the first time and under 3 ms after. A query on such a client is refused
with no code at all: only being asked to connect names `P1012` or `P1013`.
Such a client is refused for the life of the process, also once the
variable has been put right.

## Decision 1 — The database probe asks the web app's own client to connect

After the probe's client has connected and answered `SELECT 1`, the probe
asks the web app's own client to connect: `await
getPrismaClient().$connect()` (`apps/web/src/lib/readiness.ts`). What that
throws is the probe's failure, as anything else it throws is.

The `database` check therefore reads `answers` when the database answered
the probe's client and the web app's own client has connected in this
process, and `does not answer` otherwise. The words, the answer's shape and
the log line are unchanged (ADR-0152 Decision 3): a warning with `probe:
"database"` and the code alone. The storage check already says `does not
answer` of an adapter that refuses to be built, a fault on the app's side
too. A check of its own, or a field naming which client failed, was weighed
and left: for these addresses the code says what to do.

| Code in the log | Read as |
| --- | --- |
| `P1012`, `P1013` | Prisma cannot read an address. The probe's client refuses some too (`mysql://`, `pgbouncer=maybe`). Correct `DATABASE_URL` and restart. `P1012` with an address that is right as written: see Decision 5 |
| `P1001`, `P2024`, `P2010` | the database could not be reached, or did not answer in time: the probe's client or, at its first connection, the web app's own (Decision 3) |
| `P1000`, `P1003`, `P1010`, `P2037` | the database refused the connection: sign-in, no such database, access, too many connections |

The probe asks to connect and sends no query through the web app's own
client: a query names no code for these addresses, waits behind a busy pool
and has no limit on its answer.

## Decision 2 — Asked last, and never beside the probe's client

The order is part of the decision, and `readiness.test.ts` holds it: the
web app's own client is neither made nor asked until the probe's client has
connected and been answered, and not at all when it has not.

- A database that says nothing ends the probe by the probe's own limits,
  as ADR-0153 measured, before the web app's own client, which keeps
  Prisma's defaults, is asked anything.
- At a process's first database connection Prisma's engine sets
  `SSL_CERT_FILE` and `SSL_CERT_DIR` from a thread of its own, and a client
  being made at that instant can be handed a damaged copy of the
  environment, or the process can die (`docs/decisions/TODO.md`, "Found
  after RD-2d"). Both names were there once the probe's client had
  connected, in each of 50,990 rounds that looked. Measured in fresh
  processes with neither name set at start: this order, 0 faulty in 6,000
  rounds that looked for a damaged copy, and no death in 3,000 that did
  not; both clients made one after the other and the first connected at
  once, 21 in 9,000 that looked, and 2 deaths in 3,000 that did not; the
  two asked to connect together, 10 in 3,000 that looked.

The change neither adds to that fault nor cures it. A first request of
another kind that makes the web app's own client within about 20 ms of the
first readiness request is exposed as before: 14 faulty in 15,000 rounds
with the change, 17 in 15,000 without. Setting the two names for the app's
own processes stays RD-10's.

## Decision 3 — No deadline is set; the last step waits by the web app's own client

Once the web app's own client has connected, asking it again returns at
once and asks the database nothing: in 0.1 ms or less, also with every
connection cut. Until then, each time it is asked it tries to open one
connection, by its own settings, and those that ask while it tries share
that one attempt and end with it: five readiness requests at once on the
development server left one connection for each client, and five asked at
once of a bare client given no answer all ended with the one attempt's
`P1001` after 5 s. No deadline is written in the repository's code
(ADR-0153 Decision 1), and the probe's 3 and 4 seconds do not limit this
step.

It is reached only when the database has just answered the probe's client.
Measured on bare clients, in an imitation of the probe, against a database
that answered the probe's client and accepted a new connection without
answering it:

| The address sets | The step ends with | After |
| --- | --- | --- |
| nothing of its own (Prisma's defaults) | `P1001` | 5.0 s |
| `connect_timeout=0` | `P2024` | 10.0 s |
| `connect_timeout=0` and `pool_timeout=0` | nothing | not ended at 40 s |

With both set to zero the imitated probe had not ended at 40 s, and a
later one was still waiting 15 s after the database answered new
connections again; an imitation of the probe without this change read
`ready` meanwhile. In another imitation, without the change, the app's own
first query waited in the same way (still waiting at 20 s, and a second
one 15 s after the database answered again), while the imitated probe read
`ready`. The development server was measured with the first two rows'
settings (What was measured).
ADR-0153's measured cases are unchanged: in each the probe's client fails
first. Its sentence that a probe "could take 10" seconds no longer gives
the most: by Prisma's defaults it is 15.

## Decision 4 — Not at start, and no rule of Prisma's is copied

The start check does not refuse such an address. The start hook loads no
database code (ADR-0151 Decision 5), `webStartProblems` must not throw, and
a rule written here would have to copy how Prisma reads an address. For
the four settings alone that is, as measured: the last of several values
counts, names are matched by case, a value is decoded as a form's is (a
`+` written is a space, `%2B` a plus), a plus before the number is read
and a minus is not, and a blank, an empty value and a number past 64 bits
are refused.
Samples could hold such a copy to one Prisma, and it would not see an own
client built from a damaged copy of the environment (Decision 5). Asking
the client itself sees both, with whatever Prisma is installed.

Giving the web app's own client the address put together again was not
taken either: it would change how the product's client reads its address,
and closes the first kind only.

## Decision 5 — What the check does not see, and what it newly shows

- It is the first connection that is asked for. A pool with nothing to
  give, or one whose connections have died, still reads `ready`, as do a
  `schema` that names nothing (every model query then fails with `P2021`)
  and a database that is not migrated.
- `socket_timeout=0` in the address is read by both clients. The probe's
  client replaces it; the web app's own connects and then fails queries now
  and then (`P2010`, `P1008`): 6, 8 and 7 raw queries of 50, and 26 and 28
  of 200, on a local connection. Readiness reads `ready`.
  `docs/decisions/TODO.md` records it.
- A server whose own client cannot read its address reads `503` at each
  readiness request until it is restarted with the address corrected.
  Readiness ends no process (ADR-0154 Decision 2).
- A client of the web app's own kind built from a damaged copy of the
  environment was seen, in one round of the measurements above (an
  imitation, not a server), to be refused again and again while the
  probe's client was answered. Its refusals there were queries, which name
  no code; asked to connect, a client made without `DATABASE_URL` names
  `P1012`. Without this change such a server would read `ready`; with it,
  it reads `503` with `P1012`, though its address is right as written,
  and a restart gives it a new client. No server was seen in that state.

## What was measured

On bare clients, as above. The reports, scripts and outputs are kept with
the plan's working files, outside the repository.

On the development server (`next dev`, the browser test's throwaway
settings), on the base (`main @ d777a30`) and at `c40df68`, twice each with
the same result. Each case is a fresh server; the first readiness request
also compiles the route, so its time is not compared.

| The case | Base | Change |
| --- | --- | --- |
| the address as written | `200`; one connection after the first readiness request | `200`; two |
| the protocol in capitals, a space before it, `pool_timeout=10s`, `connection_limit=abc` | `200`, nothing logged; a sign-in answered `Sign in failed` | `503` at each request, `P1012`, `P1012`, `P1013` and `P1013` logged; the sign-in as on the base |
| a sign-in first, then readiness | `200` | `200` |
| five readiness requests at once, first in the process | `200` each | `200` each |
| the database stopped (`SIGSTOP`) before readiness is first asked, then let go | `503` by `P1001`, the second in 3.0 to 3.1 s; then `200` | the same |
| the database stopped once ready, then let go | `503` by `P2010` in 3.0 to 3.1 s; then `200` | the same |
| the database answers the probe's connection and says nothing to a new one, then answers again | `200` | `503` by `P1001`, the second request in 5.0 to 5.1 s; then `200` |
| the same, with `connect_timeout=0` | `200` | `503` by `P2024`, the second in 10.0 to 10.1 s; then `200` |

In the last two a forwarder of the measurement's own stood between the
server and PostgreSQL. Readiness had been the first to use the database, so
the probe's client held the one connection that was answered.

`tests/integration/readiness-own-client-address.db.test.ts` holds, against
the installed Prisma and the suite's database, that the client
`getPrismaClient` makes is refused with `P1012` or `P1013` each time it is
asked to connect, for eight such addresses, and that the limited address of
each is answered.

## Consequences

- Changed: `apps/web/src/lib/readiness.ts` (one awaited call and its
  import), its test, a new test in the database suite, and comments in
  `apps/web/src/lib/health.ts`, `packages/database/src/client.ts` and the
  browser test.
- `GET /api/health/ready` answers `503`, and logs the code, where it
  answered `200`, whenever the web app's own client does not connect in
  this process: for an address of the first two kinds; for a first
  connection of that client that the database refuses or does not answer,
  though it answered the probe's (Decisions 1 and 3; with both
  `connect_timeout=0` and `pool_timeout=0` in the address such a request
  does not end); and for a client built from a damaged copy of the
  environment (Decision 5). The answer's shape is unchanged. No page,
  permission, migration or audit action changes.
- The web app's own client is made, and opens its first connection, when
  readiness is first asked and the database answers: a process that has
  only been asked for readiness holds two connections where it held one.
  Measured in bare Node.js processes against a local database, that first
  connection took 25 to 32 ms, and a first query then took 0.8 to 4.3 ms
  where it took 25 to 39.
- `docs/decisions/TODO.md`: the item on the address the web app's own
  client cannot read is closed. Four are amended: whether the web app's own
  client is limited, the readiness limit against what watches it, a
  request that fails for a reason the app does not know, and the two names
  for the app's own processes. Two are opened: on `socket_timeout=0`, and
  on a `.env` present where the client is generated.
- ADR-0153 is a record and is not rewritten. Two sentences under its
  Decision 1 ("What the decision costs, and what it does not say") no
  longer describe the code: that an app whose own client cannot read its
  address still reads `ready`, and, for that client's first connection,
  that readiness no longer waits with a request of the app's own. Its
  "could take 10" is corrected under Decision 3.
- RD-2 is complete in five parts for the web app. The worker's start is
  checked with its runtime, in part 2 (ADR-0151 Decision 4).
