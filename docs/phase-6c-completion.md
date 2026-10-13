# Phase 6C completion — the role templates and the role-assignment ceiling

Branch: `claude/project-thread-az06z2`
Base: `7e0e1228765c655f4b476028c7643e7b033750ee` (PR #75 merge commit on `main`)
ADR: `docs/decisions/0057-role-templates-and-role-assignment-ceiling.md`
Gap analysis: `docs/phase-6c-gap-analysis.md`

This is the completion record of the first authorization package of Phase 6, not
of Phase 6. Later packages are listed under *Carried forward*.

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `f85560d` | the gap analysis |
| `0e43ec7` | the templates and matrix, the ceiling on every membership path, migration 19, every existing check moved to its permission, the suites, the advanced migration tripwires |
| `76d4676` | tests pinning the permission each action checks, and that a multi-permission check requires all of them |
| `f03234a` | two tests the mutation pass showed missing (see *Mutation ledger*) |
| *(this commit)* | ADR-0057, the phase documentation and this record |

The exact head SHA is reported with the pull request rather than written into a
file that would have to contain its own hash.

## What this phase adds

- **The six templates and the 27 permissions** (`packages/domain/src/identity/roles.ts`)
  — `OWNER`, `ADMIN`, `MANAGER`, `CREATOR`, `VIEWER`, `BILLING`, each granting
  exactly its ADR-0052 matrix row; each template's fixed Scope as data
  (`scopeForRole`); `disclosure.none` and `video.share` granted by no template.
- **The role-assignment ceiling** (`mayAssignRole`) asked of every role that
  invitation, acceptance, role change and removal touch, with each refusal of a
  member audited as `member.role_change_refused`. This closes the latent paths by
  which an `ADMIN` could invite or remove an `OWNER` or promote itself.
- **Migration 19** — recreates the `Role` type with the six templates and maps
  `REVIEWER` to `VIEWER` in `memberships` and `invitations`.
- **Every existing check on its specific permission**, reads included
  (ADR-0057 Decision 4); `authorizeOrganization` accepts several permissions and
  requires all of them.

Behavior a member can notice: `MANAGER` and `CREATOR` may now review source
photos; `VIEWER` and `BILLING` may not; `BILLING` reads no Property, asset,
analysis or storyboard; a former `REVIEWER` is a `VIEWER`.

## The role change and acceptance sequence

```mermaid
sequenceDiagram
  autonumber
  participant A as Actor
  participant MS as MembershipService
  participant AZ as authorizeOrganization
  participant R as Repositories
  participant AU as Audit log

  A->>MS: changeRole(actor, org, target, role)
  MS->>AZ: membership of actor in org
  alt not a member
    AZ-->>A: FORBIDDEN (no audit entry in org)
  end
  MS->>MS: hasPermission(actor.role, permission.manage)?
  alt lacks it
    MS->>AU: member.role_change_refused {operation, actorRole, currentRole: null, requestedRole}
    MS-->>A: FORBIDDEN
  end
  MS->>R: find target membership
  MS->>MS: mayAssignRole(actor.role, target.role) and mayAssignRole(actor.role, role)?
  alt either refused
    MS->>AU: member.role_change_refused {operation, actorRole, currentRole, requestedRole}
    MS-->>A: FORBIDDEN
  end
  MS->>MS: last OWNER kept?
  MS->>R: updateRole
  MS->>AU: member.role_changed {targetUserId, role, previousRole, scope}

  Note over A,AU: Acceptance re-asks the ceiling of the inviter as it is now
  A->>MS: acceptInvitation(user, token)
  MS->>R: invitation; inviter's current membership
  alt inviter gone, or lacks member.manage, or may not assign the role
    MS->>AU: member.role_change_refused {operation: accept_invitation, requestedRole, invitedByUserId, inviterRole}
    MS-->>A: FORBIDDEN
  end
  MS->>R: create membership; invitation ACCEPTED
  MS->>AU: invitation.accepted {role, scope}
```

Invitation and removal follow the role-change shape: invitation needs
`member.manage` and asks the ceiling of the invited role; removal needs
`member.manage` and asks it of the member's current role, before the last-`OWNER`
check.

## Verification

Measured on the committed tree `dc2c1fe` (commit `f03234a`), against a local
PostgreSQL 16 configured like CI.

| Check | Result |
| --- | --- |
| `pnpm lint` | clean |
| `pnpm typecheck` (root, all packages, `tests/integration`) | clean |
| `pnpm test` | **4814 / 4814**, 153 files (identity: 101 across the matrix, ceiling, shape and existing suites) |
| `pnpm test:db` | **1216 / 1216**, 40 files (the role-templates suite: 11) |
| `pnpm build` | Next.js production build succeeded |
| `prisma migrate status` | 20 migrations, schema up to date |
| `prisma migrate diff --from-migrations … --to-schema-datamodel --exit-code` | no difference |

**Migration rehearsal.** A scratch database migrated through migration 18 was
seeded with one membership of each old role and a `REVIEWER` and a `CREATOR`
invitation. After migration 19 the `REVIEWER` membership and invitation read
`VIEWER`, every other row kept its role, and the type's values were the six
templates in order.

CI on the pull request's exact head is reported with the pull request.

## Mutation ledger

One textual edit per definition, at an anchor that must occur exactly once, run
against the suite or suites listed for it; every mutated file is restored and
re-hashed, and a SHA-256 manifest of all 724 files in the working tree is
compared before and after the pass.

**Authoritative: 53 run, 53 killed, 0 survivors, 0 anchor-missing**, in one
uninterrupted pass against the tree `dc2c1fe` (commit `f03234a`), the reviewed
runtime tree. The only later commit is this one, which changes documentation
only. All 724 files were byte-identical after the pass.

| ID | Category | Mutation | File | Killed by |
| --- | --- | --- | --- | --- |
| P01 | matrix | `MANAGER` loses `group.view` | `roles.ts` | identity: 1 failing |
| P02 | matrix | `VIEWER` gains `video.generate` | `roles.ts` | identity: 1 failing |
| P03 | matrix | `BILLING` gains `unit.consume` | `roles.ts` | identity: 2 failing |
| P04 | matrix | `ADMIN` gains `billing.manage` | `roles.ts` | identity: 2 failing |
| P05 | matrix | content-working templates lose `unit.consume` | `roles.ts` | identity: 1 failing |
| P06 | matrix | the `OWNER` template carries `disclosure.none` | `roles.ts` | identity: 2 failing |
| P07 | matrix | `video.share` leaves the permission vocabulary | `roles.ts` | identity: 1 failing |
| P08 | scope | `MANAGER` is `ORGANIZATION`-scoped | `roles.ts` | identity: 3 failing |
| P09 | scope | `VIEWER` is `GROUP`-scoped | `roles.ts` | identity: 1 failing |
| P10 | vocabulary | `REVIEWER` is still a role | `roles.ts` | identity: 2 failing |
| C01 | ceiling | `ADMIN` may assign `BILLING` | `roles.ts` | identity: 6 failing |
| C02 | ceiling | `ADMIN` may assign `ADMIN` | `roles.ts` | identity: 6 failing |
| C03 | ceiling | `ADMIN` may assign `OWNER` | `roles.ts` | identity: 6 failing |
| C04 | ceiling | `MANAGER` gets `ADMIN`'s assignment authority | `roles.ts` | identity: 1 failing |
| C05 | ceiling | invitation skips the ceiling | `membership-service.ts` | identity: 3 failing |
| C06 | ceiling | a role change asks only of the new role | `membership-service.ts` | identity: 2 failing |
| C07 | ceiling | a role change asks only of the current role | `membership-service.ts` | identity: 3 failing |
| C08 | ceiling | removal skips the ceiling | `membership-service.ts` | identity: 3 failing |
| C09 | ceiling | acceptance does not re-ask the inviter's ceiling | `membership-service.ts` | identity: 1 failing |
| C10 | ceiling | acceptance trusts an inviter who is no longer a member | `membership-service.ts` | identity: 1 failing |
| C12 | permission | a role change needs `member.view`, not `permission.manage` | `membership-service.ts` | identity: 2 failing |
| C13 | permission | removal needs `member.view`, not `member.manage` | `membership-service.ts` | identity: 1 failing |
| C14 | permission | listing members needs only membership | `membership-service.ts` | identity: 2 failing |
| A01 | audit | a refusal writes no audit entry | `membership-service.ts` | identity: 21 failing |
| A02 | audit | a refusal does not refuse | `membership-service.ts` | identity: 22 failing |
| A03 | audit | a refused acceptance writes no audit entry | `membership-service.ts` | identity: 3 failing |
| A04 | audit | a role change records no Scope | `membership-service.ts` | identity: 1 failing |
| A05 | audit | an acceptance records no Scope | `membership-service.ts` | identity: 1 failing |
| Z01 | authorize | only the first of several permissions is checked | `authorization.ts` | identity: 1 failing |
| Z02 | authorize | a single permission is ignored | `authorization.ts` | identity: 3 failing |
| S01 | call site | creating a property needs `property.view` | `property-service.ts` | property: 1 failing |
| S02 | call site | editing a property needs `property.view` | `property-service.ts` | property: 1 failing |
| S03 | call site | deleting a property needs `property.view` | `property-service.ts` | property: 1 failing |
| S04 | call site | listing properties needs only membership | `property-service.ts` | property: 1 failing |
| S05 | call site | reading a property needs only membership | `property-service.ts` | property: 1 failing |
| S06 | call site | requesting an upload needs `property.view` | `asset-service.ts` | property: 1 failing |
| S07 | call site | completing an upload needs `property.view` | `asset-service.ts` | property: 1 failing |
| S08 | call site | retrying an upload needs `property.view` | `asset-service.ts` | property: 1 failing |
| S09 | call site | deleting an asset needs `property.view` | `asset-service.ts` | property: 1 failing |
| S10 | call site | listing assets needs only membership | `asset-service.ts` | property: 1 failing |
| S11 | call site | an asset download URL needs only membership | `asset-service.ts` | property: 1 failing |
| S12 | call site | starting an analysis needs `property.view` | `analysis-service.ts` | analysis: 2 failing |
| S13 | call site | reviewing an analysis needs `property.view` | `analysis-service.ts` | analysis: 3 failing |
| S14 | call site | listing analyses needs only membership | `analysis-service.ts` | analysis: 1 failing |
| S15 | call site | reading an analysis needs only membership | `analysis-service.ts` | analysis: 1 failing |
| S16 | call site | creating a video project needs `video.view` | `storyboard-service.ts` | storyboard: 1 failing |
| S17 | call site | composing a storyboard needs `video.view` | `storyboard-service.ts` | storyboard: 1 failing |
| S18 | call site | reading a storyboard needs only membership | `storyboard-service.ts` | storyboard: 1 failing |
| S19 | call site | listing video projects needs only membership | `storyboard-service.ts` | storyboard: 1 failing |
| S21 | call site | the review board offers decisions to a video viewer | `review-view.ts` | review-view: 2 failing |
| D01 | migration | `REVIEWER` memberships are cast unmapped | `migration.sql` | identity: 1 failing |
| D02 | migration | `REVIEWER` becomes `CREATOR`, not `VIEWER` | `migration.sql` | identity: 1 failing |
| D03 | schema | the schema enum keeps `REVIEWER` | `schema.prisma` | identity: 1 failing |

"Killed by" names the first suite that failed and how many of its tests did.
Ceiling, permission and audit mutations run the identity unit suites first, then
the role-templates database suite.

**An earlier pass** against commit `76d4676` ran 55 definitions and left four
survivors. Two were real gaps, closed by `f03234a`:

- C09 (acceptance does not re-ask the inviter's ceiling) survived because the only
  demoted-inviter test demoted the inviter to `VIEWER`, which also loses
  `member.manage`. The new test demotes the inviter to `ADMIN`, which keeps
  `member.manage` but may no longer assign `ADMIN`.
- C13 (removal needs `member.view`) survived because the refusal test did not say
  which check refused. It now asserts the refusal happened on the permission,
  before the target's role was read (`currentRole: null`).

The other two are equivalent under the six templates and are **not defined**:

- **C11** — invitation needing `organization.view` instead of `member.manage`.
  Every template that holds `organization.view` but not `member.manage`
  (`MANAGER`, `CREATOR`, `VIEWER`, `BILLING`) is then refused by the ceiling,
  which assigns those templates nothing, with the same audit entry.
- **S20** — starting a scene needing only `unit.consume`. `unit.consume` and
  `video.generate` have the same holders in every template, so no member can
  observe the difference until individual grants exist (the package that can
  separate them must kill this then).

Also not defined, for the same reason: removing the inviter's `member.manage`
test from acceptance, since every template that may assign any role holds
`member.manage`.

## Required phase documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table (Phase 6C identity row) |
| Entity-relationship diagram | `docs/er-diagram.md`, `Role` enum and *Phase 6C — the role templates* |
| Critical sequence diagram | this record, *The role change and acceptance sequence*; `docs/sequence-analysis-lifecycle.md` and `docs/sequence-upload-lifecycle.md` now name the permissions their steps check |
| OpenAPI / API change summary | **Not applicable** to HTTP: no route was added or removed, and no response shape changed. A route that a role could reach before may now answer `403` (ADR-0057 Decision 4). Internal API: `Role`, `ROLES`, `PERMISSIONS`, `Permission`, `Scope`, `ROLE_PERMISSIONS`, `hasPermission`, `scopeForRole`, `mayAssignRole`; `authorizeOrganization` accepts one permission or several |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *Phase 6C — the role templates* |
| Phase completion report | this file |

`docs/UXFlow.md` names the new permissions where it describes which roles see
review and create controls.

## Activation status

**Dormant for member management.** No HTTP route or page invites, changes a role
or removes a member; the ceiling closes those paths before one is built. The
permission changes to existing routes are live in the application, but no
customer exists yet. Nothing commercial is built, and no timer, cron or loop is
introduced. Paid Provider Activation, production Provider credentials, production
paid AI calls, production scheduler activation and live Stripe charges all remain
**BLOCKED**.

## Carried forward

- **Authorization still to build**, before the commercial mutations that depend
  on it: individual permission grants with their `OWNER`-only protected
  authority (`permission.manage`, `billing.manage`, `disclosure.none`); groups
  and group permissions, each grant path asking the same ceiling; Property-rooted
  row Scope (the responsible user and group assignments). Until then every role
  reaches every Property of its organization.
- MFA enforcement for `billing.manage` holders.
- The Phase 6C choices ADR-0052 did not make, recorded in
  `docs/decisions/TODO.md` for confirmation.
- **Open decision gates** from earlier packages: what a customer regeneration
  costs in Units, and what happens to a self-service renewal whose payment fails.
- Later Phase 6 commercial packages: the customer-approved Unit purchase,
  cancellation, upgrade and downgrade, seats and storage blocks, Stripe billing,
  charged disclosure recomposition, the internal recovery budget, the Cost Safety
  Guard threshold, reconciliation and admin controls.
