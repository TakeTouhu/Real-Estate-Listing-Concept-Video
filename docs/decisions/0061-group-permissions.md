# ADR-0061 — Group permissions under the grant ceiling

Status: Accepted (Phase 6G)
Implements: ADR-0052 Decision 10:
- *group permissions are additive; there is no DENY*;
- *`disclosure.none` is individual-only and only an `OWNER` grants it*;
- *no role may escalate itself past its ceiling by any route — direct grant,
  group membership, group permission or Scope*;
- *`property.create` is never effective for `VIEWER` or `BILLING`, from any
  grant source*;
- *every role, permission, group and Property-assignment change remains
  audited*.

Also implements ADR-0052 Decision 11 (*on group deletion, users lose only
group-granted permissions*). Fifth of the authorization packages, after
ADR-0057 to ADR-0060. Property-rooted Scope follows.

## Context

After Phase 6F an organization has role templates (ADR-0057), individual grants
under the grant ceiling (ADR-0058), and groups with members (ADR-0060). A group
confers nothing yet. This package lets a group carry permissions, which every
member of the group then holds.

ADR-0052 names the danger: the additive group model is the obvious loophole. A
permission that cannot be granted directly must not be acquired by joining a
group, by editing a group's permissions, or by deleting a group.

---

## Decision 1 — One table, which can never hold `disclosure.none`

Migration 22 adds **`group_permissions`**: the group, the organization, the
permission, the granting user and the time.
- The primary key is (group, permission), so a group carries a permission at
  most once.
- A composite foreign key (`groupId`, `organizationId`) references the group, so
  a row always belongs to its group's organization. Deleting the group removes
  its rows.
- A CHECK limits `permission` to what a group may carry: the grantable
  vocabulary less `disclosure.none` (only ever an `OWNER`'s grant to an
  individual) and less the reserved `video.share`. A group carrying
  `disclosure.none` is impossible in the database itself, not only in code.

`grantedByUserId` has no foreign key: it is attribution, like
`member_permission_grants.grantedByUserId`.

## Decision 2 — What a member holds

A member's effective permissions are now its template's, its individual grants
and the permissions of every group it belongs to, in vocabulary order:
- **They add up.** There is no DENY.
- **A group confers only what a group may carry.** A group-sourced
  `disclosure.none` or `video.share` is dropped even if one were ever stored.
  This is defense in depth behind the CHECK.
- **`property.create` stays a ceiling on the recipient's role**, applied last.
  It is never effective for a `VIEWER` or `BILLING` member, from a group as from
  any source.

`authorizeOrganization`, the organization listing and the inviter check at
invitation acceptance read the member's group permissions through
`effectivePermissionsOf`. The read
is one query: it starts from the member's group rows by their (organization,
user) index and reaches each group's permissions by key.

## Decision 3 — One rule for every group path

> **A group change that gives or takes a permission is checked as if each
> member it reaches were granted, or revoked, that permission directly.**

The check is the grant ceiling of ADR-0058, for each (member, permission) pair.
It has two halves:
- **The actor half** depends on the actor and the permission only:
  - `disclosure.none` and `video.share` are never on a group (`not_grantable`);
  - `permission.manage` and `billing.manage` are `OWNER`-only, to give or to
    take (`protected`);
  - anyone else gives or takes only what it effectively holds (`not_held`).
- **The member half** depends on the member's role: the actor must be able to
  manage it (`mayAssignRole`, ADR-0057), so an `ADMIN` reaches only `MANAGER`,
  `CREATOR` and `VIEWER` members, never itself (`target_role`).

The two halves share one definition with the individual-grant ceiling
(`delegationRefusal` in `roles.ts`).

ADR-0058's recipient ceiling (`property.create` refused to a `VIEWER` or
`BILLING` member) is not a refusal on a group path. A group may carry
`property.create` for its `MANAGER` and `CREATOR` members, and for its `VIEWER`
and `BILLING` members it is simply never effective (Decision 2).

How each path applies the rule:

| Change | Needs | Checked as | Default holders who pass |
| --- | --- | --- | --- |
| Give a group a permission | `permission.manage` | a grant of it to each member | `OWNER`; `ADMIN` when the permission is not protected and every member is `MANAGER`/`CREATOR`/`VIEWER` |
| Take a permission from a group | `permission.manage` | a revocation of it from each member | the same |
| Add a member | `group.manage` and the 6F role ceiling | a grant of each of the group's permissions to that member | `OWNER`; `ADMIN` when the group carries no protected permission |
| Remove a member | `group.manage` and the 6F role ceiling | a revocation of each of the group's permissions from that member | the same |
| Delete a group | `group.manage` and the `OWNER` or `ADMIN` role (6F) | a revocation of each of its permissions from each member | `OWNER`; `ADMIN` when the group carries no protected permission and, if it carries any permission, no member above the `ADMIN`'s ceiling |

