# API Changes — RD-8b

Uploads are limited per account, JSON refusals answer 429 with
`Retry-After`, and signed-in routes count on a limiter client of their
own (ADR-0173). **No migration and no dependency; one new optional
setting.**

## HTTP

| Route | Change |
| --- | --- |
| `POST /api/properties/{propertyId}/assets/upload-url` | Counted per signed-in account after the session and body checks, before the service. The 1,001st upload link, retry or check of one account within the day, by default, failed ones included, answers 429 (below) and issues no link, row or check. A limiter error answers the route's 500 envelope, "Unexpected error". |
| `POST /api/assets/{assetId}/retry` | The same count and answers. |
| `POST /api/assets/{assetId}/complete` | The same count and answers; a refused check reads no stored bytes. |
| Every JSON route | An application error `RATE_LIMITED` with a whole `details.retryAfterSeconds` of 1 or more answers 429 with `Retry-After: <seconds>` and `Cache-Control: no-store`. Only the web app's limits make one. |

The 429 body is the existing envelope, `details` holding
`retryAfterSeconds` alone; its message reads "Too many uploads. Try
again in N minutes.", or "in N hours." above 120 minutes, rounded up.
Sign-up's text reads in hours the same way; RD-7's keep minutes.

## Pages

| Page | Change |
| --- | --- |
| `/properties/{propertyId}` | The upload panel shows the refusal's text under the photo. After a refused check, Retry checks the stored bytes again without sending the file. |

## Environment

| Setting | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_UPLOAD` | `1000/86400` | Upload links, retries and checks per signed-in account, `count/seconds`, checked as the other limits are (ADR-0170) |

The browser test refuses it from the shell, as it does every limit. The
web app opens a second limiter database client, of up to 3 connections.

## Internal API

| Change | Where |
| --- | --- |
| New: `WebRateLimits.account(action, userId, now)`, its fourth constructor argument (the signed-in store), `signedInLimiter`, `limitJsonRequest`, `retryAfterSeconds`, `LimitedWork`, `AccountAction`; `RateLimitedAction` gains `UPLOAD`; `refusalText` reads waits above 120 minutes in hours for `SIGN_UP` and `UPLOAD` | `apps/web/src/lib/rate-limit.ts` |
| `appErrorToResponse` sets `Retry-After` and `Cache-Control: no-store` on a refusal | `apps/web/src/lib/http.ts` |
| New: `getSignedInRateLimitPrismaClient(url)` | `@app/database` `client.ts` |
| New policy `upload.user` | `@app/domain` `rate-limit/policies.ts` |
| New setting in `RATE_LIMIT_SETTINGS`, `RATE_LIMIT_DEFAULTS` and the schema | `@app/shared` `env.ts` |

## Logs

`warn` `{ code: "RATE_LIMITED", action: "UPLOAD", dimension: "user" }`
per refusal. It names no address, IP, subject or user. Refusals are not
audited.

## Tests and CI

Suites added: `apps/web/src/lib/http.test.ts`, with the guard that only
`rate-limit.ts` makes a `RATE_LIMITED` error (ADR-0173 Decision 7), and
`packages/shared/src/errors.test.ts`.
`tests/api/property-reach-routes.test.ts` runs the limits on the
in-memory store and gains the upload limit.

Not applicable: `docs/er-diagram.md` and `docs/DataModel.md` (no
migration), `CHANGELOG.md` (no RD pull request touches it).
