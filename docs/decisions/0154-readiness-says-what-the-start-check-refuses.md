# ADR-0154 — Readiness says what the start check refuses

Status: Accepted (RD-2d, 2026-11-17). The fourth part of the second
milestone of production readiness, part 1, which the product owner approved
on 2026-11-16 (`/mnt/project-files/cto/production-readiness-proposal.md`;
gap analysis `docs/production-readiness-gap-analysis.md`). RD-2d was to do
two things (ADR-0153): make readiness report a start that RD-2a could not
check, and decide where an address the web app's own database client cannot
read is refused. They are two decisions, and each earlier part of RD-2 grew
past the size a pull request is held to, so RD-2d does the first and RD-2e
is to do the second.

Builds on: ADR-0151 (a production start is checked once, and what it is
refused for), ADR-0152 (what readiness asks, and how it answers and logs),
ADR-0150 Decision 2 (neither `NODE_ENV` vouches for the other).

## Context

ADR-0151 checks a production start of the web app in the hook Next.js runs
as its server starts, and ends a start it refuses. Next.js 15.5 does not run
that hook while `NEXT_PHASE` is `phase-production-build`, the value it sets
for its own build. A server started with that value in its environment is
therefore not checked, and serves (ADR-0151 Decision 1). Nothing said that
such a start would have been refused, or why.

Measured on the base (`main @ 01e7f41`), twice with the same result: real
starts of a fresh production build (`next start`), each with that value set
and nothing else in its environment but its own settings.

| The start | Liveness | Readiness |
| --- | --- | --- |
| `NODE_ENV=production`, every setting set | `200` | `503`: the storage check |
| the same without `MFA_SECRET_KEY` and `APP_BASE_URL` | `200` | `503`: the storage check and the MFA check |
| `NODE_ENV=development`, with the two development folders | `200` | `503`: the storage check |
| an environment that fails its schema | `200` | `500` |

So readiness read not ready in each. In the first three it did so by the
storage check alone, or with the MFA check, where the start check has three
to five reasons, and only because neither storage adapter that exists can be
built in production (ADR-0008, ADR-0085, ADR-0150): the probe builds the
adapter, and it refuses. RD-3 adds a storage adapter production may use.
With that one the storage check can pass, and readiness could then read
`ready` in a start the check refuses: for its scanner or its email adapter
until RD-5 and RD-6, because `APP_BASE_URL` is not set, or because only one
of the build and `NODE_ENV` says production.

## Decision 1 — Readiness reads the start check's own judgment

What `checkWebStart` judged moves, unchanged, into `webStartProblems`
(`apps/web/src/lib/startup.ts`): whether a start is a production one, and
the lines it is refused for. `checkWebStart` reports those lines and ends
the process, as before, and an environment that fails its schema stays a
case of its own there.

Readiness gains a fifth check, `start`, after the other four, from the same
function:

| The start check | `ok` | `detail` |
| --- | --- | --- |
| refuses nothing, also because the start is not a production one | `true` | `nothing refused` |
| refuses the start | `false` | its lines, in its order, joined by `; ` |

A start the check refuses is therefore not ready whether or not the check
saw it, and the answer gives the reasons in the words the check writes to
standard error. One function judges for both. `startup.test.ts` holds the
start check to reporting exactly that function's lines, in six starts.

The lines name ports, adapters and settings, and no setting's value
(ADR-0151 Decision 1). Readiness answers only to the operator's token, as
before.

Readiness does not know whether the hook ran. It asks what the check
refuses, of the environment and the build it runs in. A start the check saw
and let go on reads `nothing refused`; one it saw and refused has ended, and
is asked nothing.

## Decision 2 — The reasons are logged, and the server is not ended

When the `start` check is not `ok`, readiness logs a warning each time it
is asked, as it does for a probe that did not answer (ADR-0152 Decision 3):
the message `The start check refuses this start`, the component
`readiness`, and the lines as `problems`. A server that is kept from
requests because it is not ready may be within reach by its log alone. The
start check itself wrote nothing there, having ended nothing. Readiness
answers whether or not the log could be written.

