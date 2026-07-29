# ADR-0010: Organization context resolution

- Status: Accepted
- Date: 2026-07-29
- Phase: 3A-3

## Context

Every tenant-owned record is scoped to an organization, so every request that
touches one must resolve *which* organization it acts in. Two mechanisms are
possible:

1. **Session-derived** — the session carries an "active organization", and the
   server reads it from there. The client cannot name an organization at all.
2. **Caller-supplied and verified** — the request names the organization, and
   the server verifies the caller's membership before doing anything with it.

A user may belong to several organizations (an agency working for more than one
brokerage is the motivating case), and the session model implemented in Phase 1
carries only the user and the session itself: `getCurrentUser()` returns
`{ user, session }` with no active-organization field, and nothing in the schema
records one. Every tenant-scoped route shipped in Phases 1–2 —
`POST /api/organizations`, `POST /api/properties`,
`POST /api/properties/{id}/assets/upload-url`, the asset routes — therefore takes
`organizationId` from the request and verifies membership server-side.

The Phase 3A-3 plan initially assumed mechanism 1 ("the organization comes from
the session"). That assumption was wrong about this codebase, and the mismatch
surfaced during implementation.

## Decision

**Organization context is caller-supplied and server-verified (mechanism 2).**

- `organizationId` arrives in the JSON body for `POST`/`PUT`/`PATCH` requests
  and in the query string for `GET` requests.
- Route handlers validate only that the value is a plausibly-shaped string. They
  never decide whether the caller may use it.
- Every domain service calls `authorizeOrganization(deps, userId, organizationId,
  permission?)` before acting, which fails with `FORBIDDEN` when the user has no
  membership, and again when their role lacks the required permission.
- Independently, every repository read filters on `organizationId`, so a record
  belonging to another tenant is **not found** rather than merely refused.

The client-supplied value is therefore a *request parameter*, never a grant. It
selects among the organizations the caller already belongs to; it cannot create
access.

Tenant isolation continues to rest on two enforced layers — membership
authorization and organization-scoped data access — neither of which trusts the
supplied id. A forged or guessed `organizationId` yields `403`; a record in
another tenant yields `404`, so existence is not disclosed.

## Consequences

**Accepted:**

- One consistent convention across every tenant-scoped endpoint, from Phase 1
  through Phase 3A. No route resolves organization context a second way.
- Multi-organization users are supported without an "active organization"
  concept, session mutation on switching, or a re-login when acting elsewhere.
- Requests are stateless with respect to organization: the same call is
  reproducible from a script or a test without first establishing session state.
- Route handlers stay thin — resolving context is not a business decision they
  take.

**Costs and risks:**

- **Every endpoint must be tested for cross-tenant access**, because the id is
  attacker-controlled input. This is a standing requirement, not a one-off:
  each phase adds tenant-isolation tests asserting `403` for non-members and
  `404` for another tenant's record. Omitting them on a new endpoint is the
  realistic failure mode of this decision.
- Callers must know and pass the id, so clients carry it explicitly. The web UI
  holds it in page state rather than relying on ambient session state.
- The id appears in `GET` query strings, so it may be captured in access logs
  and browser history. It is an opaque, non-secret identifier that confers no
  access on its own, so this is acceptable — but it is a reason not to move
  anything *secret* into query parameters later.
- A missing `organizationId` is a client error (`422`) rather than something the
  server can infer, which is slightly less forgiving for hand-written requests.

**If this is ever revisited**, an active-organization concept would be a
cross-cutting identity change — a session column, a switch endpoint, updates to
every existing route, and a migration — not a per-endpoint choice. It should be
decided once, for all endpoints, and would supersede this ADR rather than
coexist with it.

## References

- ADR-0006 — identity, authentication, and sessions
- ADR-0007 — persistence and tenant isolation
- `docs/api-changes-phase-3a3.md` — where this convention is documented for the
  analysis endpoints
- `docs/SecurityCompliance.md` — tenant-isolation requirements
