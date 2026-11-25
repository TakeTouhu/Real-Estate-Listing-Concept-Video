# API Changes — RD-8d

Analyses are limited per account (ADR-0173). **No migration and no
dependency; one new optional setting.**

## HTTP

| Route | Change |
| --- | --- |
| `POST /api/properties/{propertyId}/assets/{assetId}/analysis` | Counted per signed-in account after the session and body checks, before the photo is looked up and before the service. The 301st analysis or refresh of one account within the hour, by default, failed ones included, answers 429 as RD-8b's routes do, and reads no photo and calls no analyzer. A limiter error answers the route's 500 envelope, "Unexpected error". |
| `POST /api/properties/{propertyId}/assets/{assetId}/analysis/refresh` | The same count and answers: analyses and refreshes share one limit. |

The 429 body is the existing envelope, `details` holding
`retryAfterSeconds` alone; its message reads "Too many analysis
requests. Try again in N minutes.", or "in N hours." above 120 minutes,
rounded up. A photo not found, a role that cannot analyze and a photo
already analyzed are counted too. The review decisions and corrections
are not counted. `GET .../analysis` is not counted.

## Pages

| Page | Change |
| --- | --- |
| `/properties/{propertyId}/review` | The analyze button stops its run at a refusal and shows its text once, as it does when signed out; the page is read again and the photos left stay offered. |

## Environment

| Setting | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_ANALYSIS` | `300/3600` | Analyses and refreshes per signed-in account, `count/seconds`, checked as the other limits are (ADR-0170) |

The browser test refuses it from the shell, as it does every limit.

## Internal API

| Change | Where |
| --- | --- |
| `RateLimitedAction` and `AccountAction` gain `ANALYSIS`; `refusalText` reads its waits above 120 minutes in hours | `apps/web/src/lib/rate-limit.ts` |
| `mapAnalysisError` shows a 429's own message, as it does a 422's | `apps/web/src/lib/analysis-errors.ts` |
| New policy `analysis.user` | `@app/domain` `rate-limit/policies.ts` |
| New setting in `RATE_LIMIT_SETTINGS`, `RATE_LIMIT_DEFAULTS` and the schema | `@app/shared` `env.ts` |

## Logs

`warn` `{ code: "RATE_LIMITED", action: "ANALYSIS", dimension: "user" }`
per refusal. It names no address, IP, subject, user, photo or
organization. Refusals are not audited.

## Tests and CI

`tests/api/analysis-routes.test.ts` and `tests/api/review-routes.test.ts`
run the limits on the in-memory store and gain the analysis limit; the
analyze button's and the error mapping's tests gain the refusal.

Not applicable: `docs/er-diagram.md` and `docs/DataModel.md` (no
migration), `CHANGELOG.md` (no RD pull request touches it).
