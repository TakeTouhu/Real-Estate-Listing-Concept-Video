# ADR-0062 — Property assignment: the responsible user and the group

Status: Accepted (Phase 6H)
Implements: ADR-0052 Decision 10:
- *the Property is the authorization root*;
- *`OWN` means the explicitly assigned responsible user, never created-by*;
- *a Property is assigned to zero or one group*;
- *only `OWNER` and `ADMIN` change either assignment; `property.edit` alone
  does not*;
- *assignments at creation depend on the creator's role*;
- *every selected user or group belongs to the same organization*;
- *a role change does not rewrite Property assignments*;
- the audit evidence for a Property's creation and for an assignment change.

Also implements ADR-0052 Decision 11 (*deleting a group ungroups its
Properties, and the audit records how many*). Sixth of the authorization
packages, after ADR-0057 to ADR-0061. Enforcing reach on the content paths
(6I) follows.

## Context

Scope is fixed by role: `OWNER`, `ADMIN` and `BILLING` reach the whole
organization, a `MANAGER` reaches the Properties of its groups, and a `CREATOR`
or `VIEWER` reaches the Properties it is responsible for. The last two need two
durable relationships that did not exist: a Property's responsible user, and a
Property's group. This package adds them and every rule that writes them.

It does not enforce reach. Until 6I every member still reaches every Property
of its organization, as before.

No live route adds a member to an organization, so every live organization has
only `OWNER` members, and every existing Property was created by an `OWNER`.

---

## Decision 1 — Two nullable columns, each kept inside the organization

Migration 23 adds two nullable columns to `properties`:
- **`responsibleUserId`.** Its foreign key (`organizationId`,
  `responsibleUserId`) references `memberships`, so the responsible user is
  always a member of the Property's organization. A user of another
  organization cannot be assigned, even one who shares a user row with a member.
- **`groupId`.** Its foreign key (`groupId`, `organizationId`) references
  `groups`, so the group always belongs to the Property's organization.

Both foreign keys are `NO ACTION`: the database refuses to delete a membership
or a group that a Property still refers to. Every path that removes one clears
the assignment itself and counts it (Decisions 4 and 5), so nothing is cleared
silently. (`SET NULL` is not available on these keys: on a composite key it
would also null the Property's organization.)

Two indexes serve the releases: (`organizationId`, `responsibleUserId`) and
(`groupId`).

The migration is additive and backfills nothing. Every existing Property starts
unassigned, which ADR-0052 allows for an `OWNER`'s Property. `createdBy` is
unchanged: it is authorship history and authorizes nothing.

## Decision 2 — Assignments at creation, by the creator's role

| Creator | Responsible user | Group |
| --- | --- | --- |
| `OWNER` / `ADMIN` | any member but a `BILLING` one, or unset when none is chosen | any group of the organization, or unset when none is chosen |
| `MANAGER` | itself; naming anyone else is refused | one of its own groups: the only one, or the one it names. Naming a group it is not in is refused; belonging to none is refused; belonging to several and naming none asks it to choose |
| `CREATOR` | itself; naming anyone else is refused | unset; naming any group, its own included, is refused |

`VIEWER` and `BILLING` never hold `property.create` (ADR-0052's capability
ceiling, built in 6C, 6D and 6G), so no rule applies to them.

**Refusals.** A refusal is an attempt past the creator's authority. It answers
`FORBIDDEN` and is audited as `property.assignment_refused`, with the
operation, the reason (`responsible_user_fixed`, `group_not_selectable`,
`group_not_own`, `no_group`), the actor's role and the requested user and
group. An invalid choice is answered `VALIDATION_FAILED` and is not audited:
a user who is not an eligible member, a group of another organization, or a
`MANAGER` in several groups naming none.

**Audit.** `property.created` now records the creator's role and both initial
assignments. It commits in the same transaction as the Property; before this
package it was written after the row, separately.

**The create route is unchanged.** `POST /api/properties` passes no assignment,
so an `OWNER` creates exactly as before and the Property starts unassigned.

## Decision 3 — Reassignment

`PropertyService.assign` changes a Property's responsible user, group or both.
An omitted field keeps its value; `null` unsets it.
- **`OWNER` and `ADMIN` only, by role.** It is an authorization change, so a
  permission does not authorize it: a `MANAGER` holding `property.edit` is
  refused. A refusal is audited (`reassignment_role`) and answered `FORBIDDEN`
  before the Property is looked up, so a refused member cannot probe which
  Properties exist.
- **Only a new choice is validated.** A responsible user whose role changed
  after the assignment keeps it (ADR-0052: a role change does not rewrite
  assignments), and an `OWNER` can still change that Property's group.
- **A change that changes nothing writes nothing** and answers
  `changed: false`.
- **Compare-and-set.** The write applies only while the Property is not deleted
  and still has the assignments the change was checked against. Otherwise
  nothing is written and the caller is told the assignment changed meanwhile.
- **Audit.** `property.assignment_changed` records the actor's role and the
  previous and new responsible user and group, committed with the change.

No route or page calls it.

## Decision 4 — A group's deletion ungroups its Properties

The deletion runs under 6G's lock on the group row (`FOR UPDATE`). After its
ceiling check, and before the member rows go, it locks the group's Properties
in id order, clears their group and counts them. `group.deleted` records
`ungroupedPropertyCount` beside `removedMemberCount`. The Properties' responsible
users and all content are untouched.

## Decision 5 — A member's removal unassigns its Properties

The removal locks the member's row (`FOR UPDATE`; after the organization's
`OWNER` rows when the member is an `OWNER`, as in ADR-0059), checks that the
member still holds the role it was checked against, then locks the member's
Properties in id order, clears their responsible user and counts them, and only
then deletes the membership. `member.removed` records
`unassignedPropertyCount`. The Properties' groups are untouched. The removal is
never blocked by the Properties: `OWNER` and `ADMIN` still reach them and can
reassign them.

