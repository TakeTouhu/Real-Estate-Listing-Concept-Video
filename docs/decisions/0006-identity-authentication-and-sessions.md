# ADR-0006: Identity, authentication, and sessions

- Status: Accepted
- Date: 2026-07-27
- Phase: 1
- Supersedes: ADR-0004 (interim Phase 0 operator-token auth) for end-user access

## Context

Phase 1 requires real users, organizations, memberships, roles, invitations,
and an authentication/session implementation. `docs/DataModel.md` defines User,
Organization, Membership, Invitation, AuditLog — but does not specify how users
authenticate (no password/credential field) and lists email plus optional
Entra ID / Google.

## Decision

- **Authentication:** email + password. Passwords are hashed with scrypt and a
  per-password salt (`@app/shared` `hashPassword`/`verifyPassword`), no external
  dependency. A dedicated **`Credential`** table stores the hash, keyed by user.
- **Sessions:** server-side sessions in a `Session` table storing only a SHA-256
  hash of the raw session token. The web app stores the raw token in an
  HTTP-only, `SameSite=Lax`, `Secure`-in-production cookie. Lifetime is
  `USER_SESSION_TTL_SECONDS`.
- **RBAC:** roles OWNER / ADMIN / CREATOR / REVIEWER with a static permission
  map (`org:manage`, `member:read`, `member:manage`, `property:write`,
  `video:review`). Organization scope is resolved from the session + membership
  on every request via `authorizeOrganization`.
- **Invitations:** token-based; only the token hash is stored; invitations
  expire and are single-use.
- **Last-owner protection:** an organization cannot lose or demote its last
  OWNER.
- The infrastructure readiness probe (`/api/health/ready`) keeps its own
  operator token; that is an ops concern, separate from end-user auth.

## Consequences

- The `Credential` table is an addition not present in `docs/DataModel.md`;
  tracked in `docs/decisions/TODO.md` for reconciliation.
- OAuth providers (Entra ID / Google) and MFA are deferred; the port-based
  design lets them be added without changing call sites.
- Login uses a constant-time-ish path (always runs a verify) to reduce user
  enumeration; error messages are generic.
