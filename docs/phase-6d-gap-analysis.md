# Phase 6D gap analysis — individual permission grants and protected authority

Status: implementing on branch `claude/project-thread-az06z2`.
Base: `main @ 6f1aaafd81e2da786c9cee33ec2f386673d56379` (PR #76, Phase 6C, merged
2026-10-13; migration 19 is the latest).

Authority: ADR-0052 Decision 10 (*individual permissions*, *grant ceilings and
protected authority*, *no self-escalation past the ceiling*, *`disclosure.none` —
protected and individual-only*, *`property.create` capability ceiling*), ADR-0053
Decision 5A (`billing.manage` for an `ADMIN` only by explicit `OWNER` grant),
ADR-0057 (Phase 6C).

## Why this package is next

Phase 6C made a member's permissions exactly its role template's. ADR-0052
Decision 10 adds individual grants on top, and two later packages cannot exist
without them:

- An `ADMIN` holds `billing.manage` only through an explicit `OWNER` grant
  (ADR-0053 Decision 5A). Without grants, only `OWNER` and `BILLING` can ever
  buy Units.
- `disclosure.none` (Mode C) is carried by no template; it exists only as an
  `OWNER`-made individual grant.

Groups (6E) add a second grant source; one *effective permissions* function now
gives them a single place to extend.

## Gap

| Concern | Today (after Phase 6C) | ADR-0052 Decision 10 | Where |
| --- | --- | --- | --- |
| Grant record | none | a durable per-member grant | schema |
| Effective permissions | the template | template ∪ grants, with `property.create` never effective for `VIEWER` / `BILLING` | `roles.ts`, `authorization.ts` |
| Who may grant | — | `permission.manage` within the actor's ceiling | new service |
| Protected authority | — | `permission.manage`, `billing.manage`, `disclosure.none`: `OWNER`-only to grant **and** revoke | new service |
| Self-escalation by grant | — | refused, and audited | new service |
| `video.share` | in the vocabulary, granted by no template | reserved, must not be exposed | grant refusal + CHECK |
| Membership paths | template permission checks (`hasPermission(role, …)`) | effective permissions | `membership-service.ts` |
| Web control gates | `hasPermission(role, …)` on three pages | effective permissions, so a page never hides what the API allows | `apps/web` |
| Removal | — | a removed member's grants go with the membership | FK cascade |

## Choices the ADR leaves open (defaults taken; recorded in `TODO.md`)

1. **A non-`OWNER` delegates only what it effectively holds.** The ADR bounds a
   grant "by the granting actor's ceiling" without listing it. Under the six
   templates an `ADMIN` holds every non-protected grantable permission, so this
   changes nothing today.
2. **Grants survive a role change**, as Property assignments do (ADR-0052:
   "a role change does not rewrite Property assignments"). Effective permissions
   recompute from the new role, with the `property.create` ceiling applied.
3. **A `property.create` grant to a `VIEWER` or `BILLING` member is refused** at
   grant time; the effective-set filter also covers one that predates a role
   change.
4. **A repeated grant is a no-op** (no second row, no second audit entry); revoking
   a grant that does not exist is `NOT_FOUND`.

## Milestone

One PR (6D): migration 20 (`member_permission_grants`, additive), the domain
ceiling and service, the Prisma and in-memory repositories, effective
permissions in `authorizeOrganization`, the membership paths and the three web
gates, suites, mutation pass, ADR-0058, phase documentation.

**Dormant:** no HTTP route or page grants or revokes. Nothing commercial, no
Mode C, no MFA (not yet in the code at all; its own package before any
member-management UI). Paid Provider Activation, production credentials, the
production scheduler and live Stripe charges remain BLOCKED.
