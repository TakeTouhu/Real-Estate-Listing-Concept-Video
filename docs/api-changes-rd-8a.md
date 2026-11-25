# API Changes — RD-8a

Sign-up is limited per client address and never shows a limiter's own
error text; sign-in and its code step no longer show it (ADR-0173).
**No migration and no dependency; one new optional setting.** ADR-0173 also
decides the rest of RD-8, which RD-8b to RD-8g build.

## HTTP

| Route | Change |
| --- | --- |
| `POST /api/auth/register` | Counted per client address, where `FORWARDED_FOR_TRUSTED_ENTRIES` gives one, before the form is read. The 61st sign-up from one client address within the hour, by default, failed ones included, answers 303 to `/login?error=Too many sign-ups. Try again in N minutes.` and makes no account, sign-in or email. Without a client address nothing is counted. A limiter error answers `/login?error=Registration failed`. |
| `POST /api/auth/login` | A limiter error that is an application error now answers "Sign in failed", as any other limiter error did, never its own text. |
| `POST /api/auth/mfa` | The same: such a limiter error answers `/login/mfa?error=Sign in failed`. |

N is the wait in whole minutes, rounded up, at least 1.

## Pages

None changed: `/login` shows `?error=` as before.

## Environment

| Setting | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_SIGN_UP_PER_IP` | `60/3600` | Sign-ups per client address, `count/seconds`, checked as the other limits are (ADR-0170) |

The browser test refuses it from the shell, as it does every limit.

## Internal API

| Change | Where |
| --- | --- |
| New: `WebRateLimits.signUp(headers, now)`, `LimitedRequest`, `withoutLimiterText`; `RateLimitedAction` gains `SIGN_UP` | `apps/web/src/lib/rate-limit.ts` |
| New policy `sign-up.client` in `RATE_LIMIT_POLICY_NAMES` and `rateLimitPolicies` | `@app/domain` `rate-limit/policies.ts` |
| New setting in `RATE_LIMIT_SETTINGS`, `RATE_LIMIT_DEFAULTS` and the schema | `@app/shared` `env.ts` |

## Logs

`warn` `{ code: "RATE_LIMITED", action: "SIGN_UP", dimension: "client" }`
per refusal. It names no address, IP, subject or user. Refusals are not
audited.

## Tests and CI

No suite added. `tests/api/email-verification-routes.test.ts` and
`tests/api/mfa-routes.test.ts` gain the sign-up limit and the failure
text of sign-in and its code step.
