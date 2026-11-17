# API Changes — RD-2c

Readiness is limited by its clients' own settings (ADR-0153). **No
migration, no new route and no page.**

## HTTP

### `GET /api/health/ready` (operator bearer token)

The answer's shape and its checks are as in RD-2b. What changes is when it
answers:

- The `database` check asks a Prisma client of its own, with one connection
  and limits the client keeps: 3 seconds to open a connection, 3 for a
  query's answer and 4 to wait for the connection. Asked by one request at
  a time, a database that says nothing reads `503` after 3 or 4 seconds,
  where the request could wait without end (ADR-0153 Decision 1).
- Requests that arrive together take that one connection in turn. One that
  waits 4 seconds for it reads `503`, also when the database answers, only
  slowly. Of five at once to a database that said nothing, the last read
  `503` after 6 seconds.
- When the probe's own connection goes silent and the database still
  answers, readiness reads `503` until the client gives that connection up
  and opens another: about 20 seconds, measured with requests 8 or 9
  seconds apart. How long depends on how often readiness is asked, because
  the client tests a connection only when it is asked.
- The check answers for the database and no longer for the web app's own
  client. Readiness reads `200` where that client cannot read its address
  and the probe's can: an address that does not begin with `postgresql://`
  or `postgres://` as written (`P1012`), or whose own value for
  `connection_limit`, `connect_timeout`, `socket_timeout` or `pool_timeout`
  Prisma cannot read (`P1013`). Before RD-2c readiness asked that client.
  RD-2d is to decide where such an address is refused.
- The `storage` check keeps its adapter's limits. Neither development
  adapter asks over a network (Decision 2).

Each step has its own limit, so a probe that passed each just inside it
could take 10 seconds. Whatever asks still reads no answer within its own
limit as not ready.

`GET /api/health` is unchanged.

## Logs

The warning for a probe that did not answer is unchanged. A database that
says nothing is now logged by one of these codes:

| `code` | The probe's client gave up on |
| --- | --- |
| `P1001` | opening a connection |
| `P2010` | a query it had sent; Prisma's code for any raw query that failed |
| `P2024` | waiting for its one connection: another request held it, or the client tested it before using it and the database said nothing |

## Internal API

### Changed: `packages/database/src/client.ts`

| Export | Shape |
| --- | --- |
| `limitedDatabaseUrl(url, seconds)` | new: the address with `connection_limit=1`, `connect_timeout` and `socket_timeout` of `seconds` and `pool_timeout` one more; refuses seconds that are not a whole number of one or more (`RangeError`), and an address that is not a URL (`TypeError` with the code `ERR_INVALID_URL`, which carries no part of the address) |
| `getReadinessPrismaClient(url, seconds)` | new: the process's second Prisma client, made once for the limited address; a plain client when `url` is not given |

### Changed: `apps/web/src/lib/readiness.ts`

| Export | Shape |
| --- | --- |
| `READINESS_DATABASE_LIMIT_SECONDS` | new: `3` |
| `buildReadiness()` | asks the database through the probe's own client |
