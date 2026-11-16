# ADR-0151 — A production start, checked

Status: Accepted (RD-2a, 2026-11-16). The second milestone of production
readiness, part 1, which the product owner approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`; gap analysis
`docs/production-readiness-gap-analysis.md`). RD-2 is split in two for size:
this half checks the start, and RD-2b adds the database and the object
storage to readiness.

Builds on: ADR-0008 (the production guard), ADR-0065 Decision 14 (the MFA
key fails closed), ADR-0129 (emailed links start with `APP_BASE_URL`),
ADR-0150 (the web app's adapters chosen in one place).

## Context

On the base, a production build of the web app starts whatever its
configuration. Its environment is read at the first request that needs it,
each development adapter refuses production only when first built, and
`MFA_SECRET_KEY` is optional, so a misconfiguration surfaces only as a failed
request.

The plan the product owner approved checks the whole set when a production
build starts, and refuses to start when anything is missing or is a
development adapter. Its third default, approved with it, is that a production
build refuses to start without `MFA_SECRET_KEY`.

## Decision 1 — A production start is checked once, and ended if it cannot serve

`apps/web/src/instrumentation.ts` exports `register()`, which Next.js runs
once as the server starts. In the Node.js runtime it calls `checkWebStart()`
(`apps/web/src/lib/startup.ts`).

A start is a production start when the ambient `NODE_ENV` or the configured
one says `production`: neither can vouch for the other (ADR-0150 Decision 2).
`next build` fixes the ambient value at `production` in the app it builds, so
every `next start` is checked, whatever its environment says. Any other start
is left alone: `next dev` and the browser test choose development adapters on
purpose.

A production start is refused when:

- the environment fails its schema;
- a port's chosen adapter is not one production may use (Decision 2);
- `DATABASE_URL`, `MFA_SECRET_KEY` or `APP_BASE_URL` is not set (Decision 3).

A refused start writes one message to standard error and ends the process
with exit code 1. Ending it matters: on Next.js 15.5 a server whose
`register()` throws keeps running and answers every request, liveness
included, with a 500.

The message lists every adapter and setting problem at once. When the
environment fails its schema, the message is the schema's instead; the
adapters and settings are checked once it passes, so such a start can take
more than one round to put right. No line carries a secret: an adapter is
named by its choice, a setting is asked only whether it is set, and the
schema's message repeats a value only for a setting that takes one of a
fixed list of words, such as `NODE_ENV` or `LOG_LEVEL`
(`packages/shared/src/env.test.ts`).

When the environment fails its schema and the ambient value is not
`production`, no configured value can be read. That start is left alone, and
the environment is reported where it is first read, as before.

`next build` does not run `register()` on Next.js 15.5. Were a later version
to, the check is skipped while `NEXT_PHASE` names the build, which serves
nothing and is given no production settings.

## Decision 2 — Production adapters are listed, port by port

`PRODUCTION_ADAPTERS` names, for every port of the web app's choice
(ADR-0150), the adapters a production start may run with. Its type requires
every port, and an adapter that is not listed is refused, so an adapter or a
port added later is refused until it is allowed there.

| Port | Allowed in production |
| --- | --- |
| Object storage | none yet (RD-3 adds Google Cloud Storage) |
| Malware scanning | none yet (RD-5 adds ClamAV) |
| Email | none yet (RD-6 adds SMTP); having no email adapter is refused too, since sign-up could not send its verification link |
| Image analysis | `deterministic` |
| Prompt moderation | `offline` |

The offline analysis and prompt moderation are allowed because no decision
keeps them out (ADR-0150 Decision 3).

Until RD-3, RD-5 and RD-6, then, no environment passes and every production
start is refused. A production start that would have failed at its first
upload or sign-up now fails at start. Nothing is deployed.

## Decision 3 — The settings a production start requires

- `DATABASE_URL`: every signed-in page and route reads the database.
- `MFA_SECRET_KEY`: without it no one who must use MFA can sign in (ADR-0065
  Decision 14). The product owner chose refusal at start on 2026-11-16, which
  settles item 6 of "Decide what MFA leaves open" in `docs/decisions/TODO.md`.
- `APP_BASE_URL`: every emailed link starts with it (ADR-0129), and without
  the verification link no one can use the product (ADR-0052 Decision 18).

The schema keeps all three optional, because the worker shares it and needs
none of them. The video provider is not checked: generation start is built
only for the test provider outside production (ADR-0111), and paid activation
stays BLOCKED (ADR-0054 Decision 7).

## Decision 4 — The worker is checked with its runtime

The worker's start file runs a provider self-check and exits; it has no
production runtime yet (ADR-0106 to ADR-0108). Its start is checked when that
runtime is assembled, in part 2 of the plan.

## Consequences

- New: `apps/web/src/instrumentation.ts`, `apps/web/src/lib/startup.ts` and
  their tests.
- The start check is the third web module to name `MFA_SECRET_KEY`, after
  the MFA service and readiness; `mfa-shape.test.ts` holds it to asking only
  whether the key is set.
- No route, page, permission, migration or audit action changes.
- `docs/decisions/TODO.md`: the boot-time validation entry is done for the
  web app, and MFA item 6 is settled.
- Readiness of the database and the object storage follows in RD-2b.
