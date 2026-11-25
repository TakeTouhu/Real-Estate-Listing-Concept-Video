# API Changes — Unknown request failures logged

A request failure the app does not know, taken by one of the logged
catches, now leaves one line in the server's log (ADR-0177); a Property
page leaves one for each organization it tries. An error no catch takes
still reaches only Next.js's raw output. **No HTTP change, no migration, no
dependency and no new setting.** Every status, body, text, `Location`,
cookie and header is as before.

## Why

Measured in RD-2c: a sign-in against a database the web app could not
use was answered `Sign in failed`, and nothing was logged for it.
`appErrorToResponse` answered an error it did not know as
`INTERNAL_ERROR` and logged nothing, and the six form routes that
answer a fixed text for such an error logged nothing either. Since
RD-8a the limiter's own failure was rethrown as a plain error with
nothing of the original, so a database outage refused sign-ins and
uploads with nothing in the log (`docs/decisions/TODO.md`, the item
this closes).

## HTTP

Unchanged. One thing becomes useful: the `requestId` a JSON error
envelope of 500 or more answers is the same id the line carries, so such
an id a customer reports can be found in the log. A 4xx answer's id is
logged nowhere.

```json
{ "error": { "code": "INTERNAL_ERROR", "message": "Unexpected error",
  "requestId": "6f1c…", "details": {} } }
```

A form route's redirect carries no id; its line has an id of its own.

## Logs

One `error` line, from the component `request`, for an error that is
not an `AppError` or an `AppError` answered 500 or more
(`CONFIGURATION_ERROR`, `PROVIDER_ERROR`, `INTERNAL_ERROR`, or any
`httpStatus` of 500 or more). A 4xx `AppError` is an expected answer and
logs nothing new.

```json
{"level":"error","time":"…","message":"A request failed",
 "component":"request","route":"POST /api/auth/login",
 "requestId":"…","errorName":"RateLimiterUnavailable",
 "code":"UNEXPECTED","causeName":"PrismaClientInitializationError"}
```

- `route`: the route as the code names it, `METHOD /path` with its
  brackets (`POST /api/assets/[assetId]/retry`); `UNNAMED` where a
  caller of `appErrorToResponse` names none.
- `requestId`: the envelope's id, or a fresh one for a redirect or a
  page.
- `errorName`: the error's `name` when it is one word of at most 60
  characters, else `UNNAMED`.
- `code`: the first plain code of the error or of its causes, four
  deep, each read as readiness reads its own (`probeFailureCode`); else
  `UNEXPECTED`.
- `causeName`: only when present, the name of what the error stands
  for.

Never logged: the error's message, stack or object, its cause, the
request's address, query, headers, cookies or body, anything typed, the
client's address, or a user or organization id.

**A database outage reads `code: UNEXPECTED`.** Prisma names `P1001`
only when asked to connect, and the limiter's store only queries; read
`errorName` and `causeName` with the code. Readiness, which connects,
still logs `P1001`.

## Code

- `apps/web/src/lib/failure-log.ts` (new): `logRequestFailure(error,
  route, requestId?)`, which writes the line, never throws and returns
  the id; `failureName`, `failureCode` and `isUnknownFailure`; and
  `probeFailureCode`, moved unchanged from `readiness.ts`, which still
  exports it.
- `appErrorToResponse(error, route?)` logs before it answers, with the
  id it puts in the envelope. The 16 calls that pass a caught error, and
  `mfaRoute`, name their route.
- The six form fallbacks, sign-up's limiter `catch`, sign-out's
  revocation, the generation start and the Unit purchase (before they
  rethrow an error they do not know), the five Property pages and the
  security page's MFA status call `logRequestFailure`. Their answers are
  unchanged.
- `withoutLimiterText` throws an `Error` named `RateLimiterUnavailable`
  with the original's filtered `code` and `causeName` and no `cause`. It
  is still not an `AppError`, and its message is unchanged. It wraps
  sign-in, its code step and `limitJsonRequest` only: sign-up's line
  names its store's own error, and the lib helpers' limiters log a code
  alone and write no request line.

## Tests and CI

- `tests/api/failure-log-coverage.test.ts` parses every route file,
  server page and layout and `lib/mfa.ts`, and holds each of their 48
  catches to a logged, body-read, page-rethrow or listed shape
  (ADR-0177 Decision 5).
- Unit tests for the line, the limiter's error and `appErrorToResponse`;
  route tests for sign-in, its code step, sign-up and sign-out with the
  limiter or the revocation failing; a Property page test, one line for
  the one organization of three whose read fails; and the security page
  logging an MFA that is not configured.
- CI's `web-image` job signs in against the stand-in database and
  requires exactly one such line, naming `RateLimiterUnavailable` and
  `PrismaClientInitializationError`, and neither a typed value, as sent
  or as read, nor the forwarded address nor a stand-in secret anywhere
  in the server's log. The checks stay 12.
