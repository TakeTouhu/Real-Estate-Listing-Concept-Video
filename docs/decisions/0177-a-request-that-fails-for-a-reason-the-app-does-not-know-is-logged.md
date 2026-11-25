# ADR-0177 — A request that fails for a reason the app does not know is logged

Status: Accepted (2026-11-25). Added by the CTO to part 1 of the
production readiness plan after RD-10b, from the RD-10 critic's C15, as
one unlettered pull request, "Unknown request failures logged". Four
reports and a decision in `/mnt/project-files/cto/failure-logging/`
read the sites in scope and choose; `decision.md` adopts the critic's
recommendations as written. ADR-0176 stays RD-10c's, as ADR-0175 names
it; this ADR takes 0177 and lands before it. It amends no ADR.

Builds on: ADR-0155 (a failure is logged by its code, never its
message), ADR-0171 Decision 8 and ADR-0173 Decision 9 (a limiter that
fails refuses in the route's own words, never the limiter's text), and
ADR-0174 Decision 5 (a log line names its route as a literal
`METHOD /path`).

## Context

Measured in RD-2c: a sign-in against a database the web app's client
could not use was answered `Sign in failed`, and nothing was logged.
`appErrorToResponse` answered an error it did not know as a 500 and
logged nothing; six form routes answered such an error with a fixed
text and logged nothing; and since RD-8a `withoutLimiterText` rethrew a
limiter's failure as a plain error with nothing of the original. A
database outage therefore refused sign-ins with nothing in the log,
which RD-11, the first end-to-end run of the production build, could
not explain (`docs/decisions/TODO.md`).

## Decision 1 — What is logged

A request answered for an error that is not an `AppError`, or for an
`AppError` whose `httpStatus` is 500 or more. The test is one predicate,
`isUnknownFailure`. A 4xx `AppError` (`UNAUTHENTICATED`, `FORBIDDEN`,
`NOT_FOUND`, `VALIDATION_FAILED`, `RATE_LIMITED`) is an expected answer
and logs nothing new; the limiter and the origin check already log
their own refusals.

## Decision 2 — The line

One `error` line from `createLogger` with the component `request` and
the fixed message `A request failed`, with exactly these fields:

| Field | Value |
| --- | --- |
| `route` | the literal `METHOD /path` the code passes; `UNNAMED` when none |
| `requestId` | the JSON envelope's id; a fresh one for a redirect or page |
| `errorName` | the error's `name` if it is one word of 60 characters or fewer, else `UNNAMED` |
| `code` | the first plain code (`probeFailureCode`) of the error or its causes, four deep, else `UNEXPECTED` |
| `causeName` | only when present: a recorded `causeName`, else the `cause`'s name |

Never logged: the message, stack, error or cause object, `meta`,
`input`, the request's address, query, headers, cookies or body,
anything typed, the client's address, or a user or organization id. The
write is wrapped so that a sink that throws never changes the answer;
it is synchronous and waits on nothing. `probeFailureCode` moves
unchanged from `readiness.ts` to `failure-log.ts`, which imports only
`@app/observability` and `@app/shared`.

## Decision 3 — The limiter's error

`withoutLimiterText` throws an `Error` named `RateLimiterUnavailable`,
with the original's filtered `code` and `causeName` and no `cause`: an
error that escapes uncaught is printed by Next.js with its cause chain
(inferred from how Node.js prints an `Error`; not measured here).
Its message is unchanged and it is still not an `AppError`, so ADR-0171
Decision 8 and ADR-0173 Decision 9 hold. The name is a literal, so a
minifier cannot change it. Prisma names `P1001` only when asked to
connect and the limiter's store only queries, so a database outage reads
`causeName: PrismaClientInitializationError` and `code: UNEXPECTED`.

`withoutLimiterText` wraps only sign-in, its code step and
`limitJsonRequest`, which the six JSON routes that count uploads,
downloads and analyses call. Sign-up calls its limiter bare, so its
line names the store's own error (`errorName: Error` with a mocked store
in its route test). The lib helpers that count generation starts, Unit
purchases, invitations, downloads, resets and verification emails catch
their limiter's failure themselves and log a code alone; they write no
request line.

## Decision 4 — Where

- `appErrorToResponse(error, route?)` logs the original error, never the
  wrapped `INTERNAL_ERROR`, before it answers, with the id it puts in
  the envelope. The 16 calls under `apps/web/src/app` that pass a caught
  error name their route; `mfaRoute` passes its own `route`.
- `logRequestFailure(error, "<METHOD /path>")` is the first statement
  of the six form fallbacks (sign-in, its code step, sign-up, creating
  an organization, the MFA requirement, creating a Property), of
  sign-up's limiter `catch`, of sign-out's best-effort revocation, and
  of the generation start's and Unit purchase's catches, before they
  rethrow an error they do not know; that error then also leaves
  Next.js's own raw line.