On each path the actor half is asked of every permission involved, even when
the group has no member. An `ADMIN` therefore can never give a group
`billing.manage`, even an empty one.

A group with no permissions behaves exactly as in Phase 6F: no path involves a
permission, so the rule adds nothing.

Every refusal of a member is audited as `group.change_refused`, as in 6F. The
entry records the operation (`grant_permission`, `revoke_permission`,
`add_member`, `remove_member` or `delete`), the reason, the actor's role, the
group, the permission, and the first member the ceiling refused, with that
member's role. The 6F reasons stay (`lacks_group_manage`, `protected_delete`,
`target_role`); 6G adds `lacks_permission_manage`, `not_grantable`, `protected`
and `not_held`.

## Decision 4 — Each check is judged on the group as the change commits

A check read against the group before the change commits could pass against a
state that is gone by commit time. Two changes that each pass alone could then
interleave into a history no allowed order produces. For example:
- An `ADMIN` deletes a group while an `OWNER` gives it `billing.manage`.
- The deletion reads no protected permission and passes.
- The grant commits first, and the deletion then takes `billing.manage` away
  from the group's members.
- That is a revocation an `ADMIN` may not make.

So each change runs its check inside its own transaction, after locking the
group row:
- **Permission changes and deletion** take `FOR UPDATE`. They exclude every
  other change to the group.
- **Additions and removals** take `FOR SHARE`. They still run alongside each
  other, but never alongside a permission change or a deletion.

The repository supplies the group as locked: its members with the roles they
hold, and its permissions. The service supplies the check, which returns a
refusal or admits the change. A refused change writes nothing; the service then
audits the refusal and answers `FORBIDDEN`. Because every write of a group's
permissions holds the exclusive lock, a grant decides "already carried" from
what it read under that lock.

**What the lock does not cover, and why that is safe:**
- **A member's role change.** A role change does not lock the group. If one
  commits between the check and the write, the result is the same as if the
  group change had committed just before it. The ceiling allowed it there, and
  group permissions survive a role change (Decision 5). This is ADR-0058's and
  ADR-0060's reasoning.
- **The actor's own permissions** are read when the actor is authorized, before
  the lock, as in ADR-0058.
- **A member leaving the organization** removes its group rows without locking
  the group. A check that still saw the member is only stricter.

## Decision 5 — Choices ADR-0052 does not make

Recorded in `docs/decisions/TODO.md` for confirmation:

1. **`permission.manage` and `billing.manage` may be carried by a group.** Only
   an `OWNER` can give them, take them away, or change the membership of a
   group that carries them. ADR-0052 excludes only `disclosure.none` from
   groups. The narrower alternative would forbid both protected permissions on
   groups outright.
2. **Changing a group's permissions needs `permission.manage`**, not
   `group.manage`: it is an authorization change. Membership changes still need
   `group.manage` plus the ceiling.
3. **An `ADMIN` cannot delete a group whose deletion would take away a
   permission it could not revoke directly.** ADR-0052 Decision 11 lets an
   `ADMIN` delete groups; this keeps that, except where the deletion would be a
   route around the revocation ceiling.
4. **Group permissions survive a member's role change**, as individual grants
   do (ADR-0058 Decision 4). The `property.create` ceiling keeps applying.
5. **Leaving the organization ends group-derived permissions** with no
   `group.*` entry. The `member.removed` entry records the removal, as in 6F.
6. **A repeated grant to a group changes nothing** (`granted: false`); taking
   away a permission the group does not carry is `NOT_FOUND`.

## Consequences

- No route or page calls the new operations. Group permissions are dormant, but
  every authorization now also reads them.
- `GroupRepository.addMember`, `removeMember` and `delete` take the check, and
  their outcomes are objects that can carry a refusal. The in-memory repository
  mirrors the lock by checking and writing with no `await` in between.
- Removing a member from the organization (`member.manage`, under the role
  ceiling) ends what its groups gave it, as it ends its individual grants. That
  is unchanged from 6D: removal is governed by the member's role, not by the
  permissions it holds.
- The audit entries of additions, removals and deletions are unchanged from
  6F. The permissions a member gained or lost follow from the trail's
  `group.permission_*` entries.
- **MFA is still not built.** It must exist before any member, permission or
  group screen ships.

## Not decided here

- A Property's group and Property-rooted Scope. Until then a group's
  permissions are organization-wide, as every permission is today, and a group
  deletion ungroups no Property.
- User deletion.
