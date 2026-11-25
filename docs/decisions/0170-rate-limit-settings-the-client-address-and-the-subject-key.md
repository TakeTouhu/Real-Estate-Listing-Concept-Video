# ADR-0170 — Rate-limit settings, the client address and the subject key

Status: Accepted (RD-7c, 2026-11-25). The third part of the seventh
milestone of production readiness, part 1, which the product owner
approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`). It adds the
settings each limit is read from, the key a request's client address is
counted by and the subjects the store counts. Nothing uses them yet: RD-7d
adds the limiter that hits one attempt's keys and limits sign-in and wrong
MFA codes, RD-7e the reset and verification emails.

Builds on: ADR-0169 (the rule, the store's port and the subject's form),
ADR-0054 Decision 5 (rate limiting from a configurable starting point),
ADR-0151 Decision 3 (the settings a production start requires), ADR-0167
Decision 1 (settings as text with a check).

## Context

The approved defaults are 5 failed sign-ins per 15 minutes per account and
per IP, then a growing cooldown, and 3 reset or verification emails per
hour per address, as documented, configurable values. The reports in
`/mnt/project-files/cto/rd-7/` settle the rest (`decision.md` there):
`ip-and-http.md` §1.6 measured how a client address is read behind
Google's load balancer, which writes two entries of `X-Forwarded-For`, and
`ci-and-records.md` §2.1 measured that `z.coerce.number()` takes `1e2` and
`0x10`.

## Decision 1 — One setting per limit, `count/seconds`

| Setting | Default | Counts |
| --- | --- | --- |
| `RATE_LIMIT_SIGN_IN` | `5/900` | sign-in per typed address and per client address |
| `RATE_LIMIT_MFA_CODE` | `5/900` | wrong MFA codes per user |
| `RATE_LIMIT_PASSWORD_RESET_EMAIL` | `3/3600` | reset emails per address |
| `RATE_LIMIT_PASSWORD_RESET_EMAIL_PER_IP` | `20/3600` | reset emails per client address |
| `RATE_LIMIT_VERIFICATION_EMAIL` | `3/3600` | verification emails per address |

- Each takes `^[1-9][0-9]{0,4}/[1-9][0-9]{0,5}$`: 1 to 99,999 hits in 1
  to 999,999 seconds, as text. The bounds guard against a typo; they are
  not a policy. A refusal names the setting and the form, never the value.
- The schema applies the default, so a parsed environment holds all five.
- No limit can be turned off: no `0`, no `off`, no switch.
- `@app/shared` exports the names as `RATE_LIMIT_SETTINGS` and the
  defaults as `RATE_LIMIT_DEFAULTS`.
- The MFA value and the per-IP reset value are the CTO's; the others are
  the approved ones.
- Raising a window forgets some counters early: a row's expiry is worked
  out from the values in force when it was written, so another key's hit
  may delete a row the new values would still count (RD-7b). Lowering one
  deletes nothing early.

## Decision 2 — Six policies and one cooldown curve

`rateLimitPolicies` turns the five texts into six named, frozen policies:
`sign-in.address`, `sign-in.client`, `mfa-code.user`,
`password-reset-email.address`, `password-reset-email.client` and
`verification-email.address`. A text out of form is refused with the
policy check's own `CONFIGURATION_ERROR`.

The cooldown is a documented constant, `RATE_LIMIT_COOLDOWN`, not a
setting. Its base is the limit's window, it doubles, its cap is 3,600 s
and its level is forgotten 86,400 s after a cooldown ends. Sign-in, both
keys, and MFA codes have it; the emails have none and wait for their
window. A window longer than 3,600 s is the cap instead, since the policy
check requires a cap no smaller than its base.

## Decision 3 — `FORWARDED_FOR_TRUSTED_ENTRIES`

- How many entries at the right end of `X-Forwarded-For` our own
  infrastructure writes; the client is the left-most of them. Google's
  balancer alone writes two.
- `1` to `5`, as text. Unset, no limit is kept by client address.
- A production start of the web app requires it: it joins the list of
  ADR-0151 Decision 3, which is not edited. The value is measured at
  deployment, never guessed.

## Decision 4 — The client address

`clientAddressKey` reads only the entry the setting names:

- an IPv4 address as written: `v4:203.0.113.7`;
- an IPv4-mapped IPv6 address, dotted or in hex, as its IPv4 address;
- any other IPv6 address by its /64: `v6:2001:db8:aa:bb::/64`;
- anything else, such as a port, brackets, a zone, `unknown` or an empty
  entry, gives no key and a reason: `NOT_CONFIGURED`, `MISSING`,
  `SHORT_CHAIN` or `MALFORMED`.

No key is ever shared for want of an address: the reason is returned
instead. The function logs nothing; RD-7d logs the reason by code and
keeps the request's other keys.

## Decision 5 — The subject key

A subject is `HMAC-SHA-256(K, family ‖ NUL ‖ value)` in lowercase hex,
the family being `address`, `client` or `user`. K is
`HMAC-SHA-256(SESSION_SECRET, "vtavision rate-limit subject v1")`. No
production code read `SESSION_SECRET` before, so there is no new secret
and no new start-check entry. Changing it only starts every count afresh.

## Decision 6 — The browser test runs the defaults

`e2eEnvironment` refuses the five settings and
`FORWARDED_FOR_TRUSTED_ENTRIES` from the shell, so the browser test runs
the limits production starts with, and no client-address key.

## Considered and not done

- **A setting per number**, or the curve as settings. Eleven settings
  nobody can tune yet; the curve can join the sign-in setting later.
- **Constants only.** "Every limit is configurable" would not hold.
- **Coerced numbers.** `1e9` would switch a limit off unnoticed.
- **A new secret for the subjects.** One more secret to deploy, for no
  gain over a derived key.
- **"Hops" or "proxies".** One balancer writes two entries.
- **IPv6 by /56, or as a setting.** It would merge more people under the
  strict sign-in value; a setting can come with measurement.
- **Refusing a request with no client address, or pooling them.** A bad
  value would lock everyone out; a pool is one bucket an attacker fills.

## What was measured

`packages/shared/src/env.test.ts` takes the defaults and values in
range, and refuses each setting's out-of-form values by one line that
repeats no value. `apps/web/src/lib/client-address.test.ts` runs every
case of `ip-and-http.md` §1.6 and more. `rate-limit-subject.test.ts`
checks the HMACs. `policies.test.ts` builds the six policies from the
defaults and from values in range, and refuses texts out of form. The
start check's and the browser test's tests pin the
new setting.

## Consequences

- `@app/shared` exports `RATE_LIMIT_SETTINGS`, `RATE_LIMIT_DEFAULTS`,
  `isRateLimitValue`, `rateLimitSubjectKey` and `rateLimitSubject`;
  `@app/domain` exports `RATE_LIMIT_COOLDOWN`, `RATE_LIMIT_POLICY_NAMES`
  and `rateLimitPolicies`.
- A production start of the web app now needs
  `FORWARDED_FOR_TRUSTED_ENTRIES`, so RD-11's production-mode test must
  set it (1 for a local start with no proxy). No migration, route, page
  or dependency; nothing is limited yet.
