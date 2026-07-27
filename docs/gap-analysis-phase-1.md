# Phase 1 Gap Analysis

Version: 1.0
Status: Complete
Scope: Phase 1 — Identity, organizations, and tenant isolation (`docs/Roadmap.md`)

## Starting state (after Phase 0 merge)

- Monorepo, strict TypeScript, CI, provider abstraction (fake adapter), and a
  minimal authenticated health-check app were in place.
- No database, identity, organizations, or persistence layer.
- `WaveSpeedVideoProvider` was intentionally deferred to Phase 1.

## Requirement-by-requirement analysis

| Phase 1 requirement | Before | Delivered |
| --- | --- | --- |
| PostgreSQL + Prisma foundation | Missing | `packages/database`: Prisma schema, generated client factory, initial SQL migration |
| Users, organizations, memberships, roles, invitations | Missing | `packages/domain/identity`: entities, RBAC roles, services |
| Authentication / session implementation | Interim operator token | Email+password (scrypt) auth, DB-backed sessions, web login/register/logout (ADR-0006) |
| Organization-scoped repositories | Missing | Repository ports (domain) + Prisma adapters (database) + in-memory adapters (tests); scoping enforced in the data-access + authorization layer |
| Audit log foundation | Missing | `AuditLog` model + `recordAudit`; every identity/org write emits an audit event |
| Tenant-isolation tests | Missing | Automated tests: cross-tenant access denied; role-based denial; last-owner protection |
| Real `WaveSpeedVideoProvider` | Deferred | Implemented behind `VideoGenerationProvider` with injected HTTP client (offline tests); factory wiring |

## Completion criteria (Roadmap)

- **Cross-tenant access is denied by automated tests** — met
  (`packages/domain/src/identity/identity.test.ts`).
- **All writes produce required audit events** — met (asserted per service and
  via an exact audit-sequence test).

## Decisions taken

- Introduced a `Credential` table for email/password auth, which is not in
  `docs/DataModel.md`; recorded in ADR-0006 and `docs/decisions/TODO.md`.
- Persistence uses Prisma + PostgreSQL; domain depends on repository ports, so
  tenant-isolation and audit behaviour are tested with in-memory adapters and
  require no database (ADR-0007).

## Deferred to later phases

- OAuth providers (Entra ID / Google), MFA — later (ADR-0006).
- Live Postgres integration tests in CI (a `services: postgres` job running
  `prisma migrate deploy`) — follow-up; see `docs/decisions/TODO.md`.
- WaveSpeed webhook handler and polling worker — Phase 4.
- Properties, media, analysis, generation, billing — Phases 2–6.
