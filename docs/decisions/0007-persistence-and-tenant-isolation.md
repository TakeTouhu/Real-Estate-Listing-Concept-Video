# ADR-0007: Persistence with Prisma and tenant-isolation strategy

- Status: Accepted
- Date: 2026-07-27
- Phase: 1

## Context

Phase 1 introduces PostgreSQL + Prisma and requires that cross-tenant access is
denied by automated tests and that all writes produce audit events — while the
required CI checks (typecheck/lint/test/build) must run without a live database.

## Decision

- **Ports and adapters.** The domain (`@app/domain`) defines repository *ports*
  and pure services. `@app/database` provides Prisma-backed adapters;
  `@app/domain/testing` provides in-memory adapters. Services depend only on the
  ports, plus injected `Clock`, `IdGenerator`, `PasswordHasher`, and
  `TokenService`.
- **Tenant isolation is enforced in the data-access + authorization layer.**
  Organization-scoped reads/writes always take an `organizationId`, and
  `authorizeOrganization` denies (FORBIDDEN) when the user has no membership or
  lacks the required permission. Storage keys will be organization-prefixed in
  later phases.
- **Testing without a DB.** Tenant-isolation and audit tests run against the
  in-memory adapters, so they are deterministic and require no database. The
  Prisma adapters are covered by typecheck/build and are exercised at runtime.
- **Schema/ids.** PostgreSQL is the system of record. Public ids are
  application-generated (`usr_`, `org_`, `inv_`, `ses_`); `AuditLog` ids use a
  database default. An initial SQL migration is committed under
  `packages/database/prisma/migrations`.
- **Client generation.** `prisma generate` runs on install (workspace
  `postinstall`) and as an explicit CI step; `@prisma/client` is marked as a
  Next `serverExternalPackages` entry so it is not bundled.

## Consequences

- The required checks stay DB-free and fast; correctness of tenant isolation is
  proven at the service layer.
- A live-Postgres integration test job (`services: postgres` + `prisma migrate
  deploy`) is a follow-up (`docs/decisions/TODO.md`).
- Swapping persistence or adding a provider means implementing the ports again;
  no service or web code changes.
