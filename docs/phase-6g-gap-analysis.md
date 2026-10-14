# Phase 6G gap analysis — group permissions

Status: implemented on branch `claude/project-thread-az06z2`.
Base: `main @ b5deb17` (PR #79, Phase 6F, merged 2026-10-14; migration 21 is the
latest).

Authority: ADR-0052 Decision 10 (*group permissions are additive; there is no
DENY*; *`disclosure.none` is individual-only and `OWNER`-granted*; *no role may
escalate itself past its ceiling by any route — direct grant, group
membership, group permission or Scope*; *`property.create` is never effective
for `VIEWER` or `BILLING`, from any grant source*), ADR-0052 Decision 11 (group
deletion is `OWNER`/`ADMIN`-only), ADR-0057 (the role-assignment ceiling),
ADR-0058 (the grant ceiling), ADR-0059 (a change commits with its audit entry),
ADR-0060 (groups and their members).

## Why this package is next

Role templates (6C), individual grants (6D) and groups with their members (6F)
exist, but a group confers nothing. This package lets a group carry
permissions, which its members then hold. Property-rooted Scope (6H) follows;
it needs groups but not group permissions.

## The rule

> **A group change that gives or takes a permission is checked as if each
> affected member were granted, or revoked, that permission directly.**

For each (member, permission) pair the change affects, the actor must pass the
grant ceiling of ADR-0058:
- the member's role must be one the actor may manage (`mayAssignRole`), so an
  `ADMIN` reaches only `MANAGER`, `CREATOR` and `VIEWER` members, never itself;
- `permission.manage` and `billing.manage` are `OWNER`-only, to give or to take;
- anyone else gives or takes only what it effectively holds.

`disclosure.none` and the reserved `video.share` are never carried by a group.
The `property.create` recipient ceiling is not a refusal on a group path: a
group may carry `property.create` for its `MANAGER` and `CREATOR` members, and it
is simply not effective for its `VIEWER` and `BILLING` members.

## Gap

| Concern | Today (after Phase 6F) | Required | Where |
| --- | --- | --- | --- |
| Group permissions | none | a group carries a set of permissions | migration 22, `group_permissions` |
| `disclosure.none` on a group | not possible (no table) | impossible in the database, not only in code | a CHECK on the vocabulary |
| Tenant safety | — | a permission row belongs to its group's organization | composite foreign key |
| Effective permissions | template ∪ individual grants | template ∪ individual grants ∪ each group's permissions; `property.create` ceiling last; a group-sourced `disclosure.none` dropped | `effectivePermissions`, `effectivePermissionsOf` |
| Give or take a group permission | — | `permission.manage`, then the ceiling for each current member | `GroupService.grantPermission` / `revokePermission` |
| Add or remove a member | role ceiling only | also the ceiling for each of the group's permissions | `GroupService.addMember` / `removeMember` |
| Delete a group | `OWNER`/`ADMIN` | also checked as revoking each of its permissions from each member | `GroupService.delete` |
| Concurrency | additions and deletions serialized by the deletion's lock | every check judged on the group as the change commits | the group row locked first: `FOR UPDATE` for permission changes and deletion, `FOR SHARE` for additions and removals |
| Audit | `group.*` for groups and members | `group.permission_granted` / `group.permission_revoked` with the member count, refusals as `group.change_refused` | repository transactions |

## Choices ADR-0052 does not make (defaults taken, recorded in `TODO.md`)

1. **`permission.manage` and `billing.manage` may be carried by a group**, but
   only an `OWNER` can give them, take them away, or change the membership of
   a group that carries them. ADR-0052 excludes only `disclosure.none`.
2. **Changing a group's permissions needs `permission.manage`**, not
   `group.manage`: it is an authorization change.
3. **An `ADMIN` cannot delete a group whose deletion would take away a
   permission it could not revoke directly.** A group with no permissions is
   deleted exactly as in 6F.
4. **Group permissions survive a member's role change**, as individual grants
   do (ADR-0058 Decision 4). The `property.create` ceiling keeps applying.
5. **Leaving the organization ends group-derived permissions** with no
   `group.*` entry; the `member.removed` entry records it, as in 6F.

## Out of scope

- Property-rooted Scope and a Property's group (6H). Until then a group's
  permissions are organization-wide, as every permission is today.
- Any route or page. Group permissions stay dormant, like 6C to 6F.
- MFA, which must land before any member, permission or group screen.

## Milestone

One PR (6G):
- migration 22 and the Prisma model;
- the ceiling helpers in `roles.ts`;
- the `GroupRepository` port with its Prisma and in-memory implementations,
  each check run under the group's lock;
- `GroupService` permission operations and the checks on the 6F paths;
- unit, database and shape suites, including deterministic races;
- the mutation pass;
- ADR-0061 and the phase documentation.

Two PRs were considered and rejected: group permissions without the checks on
the membership paths would leave a known escalation route on `main`.

**Dormant:** no HTTP route or page calls these operations. Paid Provider
Activation, production credentials, the production scheduler and live Stripe
charges remain BLOCKED.
