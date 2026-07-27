# ADR-0004: Interim authentication for the Phase 0 health-check app

- Status: Accepted (interim; superseded in Phase 1)
- Date: 2026-07-27
- Phase: 0

## Context

Phase 0 requires a *minimal authenticated* health-check application, but the
real identity system (users, organizations, memberships, sessions) is Phase 1
scope. We need authentication that is genuinely enforced without prematurely
building identity.

## Decision

- A single operator credential, `HEALTHCHECK_API_TOKEN`, is provided via
  server-side env.
- The authenticated readiness endpoint (`GET /api/health/ready`) requires
  `Authorization: Bearer <token>`, compared in constant time.
- The dashboard UI is gated by a signed, HTTP-only session cookie. The login
  route exchanges the operator token for a short-lived HMAC-signed session
  (`SESSION_SECRET`); the raw token is never stored in the cookie.
- The public liveness endpoint (`GET /api/health`) is unauthenticated and
  exposes no secrets.

## Consequences

- No user database is required in Phase 0.
- This mechanism is explicitly interim. Phase 1 replaces it with real
  authentication, RBAC (Owner/Admin/Creator/Reviewer), and organization-scoped
  sessions, at which point this ADR is superseded.
- Cookies are `secure` in production and `sameSite=lax`.
