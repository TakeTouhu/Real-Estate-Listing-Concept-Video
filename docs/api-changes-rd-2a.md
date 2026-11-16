# API Changes — RD-2a

A production start of the web app is checked (ADR-0151). **No migration, no
new route and no page.**

## HTTP

No change. Every route and page answers as before.

## Start

A production start (`next start`) ends with exit code 1 and one message on
standard error when the environment is invalid, `NODE_ENV` is set to anything
but `production`, a port's adapter is not one production may use, or
`DATABASE_URL`, `MFA_SECRET_KEY` or `APP_BASE_URL` is not set:

```text
The web app cannot start in production:
  - object storage: "memory" is not a production adapter
  - malware scanning: "passthrough" is not a production adapter
  - email: none is configured, so sign-up cannot send its verification link
  - MFA_SECRET_KEY is not set
```

No production adapter exists for object storage, malware scanning or email
until RD-3, RD-5 and RD-6, so no production start passes the check yet.
`next build` runs no check, and neither does a server started with
`NEXT_PHASE=phase-production-build` in its environment: Next.js skips its
start hook in its build phase (ADR-0151 Decision 1). `next dev` and the
browser test are left alone, as neither `NODE_ENV` value says `production`
there. A development server given `NODE_ENV=production` is refused: its
server process ends with exit code 1, and the `next dev` command with 0.

## Internal API

### Added: `apps/web/src/lib/startup.ts`

| Export | Shape |
| --- | --- |
| `ProductionAdapters` | for every port of `WebAdapterChoice`, the adapters a production start may choose |
| `PRODUCTION_ADAPTERS` | today's list: `deterministic` image analysis and `offline` prompt moderation; none yet for storage, malware scanning or email |
| `productionStartProblems(env, allowed?)` | every adapter and setting problem of a production start, one line each; empty when it may start |
| `WebStart` | what a start check reads and how a refused start ends: `loadEnv()`, `allowed`, `report(message)`, `exit(code)` |
| `checkWebStart(start?)` | when the ambient or the configured `NODE_ENV` is `production`: reports and ends a start that has any problem, or that only one of the two calls production |

### Moved: `apps/web/src/lib/adapter-choice.ts`

`WebAdapterChoice` and `chooseWebAdapters`, unchanged, from
`apps/web/src/lib/adapters.ts`: the start check reads the choice without
loading an adapter (ADR-0151 Decision 5).

### Added: `apps/web/src/instrumentation.ts`

`register()`, which Next.js runs once as the server starts: `checkWebStart()`
in the Node.js runtime. `next build` does not run it.
