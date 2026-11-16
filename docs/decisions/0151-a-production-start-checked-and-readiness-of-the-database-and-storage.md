# ADR-0151 — A production start checked, and readiness of the database and storage

Status: Accepted (RD-2, 2026-11-16). The second milestone of production
readiness, part 1, which the product owner approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`; gap analysis
`docs/production-readiness-gap-analysis.md`).

Builds on: ADR-0008 (the production guard), ADR-0065 Decisions 14 and 17
(the MFA key fails closed; readiness reports it), ADR-0129 (emailed links
start with `APP_BASE_URL`), ADR-0150 (the web app's adapters chosen in one
place).

## Context

On the base, a production build of the web app starts whatever its
configuration. Its environment is read at the first request that needs it,
each development adapter refuses production only when first built, and
`MFA_SECRET_KEY` is optional, so a misconfiguration surfaces only as a failed
request. Readiness runs the provider self-check and reports the MFA key; it
asks neither the database nor the storage.

The plan the product owner approved checks the whole set when a production
build starts, and refuses to start when anything is missing or is a
development adapter. Its third default, approved with it, is that a production
build refuses to start without `MFA_SECRET_KEY`.

## Decision 1 — A production start is checked once, and ended if it cannot serve

`apps/web/src/instrumentation.ts` exports `register()`, which Next.js runs
once as the server starts. In the Node.js runtime it calls `checkWebStart()`
(`apps/web/src/lib/startup.ts`), which does nothing unless `NODE_ENV` is
`production`. A production start is refused when:

- the environment fails its schema;
- a port's chosen adapter is a development one, which refuses production
  when built: object storage in memory or in the shared folder, the test
  scanner, the email outbox;
- no email adapter is chosen, so sign-up cannot send its verification link;
- `DATABASE_URL`, `MFA_SECRET_KEY` or `APP_BASE_URL` is not set.

A refused start writes every reason to standard error in one message, which
names ports, adapters and settings and never a value, and ends the process
with exit code 1. Ending it matters: on Next.js 15.5 a server whose
`register()` throws keeps running and answers every request, liveness
included, with a 500. `next build` does not run `register()`, so the build is
unaffected; `next dev` and the browser test run outside production and are
not checked.

## Decision 2 — Until production adapters exist, every production start is refused

On the base no environment passes: object storage and malware scanning have
only development adapters, and email has none. RD-3, RD-5 and RD-6 add them.
A production start that would have failed at its first upload or sign-up
now fails at start. Nothing is deployed.

## Decision 3 — What a production start requires, and what it does not

- `DATABASE_URL`: every signed-in page and route reads the database.
- `MFA_SECRET_KEY`: without it no one who must use MFA can sign in (ADR-0065
  Decision 14). The product owner chose refusal at start on 2026-11-16, which
  settles item 6 of "Decide what MFA leaves open" in `docs/decisions/TODO.md`.
- `APP_BASE_URL`: every emailed link starts with it (ADR-0129), and without
  the verification link no one can use the product (ADR-0052 Decision 18).

The schema keeps all three optional, because the worker shares it and needs
none of them. The offline analysis and prompt moderation are not refused
(ADR-0150 Decision 3). The video provider is not checked: generation start is
built only for the test provider outside production (ADR-0111), and paid
activation stays BLOCKED (ADR-0054 Decision 7).

## Decision 4 — Readiness asks the database and the storage to answer

`GET /api/health/ready` gains two checks:

- `database`: the web app's Prisma client runs `SELECT 1`.
- `storage`: the chosen storage adapter is built and asked whether
  `readiness/probe`, a key nothing writes, holds an object.

Neither writes anything. Each reports whether it answered, and the storage
check names its adapter; neither reports what it threw, since an error can
name a host, a user or a path. Either failing makes the status `degraded`
and the probe answer `503`, as the provider and MFA checks do.

## Decision 5 — The worker is checked with its runtime

The worker's start file runs a provider self-check and exits; it has no
production runtime yet (ADR-0106 to ADR-0108). Its start is checked when that
runtime is assembled, in part 2 of the plan.

## Consequences

- New: `apps/web/src/instrumentation.ts`, `apps/web/src/lib/startup.ts` and
  its test, and the browser test `tests/e2e/readiness.spec.ts`, which reads
  readiness from the test's own database and shared folder.
- `computeReadiness` takes the probes, so its tests need no database.
- No route, page, permission, migration or audit action changes. The
  readiness response gains two checks.
- `docs/decisions/TODO.md`: the boot-time validation entry is done for the
  web app, and MFA item 6 is settled.
