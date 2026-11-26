# API Changes — PT-7b3

The production-mode job answers one error no catch takes (ADR-0187).
Production readiness, part 2, approved by the product owner on
2026-11-26. **No route, answer, stored value, setting, image or
migration changes.** What changes is CI's `production-mode` job and its
log report.

## Before and after

Before, no CI job had an error no catch took, so the two lines of
ADR-0185 and ADR-0186 were held by unit tests and a developer's lab
only. After, the job's new step "Answer one error no catch takes",
between the database's outage and the log report, sends through the
TLS front:

```sh
curl -sS --max-time 20 --cacert "$dir/ca.pem" -o /dev/null -w '%{http_code}' \
  -H 'Origin: https://app.rd11.test:8443' -H 'Content-Type: multipart/form-data' --data 'x' \
  https://app.rd11.test:8443/api/auth/login
```

and requires `500`: the sign-in route's `request.formData()` throws a
`TypeError` before its `try`. `tests/production/log-report.mjs` then
requires, once each, an `ERROR` line of the component `console`
(`method` `error`, `errorName` `TypeError`) and one of the component
`request` (`route` `POST /api/auth/login`, `errorName` `TypeError`).
It fails on either alone, on either twice, and, as before, on any raw
line but Next.js's start lines and any other `ERROR` or `WARNING`. In
the job's summary the two lines read:

```text
| ERROR | console | UNEXPECTED |  | TypeError |  |  | 1 |
| ERROR | request | UNEXPECTED | POST /api/auth/login | TypeError |  |  | 1 |
```

## What is unchanged, and who is affected

The web image, its routes and answers, the other jobs and the steps
before this one. The request runs before the limiter, so the limit
step's count and the outage's one `RateLimiterUnavailable` line are
unchanged. A change that moves the sign-in route's `formData()` inside
its catch fails the step and must move it to another trigger
(ADR-0187 Decision 2). Tests: ADR-0187 Decision 4.

## Phase documentation

- Change log and release notes: this document and the Roadmap's PT-7b3
  paragraph, as for PT-7b1 and PT-7b2.
- Architecture: `docs/architecture.md`'s production-mode row names the
  step. Sequence and entity-relationship diagrams: Not applicable; no
  flow or table changes.
- OpenAPI: Not applicable; no route or answer changes.
- Database migration: Not applicable; see `docs/migration-notes.md`.