- The five Property pages log in the `catch` that tries each of the
  user's organizations, keyed `GET /path`, and answer as before: one
  line for each organization whose read fails that way. The security
  page logs first in its MFA status `catch`, keyed `GET /security`: the
  `CONFIGURATION_ERROR` (500) it answers itself as "MFA is not available
  right now", which a production start cannot reach since it requires
  `MFA_SECRET_KEY`, and any other error, which it then rethrows to
  Next.js's raw line as well.
- An error that no catch takes, such as a session lookup's or an
  unguarded body read's, or one a page rethrows without logging (the
  home page's and the Units page's), writes no such line and reaches
  only Next.js's raw output.

No answer changes. `onRequestError` is not used: it cannot remove
Next.js's raw line, and it is given the request's raw URL and headers.

## Decision 5 — The guard

`tests/api/failure-log-coverage.test.ts` parses with TypeScript every
route file, every page and layout that is not a client component, and
`lib/mfa.ts`, and holds every `catch` clause and `.catch(` call to one of
four shapes:

1. Its first statement gives a helper its own binding and its own key, a
   string literal (in `lib/mfa.ts`, its `route` parameter). The helper
   must be imported by its own name from `@/lib/http` or
   `@/lib/failure-log` (`./http` or `./failure-log` in `lib/mfa.ts`) and
   declared nowhere
   in the file.
2. A body read: no binding, and a `try` of the one statement
   `x = await request.json()` or `request.formData()`, optionally
   `as T`, `x` a name or a destructuring of names.
3. In a page or layout only, a rethrow: its binding is thrown on every
   path except where it is known to be an `AppError` with a code whose
   default status is under 500, which the page answers itself. The
   guard reads the code, not `httpStatus`: no code in the repository
   sets an explicit status today, and one that did would need the guard
   to read it. A `.catch(` given a function
   declared in the same file, as `app/page.tsx`'s `withoutPropertyView`,
   is read as that function. What it rethrows reaches Next.js raw.
4. An exact list of one, compared by its text: the storage download's
   cancel after an abort, when no request is left to answer.

It also refuses a `.then(` given two functions, `Promise.allSettled`,
and any helper given a route that is not a literal, and reads
`appErrorToResponse` calling `logRequestFailure` first.

## Decision 6 — CI

The `web-image` job's stand-in step signs in through another host name
against the stand-in database. It requires `303` to
`/login?error=Sign+in+failed`, exactly one `"component":"request"`
line for `POST /api/auth/login` naming `RateLimiterUnavailable` and
`PrismaClientInitializationError`, neither typed value, as sent or as
read, nor the forwarded address, and none of the five stand-in secrets
nor the database password anywhere in the server's log, printing none
of them. It does not require `P1001`. No job is
added; the checks stay 12.

## Decision 7 — Not here

Each is open in `TODO.md`, "Open in the unknown-failure PR": errors the
app does not catch, which Next.js prints raw; the logger's message,
reserved keys and other URLs, which bypass `redact`; the lib helpers'
own catches, which log `UNEXPECTED`; the worker's raw start failure; a
stack; and whether the limiter's store should connect first.

## What was measured

On this change, with `env -u NODE_ENV pnpm run build`, the standalone
server was started outside a container on `127.0.0.1` with the job's
sixteen stand-in settings, made by the job's own lines, and a sign-in
with the job's host, origin, forwarded address, content type and typed
body was posted through `node:http`. It answered `303` to
`/login?error=Sign+in+failed` and the log held exactly one
`"component":"request"` line, with `errorName`
`RateLimiterUnavailable`, `code` `UNEXPECTED` and `causeName`
`PrismaClientInitializationError`, and neither typed value, stand-in
secret nor database password. That log, printed whole, also holds
neither `rd10-typed` nor the forwarded address `203.0.113.7`, which the
job also refuses since review. Not measured: the image itself, which is
CI's.

## Consequences

- An operator reads `errorName` and `causeName` with `code`: a Prisma
  query on an unreachable database reads `UNEXPECTED`.
- One line per failure a logged catch takes, unthrottled, during an
  outage; the Property pages write one per organization they try.
  Throttling would need a timer, which the repository forbids. A filter
  on `"component":"request"` sees only those failures: the rest reach
  Next.js's raw output alone.
- The two rethrowing routes and the security page write this line and
  Next.js's raw one for an error they rethrow.
- A helper that wraps `logRequestFailure` must be added to the guard.
- For the product owner, nothing to decide: no answer changes. The
  `requestId` of a JSON answer of 500 or more can now be found in the
  log; a 4xx answer's id is logged nowhere.
