# API Changes — RD-8c

Invitations are limited per inviting account (ADR-0173). **No migration
and no dependency; one new optional setting.**

## HTTP

| Route | Change |
| --- | --- |
| `POST /api/organizations/{organizationId}/invitations` | Counted per signed-in account after the same-origin, session and role checks, before the membership service. The 51st invitation of one account within the day, by default, failed ones included, answers 303 to the members page with `?error=limited&retry=N`, N the whole minutes to wait, and keeps no invitation and sends no email. A limiter error answers `?error=unavailable` and keeps and sends nothing. |

A form with a role no member can hold answers `?error=role`, as before,
and is not counted. A typed address is checked after the count, so a
typo counts. Never with `Retry-After` (ADR-0173 Decision 7).

## Pages

| Page | Change |
| --- | --- |
| `/organizations/{organizationId}/members` | `?error=limited` reads "Too many invitations. Try again in N minutes.", or "in N hours." above 120 minutes, rounded up, from `?retry=` of 1 to 99,999; without one in range, "Too many invitations. Try again later." |

## Environment

| Setting | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_INVITATION` | `50/86400` | Invitations per signed-in account, `count/seconds`, checked as the other limits are (ADR-0170) |

The browser test refuses it from the shell, as it does every limit.

## Internal API

| Change | Where |
| --- | --- |
| `RateLimitedAction` and `AccountAction` gain `INVITATION`; `refusalText` reads its waits above 120 minutes in hours | `apps/web/src/lib/rate-limit.ts` |
| New: `countInvitation`, `invitationFormRefusal`, `membersErrorText`; `MEMBERS_ERRORS.limited`; `MembersOutcome`'s error carries an optional `retry`, which `membersPage` sends as `?retry=` | `apps/web/src/lib/members.ts` |
| New policy `invitation.user` | `@app/domain` `rate-limit/policies.ts` |
| New setting in `RATE_LIMIT_SETTINGS`, `RATE_LIMIT_DEFAULTS` and the schema | `@app/shared` `env.ts` |

## Logs

`warn` `{ code: "RATE_LIMITED", action: "INVITATION", dimension: "user" }`
per refusal, and `error` "An invitation could not be counted" with its
error `code` when the limiter fails. Neither names an address, IP,
subject, user or invited address. Refusals are not audited.

## Tests and CI

`tests/api/invitation-routes.test.ts` runs the limits on the in-memory
store and gains the invitation limit; the members page's test gains the
`limited` text.

Not applicable: `docs/er-diagram.md` and `docs/DataModel.md` (no
migration), `CHANGELOG.md` (no RD pull request touches it).
