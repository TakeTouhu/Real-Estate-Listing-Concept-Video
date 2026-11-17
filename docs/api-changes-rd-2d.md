# API Changes — RD-2d

Readiness says what the start check refuses (ADR-0154). **No migration, no
new route and no page.**

## HTTP

### `GET /api/health/ready` (operator bearer token)

The answer gains a fifth check, `start`, after `storage`:

| The start check | `ok` | `detail` |
| --- | --- | --- |
| refuses nothing: a start that neither the build nor `NODE_ENV` calls production, and a production start with nothing wrong | `true` | `nothing refused` |
| refuses the start | `false` | the check's lines in its order, joined by `; `, such as `object storage: "memory" is not a production adapter; malware scanning: "passthrough" is not a production adapter; email: none is configured, so sign-up cannot send its verification link` |

A `start` check that is not `ok` makes the status `degraded` and the answer
`503`, as any other check does. The start check ends a start it refuses, so
the second row is read only of a start it did not see, such as a server
started with `NEXT_PHASE=phase-production-build` in its environment
(ADR-0151 Decision 1).

The other four checks, the answer's shape and the route's status codes are
unchanged. An environment that fails its schema answers `500`, as before
(ADR-0154 Decision 3).

`GET /api/health` is unchanged.

## Logs

New: a warning each time readiness is asked while the `start` check is not
`ok`.

| Field | Value |
| --- | --- |
| `message` | `The start check refuses this start` |
| `component` | `readiness` |
| `problems` | the check's lines, as a list |

The warning for a probe that did not answer is unchanged.

## Internal API

### Changed: `apps/web/src/lib/startup.ts`

| Export | Shape |
| --- | --- |
| `webStartProblems(env, allowed?)` | new: the lines a start is refused for, or none when it is not a production start or may go on; it reads the ambient `NODE_ENV` itself |
| `checkWebStart(start?, allowed?)` | does what it did, by reporting those lines |

### Changed: `apps/web/src/lib/health.ts`

| Export | Shape |
| --- | --- |
| `ReadinessInputs.startProblems` | new and required: the lines the `start` check reports |
| `computeReadiness(env, provider, inputs, now?)` | adds the `start` check, last |

### Changed: `apps/web/src/lib/readiness.ts`

| Export | Shape |
| --- | --- |
| `buildReadiness()` | gives `computeReadiness` the lines of `webStartProblems`, and logs them when there are any |
