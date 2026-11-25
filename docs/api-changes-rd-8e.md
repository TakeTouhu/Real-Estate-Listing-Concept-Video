# API Changes — RD-8e

Downloads are limited per account (ADR-0173). **No migration and no
dependency; one new optional setting.**

## HTTP

| Route | Change |
| --- | --- |
| `POST /api/video-projects/{projectId}/download` | Counted per signed-in account after the same-origin, session and form checks, before the download service. The 61st download of one account within the hour, by default, video downloads and photo links together, failed ones included, answers 303 to the project page with `?download=limited&retry=N`, N the whole minutes to wait, and signs and audits no link. A limiter error answers `?download=failed` and signs and audits nothing. |
| `GET /api/assets/{assetId}/download-url` | The same count, after the session and `organizationId` checks, before the asset service. A refusal answers 429 as RD-8b's routes do, and signs and audits no link. A limiter error answers the route's 500 envelope, "Unexpected error". |

The 429 body is the existing envelope, `details` holding
`retryAfterSeconds` alone; its message reads "Too many downloads. Try
again in N minutes.", or "in N hours." above 120 minutes, rounded up.
The video refusal never carries `Retry-After` (ADR-0173 Decision 7). A
video out of reach or not delivered is counted too. The count is in the
routes, never in `createDownloadUrl`: page renders that sign thumbnails
or the video preview, and `GET /api/storage/download`, are not counted
(ADR-0173 Decision 10). No page calls `download-url`, so no client
changes.

## Pages

| Page | Change |
| --- | --- |
| `/properties/{propertyId}/video-projects/{projectId}` | `?download=limited` reads "Too many downloads. Try again in N minutes.", or "in N hours." above 120 minutes, rounded up, from `?retry=` of 1 to 99,999; without one in range, "Too many downloads. Try again later." |

## Environment

| Setting | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_DOWNLOAD` | `60/3600` | Video downloads and photo download links per signed-in account, `count/seconds`, checked as the other limits are (ADR-0170) |

The browser test refuses it from the shell, as it does every limit.

## Internal API

| Change | Where |
| --- | --- |
| `RateLimitedAction` and `AccountAction` gain `DOWNLOAD`; `refusalText` reads its waits above 120 minutes in hours | `apps/web/src/lib/rate-limit.ts` |
| New: `countDownload`; `DOWNLOAD_NOTICES.limited`; `downloadNotice` takes the page's query whole, `?download=` and `?retry=`; `DownloadLanding`'s page answer carries an optional `retry`, which the route sends as `?retry=` | `apps/web/src/lib/video-download.ts` |
| New policy `download.user` | `@app/domain` `rate-limit/policies.ts` |
| New setting in `RATE_LIMIT_SETTINGS`, `RATE_LIMIT_DEFAULTS` and the schema | `@app/shared` `env.ts` |

## Logs

`warn` `{ code: "RATE_LIMITED", action: "DOWNLOAD", dimension: "user" }`
per refusal, and `error` "A download could not be counted" with its
error `code` when the limiter fails on a video download. Neither names
an address, IP, subject, user, project, photo, organization or link.
Refusals are not audited.

## Tests and CI

`tests/api/video-download-route.test.ts` runs the limits on the
in-memory store, with the photo route beside the video route, and gains
the download limit; `tests/api/property-reach-routes.test.ts` gains the
photo link's limit; `tests/integration/video-download-route.db.test.ts`
runs the limits on the in-memory store, so no count is left in the
database, and gains a refusal that audits no second link. The project
page's notices gain the `limited` text.

Not applicable: `docs/er-diagram.md` and `docs/DataModel.md` (no
migration), `CHANGELOG.md` (no RD pull request touches it).
