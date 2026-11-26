# ADR-0185 — A request error Next.js answers is logged as one JSON line

Status: Accepted (PT-7b1, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26 at
04:38Z (`docs/production-readiness-part2-gap-analysis.md`). It changes
no customer surface, charge or business rule; the 500 answer and the
error page are unchanged.

**Amends ADR-0151 Decision 5 (the start hook may load `failure-log.ts`
and `@app/observability`) and ADR-0177 Decision 4 (`onRequestError` is
now used, additively, never taking the path or headers).**

Builds on: ADR-0177 (the request failure line; Decision 7 leaves
Next.js's raw print open), ADR-0182, ADR-0175 Decision 5.

## Context

`TODO.md`, "Errors the app does not catch are printed raw by Next.js":
Next.js 15.5.28 prints such an error with its message and stack,
outside `redact`, and answers it: 500, or 200 for a payload request or
a page whose shell was already streamed.

Read in `node_modules/.pnpm/next@15.5.28_*/node_modules/next/dist`:

- A route handler's error: `build/templates/app-route.js:370-380`
  calls `routeModule.onRequestError`, and
  `server/route-modules/route-module.js:261-272` runs
  `console.error(err)`, then awaits the hook, then answers 500.
- A server component's error reaches the router's `_log.error`,
  `console.error(" ⨯", err)` (`server/lib/router-server.js:551`,
  `build/output/log.js`), and then the hook. React's `onError` calls
  it (`server/app-render/create-error-handler.js:154`, `:210`) and
  does not await it, and for a payload request or an error after a
  streamed shell the answer has already begun, with 200.
- The hook gets `(error, { path, method, headers }, { routerKind,
  routePath, routeType, renderSource?, revalidateReason })`
  (`server/instrumentation/types.d.ts`). `path` holds the query, so a
  signed `?token=` reaches it. `routePath` is the route's pattern:
  `srcPage` (`build/templates/app-route.js:374`,
  `build/templates/app-page.js:970`), `ctx.pagePath`
  (`server/app-render/app-render.js:244`) or `/middleware`.
- A throwing hook is caught and printed raw
  (`instrumentation-globals.external.js`, `server/web/globals.js`).
- `redirect()` and `notFound()` return their digest before the hook
  (`server/app-render/create-error-handler.js:116-118`), so an ordinary
  redirect gives no line.

## Decision 1 — The hook, added beside the raw print

`apps/web/src/instrumentation.ts` exports `onRequestError`, the only
Next.js API that names the route of an error no catch took. Next.js
calls it after its own print, never instead, so the raw print stays
until PT-7b2.

Next.js's `quiet` option would silence only a server component's print;
a route handler's error is printed by `route-module.js`'s
`console.error` regardless. The standalone `server.js` Next.js writes
does not pass `quiet`; only a custom server could. ADR-0175 Decision 5
forbids a deployment to replace the image's entrypoint; a custom server
would be a code change, which needs an ADR superseding that decision. It
is not proposed.

## Decision 2 — The line and its fields

One `error` line of the component `request`, with the message
`"Next.js answered a request that failed"`, a constant held by the
guard of ADR-0182. Its fields, in this order:

| Field | Value |
| --- | --- |
| `route` | The method and `routePath`, as ADR-0177's `route`: `GET /properties/[propertyId]`. A method other than `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS` is `OTHER`; a `routePath` not matching `^/[\w./[\]()@-]{0,119}$` is `(other)` |
| `requestId` | A fresh id, as `logRequestFailure` makes one |
| `errorName`, `code`, `causeName` | By `failureName`, `failureCode` and the cause rule of `failure-log.ts` (ADR-0177); `causeName` only when there is a cause |
| `routeType` | `render`, `route`, `action` or `middleware`, else `other` |
| `renderSource` | When given: `react-server-components`, `react-server-components-payload` or `server-rendering`, else `other` |
| `digest` | When the error's `digest` is 1 to 20 digits |

The method is the client's to choose; `routeType` and `renderSource`
are Next.js's, but the line carries no value it has not checked. The
pattern covers every directory name under `apps/web/src/app` today.
It limits the shape of `routePath` but cannot tell a pattern from a
path such as `/properties/p1`: that `routePath` is a pattern is
Next.js's, at the call sites named in the context.

`digest`, Next.js's hash of a server component's error, is kept: the
error page already sends it to the requester, so logging it reveals
nothing new. `NEXT_REDIRECT;...` is not digits and is dropped.

Never the request's `path`, which holds the query, nor its `headers`,
nor the error's message, stack or object. A value read from the error
or the context that throws, such as a `name` getter, gives the field's
fallback (`UNNAMED`, `UNEXPECTED`, `(other)`, `other`, none), and a
line that cannot be written is dropped: the logging never throws. Only
a failure to load `failure-log.ts`, or a `method` getter that throws
where Next.js passes a plain object, would reach Next.js's catch and
its print of a hook failure.

## Decision 3 — Every error the hook reports is logged

Not only `isUnknownFailure` ones: an error no catch took is a failure
the app did not know, an `AppError` of 4xx included, whatever status
Next.js answered (500, or 200 as the context says). The message of its
own lets these lines be counted apart from a route's `"A request
failed"`. Where a catch logs and then rethrows, both lines are written,
one by each message (*inference*: not measured).

## Decision 4 — The Node.js runtime only

In the edge runtime, which runs only the middleware, the hook returns at
once. `console.log`, the logger's sink, exists there, so this is not to
avoid a throw. The reasons are the bundle, since the edge build then
carries no logger (measured below), and that middleware's `routePath` is
always the constant `/middleware` (`build/templates/middleware.js:92`),
so a line would add only the method. A middleware error keeps Next.js's
raw print alone; PT-7b2's console bridge is to cover it.

## Decision 5 — Where the code lives, and what the hook loads

`logUncaughtRequestFailure` and the pure `uncaughtRequestFields` sit in
`apps/web/src/lib/failure-log.ts`, beside `logRequestFailure`;
`instrumentation.ts` imports `logUncaughtRequestFailure` inside its test
of the runtime, as `register()` imports `startup`; the context's type is
a type-only import. This widens ADR-0151 Decision 5's
guard: `startup.test.ts` now allows `failure-log.ts` and
`@app/observability`, which has no dependency, so the hook still loads
no adapter.

`instrumentation.ts` types the hook by its own parameters, so it does
not import `next`; `instrumentation.test.ts` assigns it to Next.js's
`Instrumentation.onRequestError`, so a change that drops or retypes a
field the hook reads fails the typecheck; an added field does not.

## Decision 6 — What holds it

`failure-log.test.ts` (keys, every allowlist, the digest, a 4xx
`AppError`, a `?token=` in the message, an error from another realm, a
throwing getter, context or sink), `instrumentation.test.ts` (each
runtime, neither path nor header passed on, and the logger named only by
the type import and the import inside the test of the runtime),
`startup.test.ts` (Decision 5) and the constant-message guard. No CI
change: no CI job has an uncaught error, so their log reports are
unchanged.

## What was measured

`env -u NODE_ENV pnpm --filter @app/web build`, then the standalone
`server.js` on `127.0.0.1`, with stand-in production settings and a
database address that refuses connections. A multipart
`POST /api/auth/login?token=...` with no boundary, and
`GET /properties/p1?token=...` with a session cookie, each answered 500
and wrote one line: `POST /api/auth/login`, `TypeError`, `route`; and
`GET /properties/[propertyId]`, `PrismaClientInitializationError`,
`render`, `react-server-components`, a nine-digit `digest`. Neither held
the query's value, the id or the cookie. stderr still held Next.js's
raw prints, the Prisma one naming the database's host and port. The
built `edge-instrumentation.js` was 343 bytes, with no logger.

On a separate build in review, two errors were answered 200 and still
wrote a line: `GET /properties/p1` with the header `RSC: 1`
(`react-server-components-payload`), and `GET /properties/p1/review`,
under a `loading.tsx` (`react-server-components`). How
Cloud Logging reads the line is G1's to measure.

## Consequences

- One more `ERROR` line of the component `request` per error Next.js
  reports to `onRequestError` in the Node.js runtime, answered 500
  when the error comes before the answer starts, and 200 for a
  payload or an error after a streamed shell. No route, answer,
  setting or migration changes.
- Next.js awaits the hook for a route handler's error
  (`route-module.js:267`), so that answer waits for the module to load
  and the synchronous write. For a server component's error it does
  not wait, so the line can follow the answer (*inference*: not timed).

## Known gaps

- Next.js's raw print stays, with the error's message and stack, which
  can name hosts (measured above) and, through a message, request
  values (*inference*). PT-7b2.
- A middleware error and an error outside a request, such as an
  unhandled rejection, get no JSON line; PT-7b2's bridge is to cover
  their print.
- How Cloud Logging reads either line: G1.

## Considered and not done

Logging only unknown failures (Decision 3), the edge runtime
(Decision 4), dropping `digest` (Decision 2), `quiet` through a custom
server (Decision 1), and deferring the line to merge it with the raw
print, which would need a deferral in `apps/web/src`.
