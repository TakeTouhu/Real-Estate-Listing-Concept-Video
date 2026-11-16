# API Changes — RD-2

A production start of the web app is checked, and readiness asks the
database and the object storage to answer (ADR-0151). **No migration, no new
route and no page.**

## HTTP

### `GET /api/health/ready` (operator bearer token)

Gains two checks:

```json
{ "name": "database", "ok": true, "detail": "answers" }
{ "name": "database", "ok": false, "detail": "does not answer" }
{ "name": "storage", "ok": true, "detail": "adapter=shared-folder, answers" }
{ "name": "storage", "ok": false, "detail": "adapter=memory, does not answer" }
```

The storage detail names the chosen adapter (`shared-folder` or `memory`).
Either failing makes `"status": "degraded"`, and the probe answers `503`.
Neither reports what went wrong. Every other route and page answers as before.

## Start

A production start (`next start`) ends with exit code 1 and one message on
standard error, listing every reason, when the environment is invalid, a
port's adapter is a development one, no email adapter is chosen, or
`DATABASE_URL`, `MFA_SECRET_KEY` or `APP_BASE_URL` is not set.

## Internal API

### Added: `apps/web/src/lib/startup.ts`

| Export | Shape |
| --- | --- |
| `productionStartProblems(env)` | every reason a production start is refused, one line each; empty when it may start |
| `WebStart` | how a refused start is reported and ended: `report(message)`, `exit(code)` |
| `checkWebStart(loadEnv?, start?)` | in production only: reads the environment, and reports and ends a start that has any problem |

### Added: `apps/web/src/instrumentation.ts`

`register()`, which Next.js runs once as the server starts: `checkWebStart()`
in the Node.js runtime.

### Changed: `apps/web/src/lib/health.ts`

| Export | Change |
| --- | --- |
| `ReadinessProbes` | new: `database()` and `storage()`, each resolving when its service answers, and `storageAdapter` |
| `READINESS_STORAGE_KEY` | new: `readiness/probe`, the key the storage check asks about; nothing writes it |
| `computeReadiness(env, provider, probes, now?)` | takes the probes and adds the `database` and `storage` checks |
