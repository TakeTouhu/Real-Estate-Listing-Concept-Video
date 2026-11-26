# API Changes — PT-7a3

Liveness names the Cloud Run revision (ADR-0183). Production
readiness, part 2, approved by the product owner on 2026-11-26. One
answer changes: `GET /api/health` gains a `revision` key. **No other
route, answer, stored value, setting or migration changes.**

## `GET /api/health`, before and after

Before:

```json
{"status":"ok","service":"real-estate-virtual-tour-ai-web","version":"0.0.0","time":"2026-11-26T01:34:18.803Z"}
```

Now, where `K_REVISION` is unset (locally and in CI):

```json
{"status":"ok","service":"real-estate-virtual-tour-ai-web","version":"0.0.0","revision":null,"time":"2026-11-26T01:34:18.803Z"}
```

And on Cloud Run, with a revision name *(inference: the form of a
real name)*:

```json
{"status":"ok","service":"real-estate-virtual-tour-ai-web","version":"0.0.0","revision":"vtavision-web-00042-abc","time":"2026-11-26T01:34:18.803Z"}
```

- `revision` is `K_REVISION` when it matches
  `^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`, and `null` when it is unset,
  empty, or anything else: upper case, a dot, white space, `<`, a
  leading digit, a trailing hyphen or more than 63 characters.
- It is read on each request; the route stays `force-dynamic`.
- The key order is `status`, `service`, `version`, `revision`, `time`.
- The status is still 200, and the probe still takes no token.
- `GET /api/health/ready` does not change.

## Who is affected

- Anyone without a token can now read the revision's name, which
  shows the service name and a deploy count (ADR-0183 Decision 3).
- No consumer in the repository reads the liveness body. In
  `.github/workflows/ci.yml`, "Serve with stand-in settings" (its
  wait and its probe script) and the RD-11 steps "Start the web app
  behind the front" and "Check liveness, readiness, the names and the
  way out" read only the status and headers; so do the Playwright
  `webServer` URL and `tests/e2e/security-headers.spec.ts`.

## Tests

- `apps/web/src/lib/health.test.ts`: the exact key set and order; a
  valid revision echoed, including 1 and 63 characters; unset, empty,
  upper case, 64 characters, a space, `<`, a leading digit, a leading
  or trailing hyphen, a dot and a newline give `null`; the default
  reads `K_REVISION` on each call (`vi.stubEnv`); the types-only
  import test unchanged and passing.

## Phase documentation

- Change log and release notes: this document and the Roadmap's PT-7a3
  paragraph, as for PT-7a and PT-7a2 (`CHANGELOG.md` stops at Phase
  5C).
- Architecture, sequence and entity-relationship diagrams: Not
  applicable; no component, flow or table changes.
- OpenAPI: Not applicable; `docs/API.md` has no schema for the
  liveness body, and this document records the change.
- Database migration: Not applicable; see `docs/migration-notes.md`.
