# API Changes — RD-2b

Readiness asks the database and the object storage to answer (ADR-0152).
**No migration, no new route and no page.**

## HTTP

### `GET /api/health/ready` (operator bearer token)

Two more entries in `checks`, after `video-provider-adapter` and `mfa`:

| Check | `ok` when | `detail` |
| --- | --- | --- |
| `database` | the database takes a connection, if none is open, and answers `SELECT 1` | `answers` or `does not answer` |
| `storage` | the chosen storage adapter is built and answers whether one key holds an object; it writes none | `adapter=<name>, answers` or `adapter=<name>, does not answer` |

Any check failing makes `status` `degraded` and the answer `503`, as before.
No detail carries what a probe threw. Readiness sets no time limit of its own
(ADR-0152 Decision 2): a probe ends when its client answers or gives up, and
a database that keeps its connections and says nothing can leave the request
with no answer. Whatever asks must set a limit of its own.

The body, without its `service`, `version`, `time` and `provider`:

```json
{
  "status": "degraded",
  "checks": [
    { "name": "video-provider-adapter", "ok": true, "detail": "adapter=fake" },
    { "name": "mfa", "ok": true, "detail": "key set" },
    { "name": "database", "ok": false, "detail": "does not answer" },
    { "name": "storage", "ok": true, "detail": "adapter=shared-folder, answers" }
  ]
}
```

`GET /api/health` is unchanged.

## Logs

A probe that did not answer is logged as a warning: component `readiness`,
`probe` (`database` or `storage`) and `code` (the error's own one-word code,
or `UNEXPECTED`). Never the error's message.

## Internal API

### Changed: `apps/web/src/lib/health.ts`

| Export | Shape |
| --- | --- |
| `ReadinessProbe` | new: `"database"` or `"storage"` |
| `ReadinessInputs` | new: `database()` and `storage()`, each resolving when its service answers; `storageAdapter`; optional `failed(probe, error)` |
| `computeReadiness(env, provider, inputs, now?)` | takes the inputs and adds the two checks |
| `buildReadiness()` | moved to `readiness.ts`; this module now imports only types |

### Added: `apps/web/src/lib/readiness.ts`

| Export | Shape |
| --- | --- |
| `buildReadiness()` | readiness of the running web app: its environment, provider, database, storage and log |
| `READINESS_STORAGE_KEY` | `readiness/probe`, the key the storage check asks about; nothing writes it |
| `probeFailureCode(error)` | the code a failed probe is logged by |
