# ADR-0181 — A log line names its severity as Cloud Logging reads it

Status: Accepted (PT-7a, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26 at
04:38Z (`docs/production-readiness-part2-gap-analysis.md`). It changes
no customer surface, charge or business rule: only the shape of a log
line, an engineering call recorded here.

Builds on: ADR-0054 (Cloud Run for the web app and the workers, Cloud
Logging for their logs), ADR-0177 (the request failure line and its
fields), ADR-0178 Decision 10 (the production-mode job's log report).

## Context

`createLogger` (`packages/observability/src/logger.ts`) wrote each line
as `level`, `time`, `message`, then the caller's `base`, `child` and
call fields, spread last. Two things followed:

- Cloud Logging reads a JSON line's severity from `severity`. `level`
  is not one of the keys it reads specially, so it stays in
  `jsonPayload`, and every line would carry no severity of its own
  (*inference*: nothing is deployed, so this was never measured).
- A caller's field named `level`, `time` or `message` overwrote the
  logger's own (`TODO.md`, "The logger's message, reserved keys and
  other URLs bypass `redact`"). No caller passes one today.

Sources, read by WebFetch on 2026-11-26 (each `cloud.google.com` address
answered with a redirect to the same path on `docs.cloud.google.com`):

- Cloud Run's logging page (`https://cloud.google.com/run/docs/logging`)
  says the special fields of a JSON line are stripped from `jsonPayload`
  into the entry. It names `severity` and `message`, and for the full
  list it links "special fields" to the Logging agent's table (the next
  source). Its samples write upper case (`NOTICE`, `INFO`). It does not
  say what a line with no `severity` gets.
- The Logging agent's special-fields table, at the `#special-fields`
  anchor of `https://cloud.google.com/logging/docs/agent/configuration`,
  lists `severity`, `message`, `httpRequest`, `time` or `timestamp` (or
  `timestampSeconds` and `timestampNanos`), the
  `logging.googleapis.com/` keys, and `log`, marked "legacy Google
  Kubernetes Engine only". Its `severity` row says the agent "attempts
  to match a variety of common severity strings", including the
  LogSeverity names; it does not list the others.
- The structured-logging page
  (`https://cloud.google.com/logging/docs/structured-logging`) lists
  the keys the built-in agents of Cloud Run, GKE, Cloud Run functions
  and App Engine read: `severity`, `message`, `httpRequest`, `time` or
  `timestamp` (or `timestampSeconds` and `timestampNanos`), and
  `logging.googleapis.com/insertId`, `/labels`, `/operation`,
  `/sourceLocation`, `/trace`, `/spanId` and `/trace_sampled`. Every
  other key stays in `jsonPayload`. It lists no accepted severity
  spellings, cases or aliases.
- The LogSeverity enum, at the `#LogSeverity` anchor of
  `https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry`,
  has `DEFAULT`, `DEBUG`, `INFO`, `NOTICE`, `WARNING`, `ERROR`,
  `CRITICAL`, `ALERT` and `EMERGENCY`.

Only the Logging agent's table lists `log`, and only for legacy GKE,
as the plan's critique also read it.

## Decision 1 — `severity`, by the enum's exact names

The logger writes `severity` and no longer writes `level`:

| Level | `severity` |
| --- | --- |
| `debug` | `DEBUG` |
| `info` | `INFO` |
| `warn` | `WARNING` |
| `error` | `ERROR` |

The values are the enum's own upper-case names, as Cloud Run's samples
write them. The agent's table says other "common severity strings" are
matched but does not name them, so a lower-case form or an alias such
as `WARN` is not relied on. `NOTICE`, `CRITICAL`, `ALERT` and `EMERGENCY` are
not added: no level maps to them.

`LogLevel`, the threshold (`LoggerOptions.level`) and the worker's
`LOG_LEVEL` mapping are unchanged. Only the written field changes.

`level` is dropped rather than written beside `severity`: one source of
truth, and a test that pins the exact keys changes either way.

## Decision 2 — A caller cannot write a reserved key

The logger drops a `base`, `child` or call field whose key is
`severity`, `level`, `message`, `time`, `timestamp`,
`timestampSeconds`, `timestampNanos` or `httpRequest`, or starts with
`logging.googleapis.com/`. Matching is exact and case-sensitive, as
Cloud Logging's is (*inference*: the pages name the keys and say
nothing of case).

- Dropped, not renamed or nested: no caller writes one today, and
  nesting every field would change every reader of the log.
- `level` is reserved too, so a field cannot bring back the old name.
- `log` is not reserved. The Logging agent's table marks it "legacy
  Google Kubernetes Engine only", which ADR-0054 does not use. A move
  to a platform that reads it is a new ADR.
- The logger itself writes no trace, `httpRequest` or label key. Adding
  one is a later decision.

## Decision 3 — The order of a line is kept

A line still starts with `severity`, `time` and `message`, where
`level`, `time` and `message` were. The fields follow in the order the
caller wrote them, `base` and `child` first. Dropping a reserved key is
what stops a field replacing the logger's own; writing them last would
add nothing and would move every key a test pins in order
(`failure-log.test.ts`). CI also reads the order. Its web-image step
greps `"probe":"database","code":"P1001"` and
`"probe":"database","code":"UNEXPECTED"`, so `probe` and `code` must
stay next to each other. Its production-mode job counts
`"code":"RATE_LIMITED","action":"SIGN_IN","dimension":"client"`, the
rate limiter's warning, so those three must stay together too.
`logger.test.ts` holds the caller's order around a dropped key.

## Decision 4 — Dropped before `redact`, and `redact` still applies

The merged `base` and fields lose their reserved keys first, and what
remains goes through `redact` as before. `redact` then scrubs exactly
the fields that are written; a dropped value is never written, so whether it was
redacted does not matter. Both steps keep the key order.

## Consequences

- Each line carries `severity`, which Cloud Logging is documented to
  read into the entry. Whether it does for this image on Cloud Run is
  measured first at G1 staging.
- A query, alert or tool that reads `level` must read `severity`, with
  `WARNING` for `warn` and upper case throughout. In the repository,
  `tests/production/log-report.mjs` and five tests in
  `apps/web/src/lib` did; they read `severity` now.
- Historical documents that show `level`
  (`docs/api-changes-unknown-failures.md`,
  `docs/production-readiness-completion.md`) and one that describes the
  logger's levels (`docs/api-changes-rd-11b.md`) stay as written.
- The production-mode job's report table names `severity` in its first
  column. The first CI run is its check.
- The message still bypasses `redact`, and a URL's user and password
  without a query still survive it. Both stay open for PT-7a2
  (`TODO.md`).

## Considered and not done

- **Writing both `level` and `severity`.** Two fields for one fact, and
  the old name would never go.
- **Lower-case values, or `WARN`.** Cloud Run's samples and the enum
  use the upper-case names; the agent's table names no other form.
- **Writing `severity`, `time` and `message` last.** Redundant once the
  reserved keys are dropped, and it reorders every line.
- **Renaming a reserved field (for example to `field_message`).** No
  caller writes one, and a rename adds a name every reader must learn.
- **Reserving `log`.** See Decision 2.
- **Throwing on a reserved key.** ADR-0177 Decision 2 wraps the
  request line's write so that a throwing sink never changes the
  answer; a throwing logger would break that for every unwrapped
  caller. `logger.test.ts` holds the drop instead.
