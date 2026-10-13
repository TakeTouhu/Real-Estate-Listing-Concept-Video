# Phase 6C gap analysis — role templates, the permission matrix and the role-assignment ceiling

Status: implemented on branch `claude/project-thread-az06z2`.
Base: `main @ 7e0e1228765c655f4b476028c7643e7b033750ee` (PR #75, Phase 6B, merged
2026-10-13; migration 18 is the latest; the only other open pull request, #46,
is unrelated governance work).

Authority: ADR-0052 Decision 10 (template-to-permission matrix, role-fixed Scope,
grant ceilings, no self-escalation, last `OWNER`), ADR-0052 Decision 2 (no
`REVIEWER`; source-photo review is `analysis.review`), ADR-0053 Decision 5A
(`billing.manage` on every commercial mutation).

## Why this package is next

The next commercial package planned after Phase 6B was the customer-approved
Unit purchase. ADR-0053 Decision 5A gates it — and cancellation, plan change,
seats and storage blocks — on `billing.manage`. **That permission does not exist
in the code.** The implemented authorization model predates ADR-0052:

| Concern | Before Phase 6C | Where |
| --- | --- | --- |
| Roles | `OWNER`, `ADMIN`, `CREATOR`, `REVIEWER` | `packages/domain/src/identity/roles.ts`, `Role` enum in `schema.prisma` |
| Permissions | 5: `org:manage`, `member:read`, `member:manage`, `property:write`, `video:review` | `roles.ts` |
| `MANAGER`, `VIEWER`, `BILLING` | Not representable | — |
| `billing.manage`, `unit.consume`, `analysis.review`, … | Not representable | — |
| Role assignment | **Any `member:manage` holder may assign any role**, to anyone including itself: an `ADMIN` could invite an `OWNER` or promote itself to `OWNER` | `membership-service.ts` `invite`, `changeRole` |
| Removing a member | Any `member:manage` holder may remove anyone but the last `OWNER` — an `ADMIN` could remove an `OWNER` | `membership-service.ts` `removeMember` |
| Reads | Membership alone; no view permission is checked | property, asset, analysis and storyboard services |
| `REVIEWER` | Still a role, guarding source-photo review as `video:review` | `analysis-service.ts` |

The self-escalation is **latent, not reachable**: no HTTP route or page calls
`invite`, `changeRole` or `removeMember` today. It must be closed before any
member-management surface ships, and it is the first thing a later grant or
group package would otherwise inherit.

## Gaps this package closes

1. **The six role templates and the full permission vocabulary** — 27
   permissions, the ADR-0052 matrix cell for cell, and each template's fixed
   Scope as data.
2. **The role-assignment ceiling on every existing membership path** — invite,
   invitation acceptance, role change and removal. `OWNER` may assign any role;
   `ADMIN` only `MANAGER`/`CREATOR`/`VIEWER`; nobody else any. Assigning,
   removing or changing away from `OWNER`, `ADMIN` or `BILLING` is `OWNER`-only.
   Every refused attempt by a member is audited.
3. **`REVIEWER` removed** from the role vocabulary and the schema; existing rows
   become `VIEWER`.
4. **Every existing check moved to the new permissions**, including reads, which
   now check a view permission so a `BILLING` member does not read Property
   content.

## Not in this package

- Individual permission grants and their protected-authority ceiling
  (`permission.manage`, `billing.manage`, `disclosure.none` `OWNER`-only).
- Groups, group permissions, group deletion.
- **Property-rooted row Scope.** `GROUP` and `OWN` are recorded per template but
  not enforced: every role still reaches every Property of its organization, as
  `CREATOR` already does today. Nothing is in production.
- Any commercial mutation, any member-management HTTP route or page.
