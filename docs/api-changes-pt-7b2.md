# API Changes — PT-7b2

The web server prints no raw error or warning line (ADR-0186).
Production readiness, part 2, approved by the product owner on
2026-11-26. **No route, answer, stored value, setting or migration
changes.** What changes is the production web server's own output.

## Before and after

Before, for an error no catch took, stderr held Next.js's print of the
error, its message and its stack, and stdout ADR-0185's line
(PT-7b1's lab). After, in a production Node.js server, `console.error`
and `console.warn` write one JSON line to stdout instead, and stderr
stays empty. Measured on the built standalone server for a multipart
`POST /api/auth/login` with no boundary (the lab's folder written as
`<lab>`, the frames and the `requestId` shortened here):

```json
{"severity":"ERROR","time":"2026-11-26T11:45:45.230Z","message":"The web server printed an error","component":"console","method":"error","errorName":"TypeError","code":"UNEXPECTED","frames":["at node:internal/deps/undici/undici:5896:27","at successSteps (node:internal/deps/undici/undici:5940:27)","…","at async F (<lab>/apps/web/.next/server/app/api/auth/login/route.js:1:1605)","…"]}
{"severity":"ERROR","time":"2026-11-26T11:45:45.232Z","message":"Next.js answered a request that failed","component":"request","route":"POST /api/auth/login","requestId":"e920a67e-…","errorName":"TypeError","code":"UNEXPECTED","routeType":"route"}
```

- `method` is `error` or `warn`, the severity `ERROR` or `WARNING`;
  `errorName`, `code`, `causeName` and a digest of digits are the first
  error argument's, as in ADR-0185's line.
- `frames`: at most 50 of the stack's `at` lines, read only after the
  exact header, each ending where V8 says it ran (`:line:column`,
  `native`, `<anonymous>` or `index N`), through `redact` and cut at
  400 characters. A stack whose header no longer matches gives none;
  text shaped exactly like a frame, place included, would pass
  (ADR-0186 Decision 2).
- `text` only for nodemailer's two exact warnings; every other string,
  the message and any object that is not an error are dropped.

## What is unchanged, and who is affected

`next dev`, tests, the worker and the command-line tools print as
before, as do `console.log`, `info` and `debug`, Next.js's start lines,
the start check's report and anything before the start hook. A query
or alert on the web server's raw stderr text must read
`component: "console"` lines, with frames but no message. CI's
production-mode web server printed no raw line but Next.js's start
lines on #218's merged head (RD-11c), so no log report changes until
something fails. Tests: ADR-0186 Decision 4.

## Phase documentation

- Change log and release notes: this document and the Roadmap's PT-7b2
  paragraph, as for PT-7b1.
- Architecture: `docs/architecture.md`'s start-hook row names the
  bridge. Sequence and entity-relationship diagrams: Not applicable; no
  flow or table changes.
- OpenAPI: Not applicable; no route or answer changes.
- Database migration: Not applicable; see `docs/migration-notes.md`.
