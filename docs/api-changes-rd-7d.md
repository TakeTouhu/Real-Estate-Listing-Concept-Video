# API Changes — RD-7d

Sign-in and wrong MFA codes are limited (ADR-0171). **No migration, no
setting, no page and no dependency.** RD-7e limits the reset and
verification emails.

## HTTP

| Route | Change |
| --- | --- |
| `POST /api/auth/login` | Counted per client address, when the request has one, and per typed address, before the lookup. The sixth attempt within a window, by default, answers 303 to `/login?error=Too many sign-in attempts. Try again in N minutes.` and sets no cookie. A right password forgets the address and gives back the client address's count. A limiter error answers as any error: `/login?error=Sign in failed`. |
| `POST /api/auth/mfa` | Counted per user before the code is checked. The sixth wrong code within a window, across sign-ins, answers 303 to `/login/mfa?error=Too many wrong codes. Try again in N minutes.`, keeping the sign-in and its own count. An accepted code forgets the count. A limiter error answers `/login/mfa?error=Sign in failed`; when only the forget after an accepted code fails, the sign-in has passed and the page sends the person on. |

N is the wait in whole minutes, rounded up, at least 1 ("1 minute"). No
429 and no `Retry-After`. `/api/mfa/disable` and
`/api/mfa/setup/confirm` are not limited.

## Environment

No new setting. `RATE_LIMIT_SIGN_IN`, `RATE_LIMIT_MFA_CODE` and
`FORWARDED_FOR_TRUSTED_ENTRIES` (ADR-0170) now take effect, and
`SESSION_SECRET` now keys the subjects. The limiter connects with
`DATABASE_URL`, at most 3 connections and a statement limit of 1 s.

## Internal API

| Change | Where |
| --- | --- |
| New export: `RateLimiter`, `RateLimitKey`, `RateLimitHit`, `RateLimiterDecision` | `@app/domain` `rate-limit/limiter.ts` |
| New: `statementLimitedDatabaseUrl(url, connections, statementMilliseconds)`, `getRateLimitPrismaClient(url)` | `@app/database` `client.ts` |
| New: `getRateLimiter()`, `WebRateLimits`, `refusalMinutes`, `refusalMessage`, `RATE_LIMIT_DATABASE_CONNECTIONS`, `RATE_LIMIT_STATEMENT_MILLISECONDS` | `apps/web/src/lib/rate-limit.ts` |
| The sign-in and code routes hit the limiter | `apps/web/src/app/api/auth/{login,mfa}/route.ts` |

Unchanged: `AuthService`, `MfaService`, the store's port, both stores,
the start check, readiness and the worker.

## Logs

`warn` `{ code: "RATE_LIMITED", action: "SIGN_IN" | "MFA_CODE",
dimension: "address" | "client" | "user" }` per refusal, and `{ code:
"CLIENT_ADDRESS_UNAVAILABLE", reason }` for a request with no client
address while the setting is set. Neither names an address, an IP, a
subject or a user. Refusals are not audited.

## Tests and CI

No suite added. The four route test files that import these routes
replace `@/lib/rate-limit`'s limiter with one on the in-memory store,
made afresh for each test. `SecurityCompliance.md`: RD-7e.
