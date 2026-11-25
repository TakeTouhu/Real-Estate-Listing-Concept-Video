# API Changes — RD-7a

The rule of the abuse limits (ADR-0169). **No migration, no route, no
page, no setting and no dependency.** Nothing builds a limiter yet; RD-7b
adds the PostgreSQL store, RD-7d and RD-7e the routes.

## HTTP

No change.

## Internal API

### New, from `@app/domain`

| Export | What it is |
| --- | --- |
| `RateLimitPolicy` | a limit: `name`, `limit`, `windowSeconds`, `cooldownBaseSeconds`, `cooldownMaxSeconds`, `decaySeconds` |
| `rateLimitPolicy(policy)` | the policy checked and frozen (with no cooldown, the cap and decay must be 0); refuses one out of range as `CONFIGURATION_ERROR`, "A rate-limit policy is out of range" |
| `checkRateLimitPolicy(policy)` | the same check, returning the policy itself; every store calls it before it writes |
| `checkRateLimitSubject(subject)` | refuses a subject that is not 64 lowercase hex characters as `INTERNAL_ERROR`, without repeating it |
| `RATE_LIMIT_POLICY_NAME`, `RATE_LIMIT_SUBJECT` | the patterns of a policy's name (dotted lowercase words, 64 characters at most) and of a subject |
| `RATE_LIMIT_MAX_LIMIT`, `RATE_LIMIT_MAX_SECONDS` | 99,999 hits; one year |
| `RateLimitDecision` | `{ allowed: true, windowStartedAt, count }` or `{ allowed: false, retryAt }` |
| `RateLimitStore` | the port: `hit(policy, subject, now)`, `giveBack(policy, subject, windowStartedAt)`, `forget(policy, subject)` |

### New, from `@app/domain/testing`

| Export | What it is |
| --- | --- |
| `InMemoryRateLimitStore` | the rule in memory |
| `RATE_LIMIT_CONTRACT_CASES`, `replayRateLimitContract(store, case)` | the twenty-two cases every store must pass, and their runner, which returns each step that decided otherwise |
| `RATE_LIMIT_CONTRACT_T0` and four contract policies | the cases' start time and policies |
