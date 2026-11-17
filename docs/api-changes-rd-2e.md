# API Changes — RD-2e

Readiness asks the web app's own database client to connect (ADR-0155).
**No migration, no new route and no page.**

## HTTP

### `GET /api/health/ready` (operator bearer token)

The `database` check reads `answers` when the database answered the probe's
client and the web app's own client has connected in this process, and
`does not answer` otherwise. Before, it read `answers` whenever the database
answered the probe's client.

So an address in `DATABASE_URL` that the probe's client is answered with and
the web app's own client cannot read now reads `degraded` and `503`, where
it read `ready` and `200`: one that does not begin with `postgresql://` or
`postgres://` exactly as written, and one whose own value for
`connection_limit`, `connect_timeout`, `socket_timeout` or `pool_timeout`
Prisma cannot read.

The answer's shape, the five checks' names and words, and the route's
status codes are unchanged. `GET /api/health` is unchanged.

A process's first readiness request that finds the database answering also
opens the first connection of the web app's own client, which a request
opened before. Where that connection is not answered the request waits by
that client's own settings, 5 seconds by Prisma's defaults, and not by the
probe's 3 and 4 (ADR-0155 Decision 3).

## Logs

The warning for a probe that did not answer is unchanged in shape: `probe:
"database"` and `code`. It is now written too when the web app's own client
could not connect.

| `code` | Read as |
| --- | --- |
| `P1012`, `P1013` | Prisma cannot read an address: correct `DATABASE_URL` and restart. `P1012` with an address that is right as written: restart the process (ADR-0155 Decision 5) |
| `P1001`, `P2024`, `P2010` | the database did not answer in time |
| `P1000`, `P1003`, `P1010`, `P2037` | the database refused the connection |

## Internal API

### Changed: `apps/web/src/lib/readiness.ts`

| Export | Shape |
| --- | --- |
| `buildReadiness()` | its `database` probe asks `getPrismaClient()` to connect, once the probe's own client has connected and been answered |

`getPrismaClient` and `getReadinessPrismaClient`
(`packages/database/src/client.ts`) are unchanged.
