# ADR-0151 — A production start, checked

Status: Accepted (RD-2a, 2026-11-16). The second milestone of production
readiness, part 1, which the product owner approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`; gap analysis
`docs/production-readiness-gap-analysis.md`). RD-2 is split in two for size:
this half checks the start, and RD-2b adds the database and the object
storage to readiness.

Builds on: ADR-0008 (the production guard), ADR-0065 Decision 14 (the MFA
key fails closed), ADR-0129 (emailed links start with `APP_BASE_URL`),
ADR-0150 (the web app's adapters chosen in one place; Decision 5 here refines
its Decision 1).

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
a `next start` is checked whatever `NODE_ENV` it is given. Any other start is
left alone: `next dev` and the browser test choose development adapters on
purpose.

A production start is refused when:

- the environment fails its schema;
- only one of the two `NODE_ENV` values says `production`;
- a port's chosen adapter is not one production may use (Decision 2);
- `DATABASE_URL`, `MFA_SECRET_KEY` or `APP_BASE_URL` is not set (Decision 3).

The two values must agree because each brings rules of its own. The schema's
production rules (an https `APP_BASE_URL`, no development folder) and the
session cookie's `Secure` follow the configured value; what Next.js built
follows the ambient one. Once production adapters exist, a production build
given `NODE_ENV=development` would otherwise start without the first. A
development server given `NODE_ENV=production` is refused the same way.
`next start` with no `NODE_ENV` is a production start: Next.js sets it to
`production`.

A refused start writes one message to standard error and ends the server's
process with exit code 1. Ending it matters: on Next.js 15.5 a server whose
`register()` throws keeps running and answers every request, liveness
included, with a 500. Under `next start` that is the command's own exit code.
`next dev` runs its server in a child process: the child ends with 1, and the
`next dev` command then ends with 0.

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

`next build` does not run `register()`: Next.js 15.5 skips the hook while
`NEXT_PHASE` names its build phase, which it sets for the build. A server
started with that value in its environment is skipped the same way and is not
checked. The hook adds no switch of its own, and such a start behaves as on
the base: each development adapter refuses production when first built.

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
start the check sees is refused (Decision 1 names the one it does not see). A
production start that would have failed at its first upload or sign-up now
fails at start. Nothing is deployed.

## Decision 3 — The settings a production start requires

- `DATABASE_URL`: every signed-in page and route reads the database.
- `MFA_SECRET_KEY`: without it no one who must use MFA can sign in (ADR-0065
  Decision 14). The product owner chose refusal at start on 2026-11-16, which
  settles item 6 of "Decide what MFA leaves open" in `docs/decisions/TODO.md`.
- `APP_BASE_URL`: every emailed link starts with it (ADR-0129), and without
  the verification link no one can use the product (ADR-0052 Decision 18).

The schema keeps all three optional: a build and a test run are given none of
them, and the worker has no use for the key or the address. The video
provider is not checked: generation start is built only for the test provider
outside production (ADR-0111), and paid activation stays BLOCKED (ADR-0054
Decision 7).

## Decision 4 — The worker is checked with its runtime

The worker's start file runs a provider self-check and exits; it has no
production runtime yet (ADR-0106 to ADR-0108). Its start is checked when that
runtime is assembled, in part 2 of the plan.

## Decision 5 — The start check loads no adapter

`next dev` builds `instrumentation.ts` for the edge runtime as well as for
Node.js, and the edge build cannot bundle sharp. `register()` therefore
imports the check inside its test of the runtime, as Next.js documents, so
only the Node.js build carries it.

The check also reads the choice without loading an adapter.
`WebAdapterChoice` and `chooseWebAdapters` move from `adapters.ts` to
`apps/web/src/lib/adapter-choice.ts`, which imports no adapter; `adapters.ts`
builds what it chooses. This refines ADR-0150 Decision 1, which kept the
choice and the construction in one module. Left there, the hook would load
every adapter's code before it could refuse: sharp today, and the Google
Cloud Storage, ClamAV and SMTP clients after RD-3, RD-5 and RD-6. A package
that failed to load would leave the server answering 500, which Decision 1
exists to end. Under `next dev` the hook's build falls from 1,092 modules to
45. `startup.test.ts` follows every import from the hook and holds it to the
check, the choice and the environment, and to no package but `@app/shared`.

## Consequences

- New: `apps/web/src/instrumentation.ts`, `apps/web/src/lib/startup.ts` and
  their tests; `apps/web/src/lib/adapter-choice.ts`, moved out of
  `adapters.ts` unchanged.
- The start check is the third web module to name `MFA_SECRET_KEY`, after
  the MFA service and readiness; `mfa-shape.test.ts` holds it to asking only
  whether the key is set.
- No route, page, permission, migration or audit action changes.
- `docs/decisions/TODO.md`: the boot-time validation entry is done for the
  web app, and MFA item 6 is settled.
- A production build cannot be started with `NODE_ENV=test` or
  `development` (Decision 1). RD-11's production-mode test therefore runs
  with `NODE_ENV=production` and the schema's production rules: an https
  `APP_BASE_URL`, hence https emailed links, while `next start` itself
  serves http. RD-11 decides how its test follows those links.
- Readiness of the database and the object storage follows in RD-2b.
