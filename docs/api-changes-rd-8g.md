# API Changes — RD-8g

Unit purchase approvals are limited per account (ADR-0173), and the
records that close RD-8. **No migration and no dependency; one new
optional setting.**

## HTTP

| Route | Change |
| --- | --- |
| `POST /api/organizations/{organizationId}/unit-purchases` | Counted per signed-in account after the same-origin, session and form checks, before the purchase service, so before `billing.manage` is checked. The 11th approval of one account within the hour, by default, failed and refused ones included, answers 303 to the buy page with `?error=` "Too many purchase approvals. Nothing new was bought. Try again in N minutes.", and buys nothing and writes no audit. A limiter error answers the buy page's own failure text, "The purchase could not be confirmed. Check the Units page before trying again.", and buys nothing. A body that is not a form now answers 303 to the buy page with the existing unreadable text, where it failed with a 500. |

The wait reads "in N hours." above 120 minutes, rounded up. The refusal
never carries `Retry-After` (ADR-0173 Decision 7). A post from another
origin, a signed-out visitor and a form the route cannot use are
answered before the count and are not counted. A member without
`billing.manage` is counted, so the refusals the service audits are
bounded per account. A replay of an approved purchase is counted too;
nothing gives a hit back. The buy page already shows `?error=` as text,
so no page changes.

## Environment

| Setting | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_UNIT_PURCHASE` | `10/3600` | Unit purchase approvals per signed-in account, `count/seconds`, checked as the other limits are (ADR-0170) |

The browser test refuses it from the shell, as it does every limit; no
browser test buys Units.

## Internal API

| Change | Where |
| --- | --- |
| `RateLimitedAction` and `AccountAction` gain `UNIT_PURCHASE`; `refusalText` reads its waits above 120 minutes in hours | `apps/web/src/lib/rate-limit.ts` |
| New: `countUnitPurchase`, `getUnitPurchaseLogger` | `apps/web/src/lib/unit-purchases.ts` |
| New: `PURCHASE_NOT_CONFIRMED`, the text `failureMessage` already answered by default | `apps/web/src/lib/unit-purchase-form.ts` |
| New policy `unit-purchase.user` | `@app/domain` `rate-limit/policies.ts` |
| New setting in `RATE_LIMIT_SETTINGS`, `RATE_LIMIT_DEFAULTS` and the schema | `@app/shared` `env.ts` |

## Logs

`warn` `{ code: "RATE_LIMITED", action: "UNIT_PURCHASE", dimension:
"user" }` per refusal, and `error` "A purchase approval could not be
counted" with its error `code` when the limiter fails or cannot be
built. Neither names an address, IP, subject, user, organization or key.
Refusals by the limit are not audited.

## Tests and CI

A new `tests/api/unit-purchase-routes.test.ts` runs the route over the
in-memory purchase service with the limits on the in-memory store: a
refusal past a small limit that asks the service nothing, buys nothing
and audits nothing; a wait that is not whole minutes rounded up; a count
per account; a member without `billing.manage` counted before the
permission is checked; no count before the origin, the session and the
form; and a limiter that fails, or cannot be built, closed with the
page's own text. `buy-page.test.tsx` runs the limits on the in-memory
store. No database test posts to the route; the purchase service's own
database suites are unchanged.

## Records closing RD-8

`docs/decisions/TODO.md`: the rate-limiting entry is flipped, the
values entry is amended so the seven RD-8 settings join it, and "Open
in RD-8" gains no organization key, the routes not limited by name and
the start form's size.
`docs/SecurityCompliance.md` and
`docs/production-readiness-gap-analysis.md` say what RD-8 limits.

Not applicable: `docs/er-diagram.md` and `docs/DataModel.md` (no
migration), `CHANGELOG.md` (no RD pull request touches it).
