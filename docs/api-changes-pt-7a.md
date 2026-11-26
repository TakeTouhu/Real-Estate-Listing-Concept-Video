# API Changes — PT-7a

A log line names its severity as Cloud Logging reads it (ADR-0181).
Production readiness, part 2, approved by the product owner on
2026-11-26. **No route, answer, stored value, setting or migration
changes**; only the JSON lines the web app and the worker write.

## The line, before and after

Readiness's database probe not answering, as written before:

```json
{"level":"warn","time":"2026-11-26T01:34:18.803Z","message":"A readiness probe did not answer","component":"readiness","probe":"database","code":"P1001"}
```

And now:

```json
{"severity":"WARNING","time":"2026-11-26T01:34:18.803Z","message":"A readiness probe did not answer","component":"readiness","probe":"database","code":"P1001"}
```

- `level` is gone. `severity` takes its place, first in the line:
  `DEBUG`, `INFO`, `WARNING` or `ERROR` for `debug`, `info`, `warn`
  and `error`.
- `time` and `message` keep their names and their place.
- A `base`, `child` or call field named `severity`, `level`, `message`,
  `time`, `timestamp`, `timestampSeconds`, `timestampNanos` or
  `httpRequest`, or starting `logging.googleapis.com/`, is dropped. No
  caller in `apps/*/src` or `packages/*/src` passes one, so no line
  written today loses a field.
- The other fields keep the order the caller wrote them in. In
  `.github/workflows/ci.yml`, the web-image step greps
  `"probe":"database","code":"P1001"` and
  `"probe":"database","code":"UNEXPECTED"`, which need `probe` and
  `code` side by side, and the production-mode job counts
  `"code":"RATE_LIMITED","action":"SIGN_IN","dimension":"client"`, which
  needs those three together; `logger.test.ts` holds both runs and the
  order around a dropped key.
- `redact` applies to every field written, as before. The `message`
  still does not pass through it (PT-7a2).

The threshold is unchanged: `LOG_LEVEL` still takes the same words, and
the worker still maps them to the logger's `debug` to `error`.

## Who reads the field

In the repository: `tests/production/log-report.mjs`, the production-mode
job's report, now counts and checks `severity` (its table's first column
is `severity`, and it accepts only the four upper-case names), and five
tests in `apps/web/src/lib` (`failure-log`, `readiness`,
`adapters-email`, `adapters`, `same-origin`). No other code, test,
end-to-end test or CI step reads `level`.

Outside it: any saved query, alert or dashboard that reads
`jsonPayload.level` must read `severity`. None exists, since nothing is
deployed (*inference*: the gap analysis lists no infrastructure).

Historical documents keep the old field as they recorded it:
`docs/api-changes-unknown-failures.md` and
`docs/production-readiness-completion.md`. `docs/api-changes-rd-11b.md`,
which describes the logger's levels, stays as written too.

## Tests

- `packages/observability/src/logger.test.ts` (new): each level's exact
  severity, no `level` key, the line's start and the caller's order,
  every reserved key dropped from fields, `base`, a `child` binding and
  all layers at once (`base`, a child and its child, and fields),
  look-alike keys kept, the threshold, one line per call, and `redact`.
- `tests/production/log-report.test.ts`: the samples read `severity`; a
  lower-case severity and a line with only the old `level` fail.

## Phase documentation

- Change log and release notes: this document and the Roadmap's PT-7a
  paragraph, as for PT-6c and PT-6d (`CHANGELOG.md` stops at Phase 5C).
- Architecture, sequence and entity-relationship diagrams: Not
  applicable; no component, flow or table changes.
- OpenAPI: Not applicable; no route or answer changes.
- Database migration: Not applicable; see `docs/migration-notes.md`.
