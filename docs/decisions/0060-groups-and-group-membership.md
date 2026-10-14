# ADR-0060 — Groups and group membership

Status: Accepted (Phase 6F)
Implements: ADR-0052 Decision 10 (*groups*; *users may belong to multiple
groups*; *no role may escalate itself past its ceiling by any route, group
membership included*; *every role, permission, group and Property-assignment
change remains audited*) and ADR-0052 Decision 11 (*group deletion is a
protected `OWNER`/`ADMIN`-only operation*). Fourth of the authorization
packages, after ADR-0057, ADR-0058 and ADR-0059. Group permissions and
Property-rooted Scope follow.

## Context

ADR-0052 builds authorization from role templates, individual grants, groups
and Scope. After Phase 6E, templates, grants and race-free membership changes
exist, but groups do not. Both remaining packages need them:
- group permissions add up across a member's groups;
- `GROUP` Scope reaches the Properties of the actor's groups.

This package builds groups and who belongs to them. A group confers nothing
yet: no permission and no row access.

---

## Decision 1 — Two tables, both bound to one organization

Migration 21 adds two tables.

**`groups`** holds the organization, the name, the creating user and timestamps.
- The name is unique within the organization.
- A CHECK keeps the stored name trimmed and 1 to 100 characters.
- A unique key on (`id`, `organizationId`) exists so that a member row can
  reference the pair.

**`group_members`** holds the group, the organization, the user, the adding
user and the time. The primary key is (group, user), so a member is in a group
at most once. Two composite foreign keys both carry the organization:
- (`groupId`, `organizationId`) references the group;
- (`organizationId`, `userId`) references the membership.

A row can therefore never link a group of one organization to a member of
another, even for a user who belongs to both. Both keys cascade:
- deleting a group removes its member rows;
- removing a member from the organization removes them from every group.

`createdByUserId` and `addedByUserId` have no foreign key. They are
attribution, like `member_permission_grants.grantedByUserId`.

Every repository call takes the organization and filters on it. A group of
another organization is not found.

## Decision 2 — Who may change a group or its members

| Operation | Needs |
| --- | --- |
| List groups, list a group's members | `group.view` |
| Create, rename | `group.manage` |
| Delete | `group.manage` **and** the `OWNER` or `ADMIN` role |
| Add a member, remove a member | `group.manage` **and** the role-assignment ceiling on the member's role |

Permissions are effective permissions (ADR-0058), so `group.manage` granted to
a `MANAGER` lets it create and rename groups. Two parts of the table follow
from ADR-0052.

**Deletion is protected.** ADR-0052 Decision 11 makes group deletion
`OWNER`/`ADMIN`-only, even where another role holds `group.manage`. The service
asks for the role itself, which no grant can change.

**Membership changes follow the ceiling.** Adding or removing a member asks
`mayAssignRole(actor, member)` (ADR-0057), as a role change or an individual
grant does:
- an `OWNER` may change anyone's group membership, its own included;
- an `ADMIN` may change only `MANAGER`, `CREATOR` and `VIEWER` members, so never
  its own;
- every other role, even holding `group.manage` by grant, may change no one's.

