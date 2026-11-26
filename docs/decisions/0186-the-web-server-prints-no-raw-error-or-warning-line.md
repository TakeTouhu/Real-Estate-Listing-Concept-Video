# ADR-0186 — The web server prints no raw error or warning line

Status: Accepted (PT-7b2, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26
(`docs/production-readiness-part2-gap-analysis.md`); the CTO decided
the stack and the text allowlist the same day. No customer surface,
charge, business rule or answer changes.

**Amends ADR-0151 Decision 5 (the start hook may load
`console-bridge.ts`), ADR-0177 Decision 7 and ADR-0185's first two
known gaps and Decisions 1 and 4's forward references (Next.js's raw
print is gone from a production server).**

## Context

Next.js 15.5.28 prints an error no catch took by `console.error`: a
route handler's (`route-module.js:261-272`), a server component's
(`router-server.js:551`), the middleware's (`next-server.js:490-491`,
to which the template's `middleware.js:69-96` rethrows), an unhandled
rejection's and an uncaught exception's (`next-server.js:193-221` and
`router-server.js:554-567`, so a rejection gives two lines, one per
handler) and a failing `onRequestError`'s; `log.js` looks
`console[method]` up at each call.
The print holds the error's message and stack, outside `redact`; a
message, Next.js's or React's, can carry a request's values
(*inference*), and in PT-7b1's lab Prisma's named the database's host.
nodemailer warns by `console.warn` (`dist/cjs/shared/index.js:272`,
`dist/esm/shared/index.js:225`). ADR-0185
could not remove the print: `quiet` is not reachable from `server.js`.

## Decision 1 — Replace `console.error` and `console.warn`

Once `checkWebStart()` returns, `register()` calls
`installConsoleBridge()` (`apps/web/src/lib/console-bridge.ts`, a
dynamic import, as `startup`), only where `NEXT_RUNTIME` is `nodejs`
and `NODE_ENV` is `production`. It replaces the two methods of the
global `console` with functions that write one line through the logger
and return; nothing reaches the original, so the raw line is gone.
`next dev` and tests keep raw output; a start the check ends never
installs it. The logger's sink is `console.log` (`logger.ts:68`),
which is not replaced, so no line comes back to the bridge. A call
never throws. A second install changes nothing and returns the first
restore function.

## Decision 2 — The line, with the stack's frames

