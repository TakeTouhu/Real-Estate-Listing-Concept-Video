# ADR-0187 — The production-mode job answers one error no catch takes

Status: Accepted (PT-7b3, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26
(`docs/production-readiness-part2-gap-analysis.md`); the CTO chose the
trigger and kept this milestone as its own pull request the same day.
No customer surface, charge, business rule, route or answer changes:
only CI's `production-mode` job and its log report.

**Amends ADR-0178 Decision 10 and the log report RD-11b built on it
(`tests/production/log-report.mjs`): two more `ERROR` lines are
required, once each. Amends ADR-0185 Decision 6 and ADR-0186
Decision 4 (CI's production-mode job now holds both lines).**

## Context

ADR-0185 writes one `request` line for an error no catch took, and
ADR-0186 turns Next.js's own print of it into one `console` line. Both
are held by unit tests and were measured on a standalone `server.js`
built on a developer's machine. No CI job ran either: "no CI job has
an uncaught error" (ADR-0185 Decision 6). This ADR draws from that
that the log reports could not tell a working bridge (ADR-0186) from a
missing one. The `production-mode` job runs the web image as built
against live stand-ins and reports its whole log by fields (the
`web-image` job runs the image too, but has no such report), so it is
where the two lines are held.

## Decision 1 — The trigger: a multipart sign-in with no boundary

After "Stop the database, then start it again" and before "Report the
server's log", a step named "Answer one error no catch takes" sends
one `POST /api/auth/login` through the job's TLS front, with the
`Origin` every other sign-in of the job sends, so the origin check
passes, and `Content-Type: multipart/form-data` with no boundary and a
one-byte body. The route reads its body with `request.formData()`
(`apps/web/src/app/api/auth/login/route.ts:18`) after the origin check
and before its `try`, so the body read throws and no catch of the app
takes it. Next.js answers `500`; the step requires exactly that.

The error is a `TypeError`: the Fetch standard requires `formData()`
to reject with one when the body cannot be parsed, and Node.js's
undici writes `TypeError: Failed to parse body as FormData.`, a
message that names no value (measured on Node.js 22.23.4). The image
pins Node.js 22 (`apps/web/Dockerfile`); that its build throws the
same `TypeError` with the same message is *inference*, by the standard
and undici's wording. The step runs before the
limiter, so it counts no sign-in: the limit step's count and the
outage's single line are unchanged. It stops no stand-in.

The plan's other trigger, a page request with a session cookie while
the database is stopped, in the outage step, so that a session lookup
throws, was not chosen: the CTO chose this one, which the plan's
critique, outside the repository, had measured on a standalone
server.

## Decision 2 — The coupling to a gap

The trigger works only because the sign-in route's `formData()` call
is outside its `try`, one of the six such calls `TODO.md` lists under
"Errors the app does not catch are printed raw by Next.js". A change
that moves that call inside a catch makes the route answer `303`
through its own catch and the step fail at its `500` test, so it
cannot pass silently. Such a change moves the step to another trigger
that still reaches Next.js's catch, and amends this ADR. `TODO.md`
records it (PT-7b3).

## Decision 3 — What the log report allows and requires

`log-report.mjs` still fails on any raw line but Next.js's start
lines, on any listed value (exit 2), and on any `ERROR` or `WARNING`
line it does not list. It now also lists, and requires exactly once
each, the two lines of this error:

- an `ERROR` line of the component `console` with `method` `error` and
  `errorName` `TypeError` (ADR-0186);
- an `ERROR` line of the component `request` with `route`
  `POST /api/auth/login` and `errorName` `TypeError` (ADR-0185).

Neither alone passes, nor either twice, nor a `TypeError` line for
another route, nor Next.js's raw print of the error as it read before
PT-7b2. A second uncaught `TypeError` anywhere in the run's server
counts as a second `console` line, so it fails. The outage's line,
which names `RateLimiterUnavailable`, is counted apart, as before.
`code`, `routeType` and `frames` are not matched, so a later Node.js
or Next.js that adds a code or changes the frames does not fail it.

## Decision 4 — What holds it

`tests/production/log-report.test.ts` (the pair once; each twice, the
pair twice, either alone, neither; another error's print; another
route's line; the raw print before PT-7b2, alone and beside the pair),
`tests/container-images.test.ts` (the step's place between the outage
and the report, its time bound and its commands word for word, and,
as for every stand-in step, no insecure flag) and CI's run itself,
which is the first measurement of the bridge in the image.

## What was measured

On the standalone `server.js` built from this tree with
`env -u NODE_ENV pnpm --filter @app/web build`, `NODE_ENV=production`,
stand-in settings (`APP_BASE_URL=https://app.rd11.test:8443`) and a
database address that refuses, on port 3000 as in the image. The
step's request, word for word but the address (the lab asked the
server directly, not through a TLS front), answered `500`; a
url-encoded sign-in then answered `303 /login?error=Sign+in+failed`,
the outage's shape. stderr was empty. `log-report.mjs` on stdout and
stderr together, with the run's stand-in secrets as listed values,
exited 0, "No finding": the start lines, one `console` line
(`TypeError`, `UNEXPECTED`, 10 frames), one `request` line
(`POST /api/auth/login`, `TypeError`, `routeType` `route`) and the
`RateLimiterUnavailable` line. The same log without the `console`
line, or with both `TypeError` lines twice, exited 1 and named the
count. The Docker job itself was not run: its first run is the pull
request's CI.

## Consequences and known gaps

- The job's log now holds two more `ERROR` lines on a clean run
  (three with the outage's). A reader of its summary sees them
  counted.
- Only a route handler's error is held in the image. A server
  component's line is held by unit tests and PT-7b1's and PT-7b2's
  labs; a middleware's and a rejection's only by reading and unit
  tests (`TODO.md`, "Open in PT-7b3").
- How Cloud Logging reads either line is G1's, as before.

## Considered and not done

**No CI step** (unit tests and the lab only), the plan's third
option: the CTO chose a step; the plan names the job as the only
holder that runs the bundled server, not a unit test. **Folding into
PT-7b2**, which the plan allowed under about 380 lines: PT-7b2 was
larger, and the CTO kept this one apart (in the plan's critique,
outside the repository). **A route
made to throw for CI**, not proposed: production would serve it too.
