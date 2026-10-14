# Phase 6H gap analysis — Property assignment

Status: implemented on branch `claude/project-thread-az06z2`.
Base: `main @ e0b4d19` (PR #80, Phase 6G, merged 2026-10-14; migration 22 is the
latest).

Authority: ADR-0052 Decision 10 (*the Property is the authorization root*;
*`OWN` means the explicitly assigned responsible user, never the creator*;
*a Property is assigned to zero or one group*; *only `OWNER` and `ADMIN` change
either assignment*; *creation-time assignments by creator role*; *every
selected user or group belongs to the same organization*; the creation and
assignment audit evidence), ADR-0052 Decision 11 (*deleting a group ungroups
its Properties, and the audit records how many*), ADR-0059 (a change commits
with its audit entry), ADR-0060 and ADR-0061 (groups, their lock).

## Why this package is next

Role templates, individual grants, groups and group permissions exist (6C to
6G). Scope is the last part of ADR-0052 Decision 10. It needs two durable
relationships that do not exist yet: a Property's responsible user, for `OWN`,
and a Property's group, for `GROUP`. This package adds them and every rule that
writes them. Enforcing reach on the content paths follows as 6I.

## Gap

| Concern | Today (after Phase 6G) | Required | Where |
| --- | --- | --- | --- |
| Responsible user | none; only the immutable `createdBy` | a nullable assignment to a member of the same organization | migration 23, `properties.responsibleUserId`, composite foreign key to `memberships` |
| Property group | none | zero or one group of the same organization | migration 23, `properties.groupId`, composite foreign key to `groups` |
| Creation-time assignment | none | by creator role: `OWNER`/`ADMIN` choose or leave unset; `MANAGER` fixed to itself and one of its own groups; `CREATOR` fixed to itself, ungrouped | `PropertyService.create` |
| Reassignment | none | `OWNER`/`ADMIN` only, by role; `property.edit` alone does not authorize it | `PropertyService.assign` |
| Group deletion | removes members and permissions | also ungroups its Properties and records how many | `GroupRepository.delete` |
| A member leaving the organization | removes grants and group memberships | also releases its responsible-user assignments and records how many | `MembershipRepository.remove` |
| Audit | `property.created` with the type only, written after the row | `property.created` with the creator's role and both initial assignments, `property.assignment_changed` with previous and new values, refusals as `property.assignment_refused`, each committed with its change | the property repository's transactions |
| Concurrency | — | an assignment never names a group being deleted or a member being removed | the foreign key's share lock on the referenced row; the removal or deletion locks that row first, then the Properties in id order |

## Choices ADR-0052 does not make (defaults taken, recorded in `TODO.md`)

1. **When a responsible user leaves the organization, its Properties become
   unassigned**, and `member.removed` records how many. The removal is not
   blocked.
2. **Any member but `BILLING` may be a responsible user.** `BILLING` holds no
   content permission.
3. **An `OWNER` or `ADMIN` who chooses nothing leaves both assignments unset.**
   There is no default to the creator.
4. **A `MANAGER` with no group cannot create a Property**, because ADR-0052
   allows no ungrouped `MANAGER` Property. One in several groups must name one.
5. **Reassignment needs the `OWNER` or `ADMIN` role**, not a permission.
6. **An assignment that changes nothing writes nothing** (`changed: false`).

## Out of scope

- Enforcing reach on any content path (6I). Until then every member reaches
  every Property of its organization, as today.
- Any route or page for reassignment, and any assignment field on the create
  form. `POST /api/properties` passes no assignment, so an `OWNER` creates
  exactly as today.
- MFA, which must land before any member, group, permission or assignment
  screen.

## Milestone

One PR (6H):
- migration 23 and the Prisma model;
- the `PropertyRepository` port with its Prisma and in-memory implementations,
  creation and reassignment committed with their audit entries;
- `PropertyService.create`'s assignment rules and `PropertyService.assign`;
- releasing assignments on group deletion and on a member's removal;
- unit, database and shape suites, including deterministic races;
- the mutation pass;
- ADR-0062 and the phase documentation.

**No backfill.** Every live organization has only `OWNER` members, because no
route adds a member, so every existing Property was created by an `OWNER`.
ADR-0052 lets an `OWNER`'s Property start unassigned.

**Dormant:** reach is not enforced and no route changes. Paid Provider
Activation, production credentials, the production scheduler and live Stripe
charges remain BLOCKED.
