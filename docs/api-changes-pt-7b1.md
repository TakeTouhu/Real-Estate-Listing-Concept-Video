# API Changes — PT-7b1

A request error Next.js answers is logged as one JSON line (ADR-0185).
Production readiness, part 2, approved by the product owner on
2026-11-26. **No route, answer, stored value, setting or migration
changes.** The 500 answer and the error page are as before; the web
server writes one more log line for each error no catch took.

## The new line

`apps/web/src/instrumentation.ts` exports Next.js's `onRequestError`.
In the Node.js runtime it writes, through the logger, one line like
these two, measured on the built standalone server (the `requestId`s
shortened here):

```json
{"severity":"ERROR","time":"2026-11-26T11:06:18.817Z","message":"Next.js answered a request that failed","component":"request","route":"POST /api/auth/login","requestId":"76d8f163-…","errorName":"TypeError","code":"UNEXPECTED","routeType":"route"}
{"severity":"ERROR","time":"2026-11-26T11:06:18.985Z","message":"Next.js answered a request that failed","component":"request","route":"GET /properties/[propertyId]","requestId":"868729e7-…","errorName":"PrismaClientInitializationError","code":"UNEXPECTED","routeType":"render","renderSource":"react-server-components","digest":"917604536"}
```

- The message is a constant of its own, apart from a route's
  `"A request failed"` (ADR-0177). Every error the hook reports is
  logged, a 4xx `AppError` included.
- `route` is the method and the route's pattern: an unlisted method is
  `OTHER`, a pattern of another shape `(other)`. `routeType` and
  `renderSource` take only Next.js 15.5's values, else `other`.
  `digest` appears only when it is digits.
- Never the request's path, query or headers, nor the error's message
  or stack.

## What is unchanged

- Next.js still prints the error raw to stderr, with its message and
  stack, before the line. PT-7b2 is to remove that print.
- The middleware (edge runtime) and errors outside a request, such as
  an unhandled rejection, get no line.
- `redirect()` and `notFound()` give no line: Next.js answers them
  before the hook.

## Who is affected

An operator reading the web server's log: one more `ERROR` line per
error Next.js reports to `onRequestError`, answered 500; a
payload request or a page whose shell was already streamed has been
answered 200 (ADR-0185). No CI job has such an error.

## Tests

`failure-log.test.ts`, `instrumentation.test.ts` (held to Next.js's
`Instrumentation` type) and `startup.test.ts` (the hook may now load
`failure-log.ts` and `@app/observability`, still no adapter), as
ADR-0185 Decision 6 lists.

## Phase documentation

- Change log and release notes: this document and the Roadmap's PT-7b1
  paragraph, as for PT-7a to PT-7a4 (`CHANGELOG.md` stops at Phase
  5C).
- Architecture: `docs/architecture.md`'s `failure-log.ts` row names the
  new line. Sequence and entity-relationship diagrams: Not applicable;
  no flow or table changes.
- OpenAPI: Not applicable; no route or answer changes.
- Database migration: Not applicable; see `docs/migration-notes.md`.
