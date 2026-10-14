# Phase 6F gap analysis — groups and group membership

Status: implemented on branch `claude/project-thread-az06z2`.
Base: `main @ 95cbedd` (PR #78, Phase 6E, merged 2026-10-13; migration 20 is the
latest).

Authority: ADR-0052 Decision 10 (*standard role templates + groups + Scope +
optional individual permissions*; *users may belong to multiple groups*; *no
role may escalate itself past its ceiling by any route, group membership
included*; *every role, permission, group and Property-assignment change
remains audited*), ADR-0052 Decision 11 (*group deletion is a protected
`OWNER`/`ADMIN`-only operation*), ADR-0057 (the role-assignment ceiling),
ADR-0058 (the grant ceiling), ADR-0059 (a change commits with its audit entry,
and writes nothing against state that has changed).

## Why this package is next

Templates (6C), individual grants (6D) and race-free membership changes (6E)
are built. Groups are the remaining building block of the ADR-0052 model. Both
later packages need them: group permissions (6G) and Property-rooted Scope (6H,
where a `MANAGER` reaches the Properties of its groups).

Built together with group permissions, the package would be about twice the
size the project's PR policy allows. So 6F builds groups and who belongs to
them, and nothing that a group confers. The ceiling on group permissions (6G)
is the riskiest part of the group model, and keeping it out of this PR lets it
be reviewed on its own.

## Gap

| Concern | Today (after Phase 6E) | Required | Where |
| --- | --- | --- | --- |
| Groups | none | a group belongs to one organization and has a name | migration 21, `groups` |
| Group membership | none | a member may belong to any number of the organization's groups; a group's member must be a member of the group's organization | migration 21, `group_members` |
| Tenant safety | — | no row may link a group of one organization to a member of another; every read is scoped by organization | composite foreign keys; `organizationId` on every repository call |
| Create, rename, list | — | `group.manage` to change, `group.view` to list | `GroupService` |
| Delete | — | `OWNER` or `ADMIN` only, even when another role holds `group.manage` | `GroupService.delete` |
| Membership changes | — | ceiling-checked: no role may use group membership to move past its ceiling | `GroupService.addMember` / `removeMember` |
| Audit | — | every change and every refused change by a member, the change committed with its audit entry | repository transactions; `group.*` actions |
| Member leaves the organization | — | their group memberships go with them | foreign key cascade |

## Choices ADR-0052 does not make (defaults taken, recorded in `TODO.md`)

1. **Group membership changes follow the role-assignment ceiling.** Adding or
   removing a member asks `mayAssignRole(actor, target)`, as a role change or
   an individual grant does:
   - an `OWNER` may change anyone's group membership;
   - an `ADMIN` may change only `MANAGER`, `CREATOR` and `VIEWER` members, so
     never its own;
   - any other role, even holding `group.manage` by grant, may change no
     one's.

   Membership will carry group permissions (6G) and `GROUP` reach (6H), so it
   is an authorization change on that member. This also stops a `MANAGER` that
   was granted `group.manage` from adding itself to groups to reach more
   Properties.
2. **A group name is required, trimmed, at most 100 characters, and unique
   within its organization** (exact match after trimming). Renaming to the
   current name changes nothing.
3. **Group memberships survive a role change**, as individual grants (ADR-0058
   Decision 4) and Property assignments do.

## Out of scope

- **Group permissions (6G).** Additive, with the grant ceiling on every group
  path, and `disclosure.none` made impossible on a group.
- **A Property's group and row Scope (6H).** The deletion audit gains the
  affected Property count there. Until then a group ungroups nothing, because
  no Property has a group.
- Any route or page, and user deletion.
- MFA, which must land before any member-management screen.

## Milestone

One PR (6F):
- migration 21 and the Prisma models;
- the `GroupRepository` port with its Prisma and in-memory implementations;
- `GroupService`;
- unit and database suites, including tenant isolation, forced audit failures
  and deterministic races;
- the mutation pass;
- ADR-0060 and the phase documentation.

**Dormant:** no HTTP route or page calls these operations. A group confers no
permission and no row access. Paid Provider Activation, production credentials,
the production scheduler and live Stripe charges remain BLOCKED.