## Decision 6 — Concurrency

- **An assignment never names a member being removed or a group being deleted.**
  A creation or reassignment that writes a new responsible user or group takes
  the foreign key's share lock on the referenced row. A removal or deletion
  takes `FOR UPDATE` on that row before it reads the Properties. Either the
  assignment commits first, and the release finds, clears and counts it; or the
  release commits first, and the assignment fails on its foreign key and is told
  the assignment changed meanwhile. Both orders are tested.
- **The foreign key's lock is the lock.** The proposal described an explicit
  `FOR SHARE` on the group row. The foreign key's key-share lock gives the same
  guarantee against a deletion, without also serializing assignments with 6G's
  group permission changes.
- **A release locks its Properties before it writes them.** Locked, each stays
  assigned until the release commits, so a Property that a concurrent
  reassignment took away first is neither cleared nor counted. A group's
  deletion and a member's removal that release the same Properties lock them in
  the same (id) order, so neither deadlocks the other. Both orders are tested.
- **Lock order on every path:** the referenced membership or group, then
  Properties in id order, then group member rows.
- **Two reassignments** checked against the same assignments: the
  compare-and-set lets one apply; the other is told the assignment changed.
- **What the locks do not cover, and why that is safe.** Whether a chosen user
  is an eligible member, and which groups a `MANAGER` belongs to, are read
  without a lock. A role change or a group-membership change that commits in
  between gives the same result as if the creation or reassignment had
  committed just before it: role changes do not rewrite assignments, and
  ADR-0052 asks only that the `MANAGER` belonged to the group when it chose it.
  This is ADR-0058's and ADR-0060's reasoning.

## Decision 7 — Choices ADR-0052 does not make

Recorded in `docs/decisions/TODO.md` for confirmation:

1. **When a responsible user leaves the organization, its Properties become
   unassigned.** The removal is not blocked, and `member.removed` records how
   many.
2. **Any member but `BILLING` may be chosen as a responsible user.** `BILLING`
   holds no content permission. A later role change keeps an existing
   assignment.
3. **An `OWNER` or `ADMIN` who chooses nothing leaves both assignments unset.**
   There is no default to the creator; `ORGANIZATION` scope reaches the
   Property anyway.
4. **A `MANAGER` in no group cannot create a Property**, because ADR-0052 allows
   no ungrouped `MANAGER` Property; one in several groups must name one.
5. **Reassignment needs the `OWNER` or `ADMIN` role**, not a permission.
6. **An assignment that changes nothing writes nothing.**

## Consequences

- **HTTP.** `GET /api/properties` returns each Property with two more fields,
  `responsibleUserId` and `groupId`. Both are `null` on every existing Property.
  No route accepts either.
- **Ports.** `PropertyRepository.create` takes its audit entry and answers
  `CREATED` or `STALE`; `PropertyRepository.update` never writes the
  assignments; `PropertyRepository.assign` is new.
  `MembershipRepository.remove` builds its audit entry from the number of
  Properties it unassigned; `DeletedGroup` gains `ungroupedPropertyCount`;
  `GroupRepository.listGroupIdsForMember` is new.
- **Test doubles.** The in-memory Property repository is built on the identity
  doubles: it writes to their audit log, mirrors both foreign keys, and is
  released by their member removal and group deletion.
- **Deleting a user or an organization** (neither is built) must release
  assignments the same way. The memberships' cascade from either is otherwise
  refused by the new foreign keys.
- **MFA is still not built.** It must exist before any member, permission,
  group or assignment screen ships.

## Not decided here

- Enforcing reach on every content path (6I): the `GROUP` and `OWN` predicates,
  children inheriting their Property, and how an out-of-reach Property is
  answered.
- Any route or page for choosing or changing an assignment.
- User deletion and its 30-day video lifecycle.