Readiness does not end the process. Ending it there would add nothing: a
deployment that asks readiness keeps requests from such a server already,
and one that does not ask would not have it ended either. So a start the
check did not see still serves whoever reaches it, as on the base: each
development adapter refuses production when it is first built.

Making the hook run was not tried. The skip is Next.js's own, and it has no
setting. Taking `NEXT_PHASE` out before Next.js reads it would have to
happen where the server is started, which RD-10 settles with the container
image; `docs/decisions/TODO.md` records it.

## Decision 3 — What readiness still cannot say

An environment that fails its schema cannot be read at all, and readiness
reads the operator's token from it before it answers anyone. Such a start,
when the check did not see it, answers readiness with `500` and liveness
with `200`, as on the base; the schema's message, which names each invalid
setting, is in the server's output. A `500` is not ready to whatever
watches, and the check ends such a start when it sees it (ADR-0151
Decision 1).

## What was measured

At `69442b3`, twice with the same result. Real starts of a fresh production
build, as in the context above; the first row is a start without
`NEXT_PHASE`, which the check sees.

| The start | What happened |
| --- | --- |
| seen: `NODE_ENV=production`, every setting set | ended with exit code 1 and three lines on standard error, as before |
| not seen, the same settings | liveness `200`; readiness `503`, the `start` check giving those three lines |
| not seen, without `MFA_SECRET_KEY` and `APP_BASE_URL` | readiness `503`, the `start` check giving those three and `MFA_SECRET_KEY is not set; APP_BASE_URL is not set` |
| not seen, `NODE_ENV=development` with the two development folders | readiness `503`, the `start` check giving `NODE_ENV is not "production", but this is a production build` and one line for each of the three adapters |
| not seen, an environment that fails its schema | liveness `200`; readiness `500` |

In each of the three that readiness answered with `503`, the storage check
read `does not answer` as on the base, and the server logged one warning
with the `start` check's lines for each readiness request, beside the
storage probe's.

The development server (`next dev`) given `NODE_ENV=production` is the
other kind of production start. Seen, its server ended with the check's
four lines and the command ended with 0, as ADR-0151 describes. With
`NEXT_PHASE` set as above it was not seen and served; readiness read `503`,
the `start` check beginning `NODE_ENV is "production", but this is not a
production build`.

The browser test's development server reads `nothing refused`
(`tests/e2e/readiness.spec.ts`).

No test starts a production build: what Next.js does with `NEXT_PHASE` is
measured here and held by no test, as in RD-2a.

## Consequences

- Changed: `apps/web/src/lib/startup.ts` (`webStartProblems`, which
  `checkWebStart` now calls), `apps/web/src/lib/health.ts` (the `start`
  check, and `startProblems` among what readiness is given),
  `apps/web/src/lib/readiness.ts` (it gives and logs them), their three
  tests and the browser test. The tests of `checkWebStart` are as they
  were.
- `GET /api/health/ready` answers with five checks where it answered with
  four. The answer's shape, the route's status codes and the other four
  checks are unchanged. No page, permission, migration or audit action
  changes.
- Today the change turns no answer from `200` to `503`: every start the
  check refuses already read `503` by the storage check, or `500` where
  its environment fails its schema. It gives the reasons, in the answer
  and in the log, and it keeps such a start not ready once RD-3 adds a
  storage adapter production may use.
- A start that neither `NODE_ENV` calls production reads `nothing
  refused`: the development server, the browser test and the tests are
  judged as before, by nothing.
- `docs/production-readiness-gap-analysis.md` said that each pull request
  of the plan still needs the product owner's yes before merge. That held
  for RD-1. Since the product owner's standing approval of 2026-11-16
  08:08Z a milestone of an approved plan is merged without asking again,
  as the merge commits of RD-2a to RD-2c record, and the document now says
  so.
- `docs/decisions/TODO.md`: the address the web app's own client cannot
  read is RD-2e's to decide, and one item is opened, on a server started
  with `NEXT_PHASE` naming the build.