One line of the component `console`, by literal `log.error` and
`log.warn` calls held by ADR-0182's guard: `ERROR`, `"The web server
printed an error"`, or `WARNING`, `"The web server printed a
warning"`. Its fields, in order: `method`; `text` (Decision 3); and,
of the first argument that is an error, `errorName`, `code`,
`causeName` (by `failureFields`, shared with ADR-0185), a `digest` of
digits (`failureDigest`) and `frames`. An error is an `instanceof
Error`, which Prisma's are though their `Symbol.toStringTag` is their
name, or one `util.types.isNativeError` says is real, as one of
another realm is. Every other argument is dropped, a plain object
included even when its tag reads `[object Error]`: `node:util` is the
one module the hook gains (ADR-0151 Decision 5's guard lists it).

**The stack: its frames, never its message** (the CTO's decision).
V8 writes `error.stack` at its first read as the error's `toString()`,
the header (`Error: m`; `Error` for an empty message; `m` for an empty
name), then a frame a line (measured on Node.js 22.23.4). Node.js
writes its own coded errors' header as `RangeError [ERR_OUT_OF_RANGE]:
m` (`Error [ERR_X]: ` or `Error [ERR_X]` for an empty message), and
puts a script's place, source line, a caret and a blank line before
the header of an error thrown out of `vm` (measured on Node.js 22.23.4
outside Vitest, by the PT-7b2 closing reviews). A message can
span lines that look like frames, so only what follows the exact
header is read: `Error.prototype.toString`'s, or for an `ERR_` code
the coded form of it, at the stack's start or after a blank line. A
stack without it gives none. That alone is not a guarantee (measured
by the PT-7b2 reviews on the bundled bridge): an error whose message
or name changed after the stack's first read can match the new header
at the start or inside its old message, and a stack can be written to
start with the header; either puts other text after the header. So a
line is kept only in V8's frame grammar: trimmed, it
is `at ` and a place, or `at `, a name and a place in brackets, with
no control character, where a place is a path or URL ending
`:line:column`, `native`, `<anonymous>` or `index N`. Text shaped
exactly like a frame, place included, still passes; no Next.js 15.5.28
production path writing such text was found (*inference*). Each part
between spaces and brackets goes through `redact`, which drops an
http(s) URL's query; it is cut at 400 characters, and at most 50 are
kept. The lab's longest frame was 334 characters, 232
with its 106-character folder written as the image's `/app`: 400 keeps
both whole, and bounds a line's frames to 20,000 characters (UTF-16
units; more bytes for text outside ASCII or escaped in JSON). Only the
first 200 lines after the header are read, and a line over 1,000
characters is not tested: the grammar's test takes time growing with
the square of a line's length, over 3 s for a hostile line of 100,000
characters (measured by the closing review).

A frame names a path, a line and column, a function, `async`, `new`,
`node:internal` modules and webpack chunks, and no argument
(*inference*: V8 prints none); a function named from a computed key,
or a path holding a value, would carry it (*inference*: none seen). An
uncaught request error gives two lines, this and ADR-0185's: merging
them would need a deferral, which `apps/web/src` may not have.

## Decision 3 — The text allowlist

A text is kept only when it equals an entry exactly, so it cannot
carry a value; a new entry is a reviewed change. The entries are
nodemailer 10.5.0's `Failed to resolve IPv4 addresses with current
network` and its IPv6 twin (`family` is 4 or 6 from `dns.lookup`).

## Decision 4 — What holds it

`console-bridge.test.ts`, on its own console and sink;
`instrumentation.test.ts`, which mocks the bridge (once, after the
check; never after a failed check, in `edge`, `development` or
`test`); `startup.test.ts`; the constant-message guard.

## What was measured

As PT-7b1's lab: the built standalone `server.js`, `NODE_ENV=production`,
stand-in settings, a database that refuses. A same-origin multipart
`POST /api/auth/login?token=...` with no boundary, and
`GET /properties/p1?token=...` with a session cookie: both 500, stderr
empty. stdout held the start lines, then per request the bridge's line
(`TypeError`, 10 frames; `PrismaClientInitializationError`, a digest,
9 frames) and ADR-0185's, with the same digest; no line held the
query's value, the cookie or the database's user. `console.trace`,
`console.assert` and Node.js's own warnings call the global
`console.error` or `console.warn`, so they become a line without text.
`edge-instrumentation.js` stayed 343 bytes.

## Consequences and known gaps

- A library's warning is reduced to `method` or an error's name unless
  allowlisted; the `request` lines still hold no stack.
- nodemailer's warning is a `WARNING` line with `text`; the log report
  still fails on it, which is kept: a host with no outside interface of
  the address's family cannot reach an outside mail server
  (*inference*).
- A call that reads an argument which itself calls `console.error` or
  `console.warn` writes that inner call as a line with `method` alone,
  so the bridge never recurses; an argument whose type check throws,
  such as a revoked proxy, is not an error.
- A middleware's own `console.error` or `console.warn` reaches the
  bridge as one string formatted by the edge runtime, which binds
  `console.error` when the sandbox first loads, at the first
  middleware run, so the line keeps only `method` (*inference*: by the
  source, not measured).
- Not covered (`TODO.md`, "Open in PT-7b2"): `console.log`, `info`
  and `debug`; `process.stderr.write`; what Node.js itself writes, such
  as a fatal error, or for a crash before Next.js's handlers are
  installed; anything before
  `register()`, the start report included; a library that kept
  `console.error` earlier (*inference*: none measured); another process
  or realm; the worker. How Cloud Logging reads the line is G1's.

## Considered and not done

**Dropping the stack entirely**, the plan's recommendation and
ADR-0177's rule for the request line: rejected by the CTO, since frames
name code locations, not customer data, and operators keep a trace.
Teeing to the original (the raw line would stay); nodemailer's
`allowInternalNetworkInterfaces` (it changes which addresses it
connects to); a custom server for `quiet` (ADR-0185 Decision 1).
