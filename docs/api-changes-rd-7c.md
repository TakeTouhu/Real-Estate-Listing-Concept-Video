# API Changes — RD-7c

Rate-limit settings, the client address and the subject key (ADR-0170).
**No migration, no route, no page and no dependency.** The schema checks
the settings, and nothing limits anything yet: RD-7d limits sign-in and
wrong MFA codes, RD-7e the reset and verification emails.

## HTTP

No change.

## Environment

| Setting | Taken | Default |
| --- | --- | --- |
| `RATE_LIMIT_SIGN_IN` | `count/seconds`: 1 to 99999 hits in 1 to 999999 seconds | `5/900` |
| `RATE_LIMIT_MFA_CODE` | the same | `5/900` |
| `RATE_LIMIT_PASSWORD_RESET_EMAIL` | the same | `3/3600` |
| `RATE_LIMIT_PASSWORD_RESET_EMAIL_PER_IP` | the same | `20/3600` |
| `RATE_LIMIT_VERIFICATION_EMAIL` | the same | `3/3600` |
| `FORWARDED_FOR_TRUSTED_ENTRIES` | `1` to `5`, kept as text | none: no key by client address; a production start of the web app refuses without it |

`SESSION_SECRET` is unchanged in form; it now keys the limits' subjects,
and changing it only starts every count afresh. Raising a limit's window
lets later hits delete some counters the new value would still count;
lowering it deletes nothing early.

## Internal API

| Change | Where |
| --- | --- |
| `serverEnvSchema` and `ServerEnv` gain the six settings | `@app/shared` `env.ts` |
| New: `RATE_LIMIT_SETTINGS`, `RateLimitSetting`, `RATE_LIMIT_DEFAULTS`, `isRateLimitValue` | `@app/shared` `env.ts` |
| New: `rateLimitSubjectKey(sessionSecret)`, `rateLimitSubject(key, family, value)`, `RateLimitSubjectFamily` | `@app/shared` `rate-limit-subject.ts` |
| New: `RATE_LIMIT_COOLDOWN`, `RATE_LIMIT_POLICY_NAMES`, `RateLimitPolicyName`, `rateLimitPolicies(settings)`, `RateLimitPolicies` | `@app/domain` `rate-limit/policies.ts` |
| New: `clientAddressKey(headers, trustedEntries)`, `ClientAddress`, `ClientAddressUnavailable` | `apps/web/src/lib/client-address.ts` |
| The production start check requires `FORWARDED_FOR_TRUSTED_ENTRIES` | `apps/web/src/lib/startup.ts` |
| `e2eEnvironment` refuses the five limits and `FORWARDED_FOR_TRUSTED_ENTRIES` | `tests/e2e/support/environment.ts` |

Unchanged: the store's port, both stores, every route and the worker.
Readiness gives the start check's new line as it gives the others.

## Tests and CI

No suite added or changed in what it runs; `tests/README.md` is
unchanged. `SecurityCompliance.md` and `SaaSOperations.md`: Not
applicable; nothing is limited until RD-7d.
