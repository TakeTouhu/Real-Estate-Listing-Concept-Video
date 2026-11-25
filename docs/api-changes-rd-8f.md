# API Changes — RD-8f

Video starts are limited per account (ADR-0173). **No migration and no
dependency; one new optional setting.**

## HTTP

| Route | Change |
| --- | --- |
| `POST /api/video-projects/{projectId}/generations` | Counted per signed-in account after the 404 check, the same-origin, session and form checks, before the start service. The 31st start of one account within the hour, by default, failed and refused ones included, answers 303 to the start page with `?error=` "Too many video starts. Nothing new was started. Try again in N minutes.", and reserves no Unit and writes no job. A limiter error answers the start page's own failure text, "The start could not be confirmed. Review it and try again: a video already started is not started twice.", and reserves nothing. |

The wait reads "in N hours." above 120 minutes, rounded up. The refusal
never carries `Retry-After` (ADR-0173 Decision 7). Outside development
with the test provider the route still answers 404 before anything is
read, and counts nothing. A form the route cannot read, or one that
names no Property or project, is answered before the count and is not
counted. A replay of a started start is counted too; nothing gives a hit
back. The start page already shows `?error=` as text, so no page
changes.

## Environment

| Setting | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_GENERATION_START` | `30/3600` | Video starts per signed-in account, `count/seconds`, checked as the other limits are (ADR-0170) |

The browser test refuses it from the shell, as it does every limit.

## Internal API

| Change | Where |
| --- | --- |
| `RateLimitedAction` and `AccountAction` gain `GENERATION_START`; `refusalText` reads its waits above 120 minutes in hours | `apps/web/src/lib/rate-limit.ts` |
| New: `countGenerationStart`, `getGenerationStartLogger` | `apps/web/src/lib/generation-start.ts` |
| New: `START_NOT_CONFIRMED`, the text `failureMessage` already answered by default | `apps/web/src/lib/generation-start-form.ts` |
| New policy `generation-start.user` | `@app/domain` `rate-limit/policies.ts` |
| New setting in `RATE_LIMIT_SETTINGS`, `RATE_LIMIT_DEFAULTS` and the schema | `@app/shared` `env.ts` |

## Logs

`warn` `{ code: "RATE_LIMITED", action: "GENERATION_START", dimension:
"user" }` per refusal, and `error` "A start could not be counted" with
its error `code` when the limiter fails. Neither names an address, IP,
subject, user, project, organization or key. Refusals are not audited.

## Tests and CI

`tests/api/generation-start-routes.test.ts` runs the limits on the
in-memory store and gains the start limit: a refusal past a small
limit that asks the start service nothing, a count per account, no
count before the 404 check, the origin, the session and the form, and a
limiter that fails closed with the page's own text.
`tests/integration/generation-start-route.db.test.ts` runs the limits on
the in-memory store, so no count is left in the database, and gains a
refusal and a failing limiter that write no job, reservation,
allocation, Unit period or start audit.

Not applicable: `docs/er-diagram.md` and `docs/DataModel.md` (no
migration), `CHANGELOG.md` (no RD pull request touches it).