A group membership will carry group permissions and `GROUP` reach, so changing
it is an authorization change on that member. This is the rule ADR-0052 sets
for every grant path ("no role may escalate itself past its ceiling by any
route — direct grant, group membership, group permission or Scope"). It also
stops a `MANAGER` that was granted `group.manage` from adding itself to groups
to reach more Properties once Scope exists.

**Every refusal of a member is audited** as `group.change_refused`. The entry
records the operation, the reason, the actor's role, the group, and the target
and its role where read:

| Reason | When |
| --- | --- |
| `lacks_group_manage` | the actor lacks effective `group.manage` (refused before the group or target is read) |
| `protected_delete` | a deletion by a role other than `OWNER` or `ADMIN` |
| `target_role` | a membership change past the role-assignment ceiling |

A non-member is refused like any other organization access, and writes nothing
into that organization's audit trail. A member lacking `group.view` is refused
a listing without an audit entry, as `member.view` listings are.

## Decision 3 — Each change commits with its audit entry, and only against what it read

The repository writes each change and its audit entry in one transaction
(ADR-0059):

| Change | Audit action | Writes nothing when |
| --- | --- | --- |
| create | `group.created` | another group of the organization has the name (`NAME_TAKEN`) |
| rename | `group.renamed`, with the previous name | the group is gone or no longer has the name the rename was checked against (`STALE`), or the new name is taken (`NAME_TAKEN`) |
| delete | `group.deleted`, with the actor's role and the number of members removed | the group is gone (`STALE`) |
| add a member | `group.member_added`, with the member's role | the member is already in the group, or the group or the member's membership is gone (`STALE`) |
| remove a member | `group.member_removed`, with the member's role | the member is not in the group |

The conflicts are classified from the error itself, by model and key, not by
reading again. This is the lesson of the PR #78 review.

How the service answers each outcome:
- a taken name is `VALIDATION_FAILED`;
- a stale rename is `VALIDATION_FAILED` ("This group changed meanwhile");
- a stale deletion or addition is `NOT_FOUND`;
- a repeated addition changes nothing and answers `added: false`.

**The deletion locks the group row** (`SELECT … FOR UPDATE`) before it removes
and counts the members. An addition's foreign-key check holds a share lock on
the group row, which this lock waits for. So an addition either commits before
the deletion, and is counted, or finds the group gone. The count is taken from
the deletion's own `DELETE`, which waits on, and then skips, a member a
concurrent removal took out first. The audited count is therefore always the
number of rows this deletion removed.

**A change of the member's or the actor's role in between.** The ceiling is
judged on the roles as read. Suppose a role change of the member, or a demotion
of the actor, commits between that read and the write. The result is the same
as if the membership change had committed just before the role change. The
ceiling allowed it at that point, and group memberships survive role changes
(Decision 5). Unlike the role change of ADR-0059, a membership change does not
write the role it was checked against. So no interleaving reaches a state that
no serial order of allowed changes reaches, and no compare-and-set on the role
is needed.

Group permissions change this. There, an addition's ceiling depends on the
group's permissions, so the addition and a permission change of the same group
must lock the group row.

## Decision 4 — What a deletion does today

The group and its member rows go, in one transaction with `group.deleted`. The
members stay in the organization with their roles and grants. No content is
touched. No Property has a group yet, so a deletion ungroups none. When
Properties gain groups (Property-rooted Scope), the deletion will ungroup them
and its audit entry will record how many, as ADR-0052 Decision 11 requires.

## Decision 5 — Choices ADR-0052 does not make

Recorded in `docs/decisions/TODO.md` for confirmation:

1. **Group membership changes follow the role-assignment ceiling** (Decision 2).
2. **A group name** is required, trimmed, at most 100 characters (UTF-16 code
   units in the service, characters in the CHECK), and unique within its
   organization by exact match. Renaming to the current name changes nothing.
3. **Group memberships survive a role change**, as individual grants (ADR-0058
   Decision 4) and Property assignments do.
4. A repeated addition changes nothing. Removing a member who is not in the
   group is `NOT_FOUND`.
5. Leaving the organization ends a member's group memberships with no
   `group.*` audit entry. Its `member.removed` entry records the removal.

## Consequences

- No route or page calls `GroupService`; groups are dormant.
- A group confers no permission and no row access. Every role still reaches
  every Property of its organization until Property-rooted Scope lands.
- `IdentityRepositories` gains `groups`. The audit-row mapping moves into its
  own module (`audit-log-data.ts`), shared by both identity repositories.
- **MFA is still not built.** It must exist before any member-management or
  group screen ships.

## Not decided here

- **Group permissions:**
  - they are additive, under the grant ceiling on every group path;
  - an addition becomes a grant of each of the group's permissions, checked
    under a lock on the group row;
  - `disclosure.none` is made impossible on a group.
- A Property's group and Property-rooted Scope.
- User deletion.
