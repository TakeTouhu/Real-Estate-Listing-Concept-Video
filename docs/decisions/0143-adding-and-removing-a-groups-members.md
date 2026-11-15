# ADR-0143 — Adding and removing a group's members from the groups page

Status: Accepted (AT-9c, 2026-11-15). Third and last part of AT-9 in the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "Groups page". AT-9a
listed and created groups (ADR-0141), AT-9b renamed and deleted one
(ADR-0142); this part adds and removes a group's members.

Builds on: ADR-0057 (the role-assignment ceiling), ADR-0060 (adding or
removing a member needs `group.manage` and the ceiling on the member's role;
a membership change writes no role, so it needs no compare-and-set on it),
ADR-0061 (a group that carries permissions gives and takes them under the
grant ceiling), ADR-0064 (a `MANAGER` reaches the Properties of its groups),
ADR-0141 (the groups page, its overview and who sees addresses) and ADR-0142
(the group routes' codes and id bound).

## Context

`GroupService.addMember` and `GroupService.removeMember` have existed since
Phase 6F, with their permission and ceiling checks, their audit entries and,
since Phase 6G, the grant ceiling under the group's lock. No page or route
called them, so a group created on the groups page stayed empty, and a
`MANAGER` reached no Property through one. This ADR adds both to the groups
page. It adds no rule about who may change a group's members, and no effect
of a change: every refusal and every effect is the group service's and the
database's, as built.

---

## Decision 1 — The overview says whom the viewer may add and remove

`GroupsOverviewService.overview` (ADR-0141) now also gives:
- for each member of a group, `mayRemove`: the viewer holds `group.manage`
  and may assign the member's role (`mayAssignRole`, ADR-0057);
- for each group, `addable`: the organization's members not in the group
  whose role the viewer may assign, for a holder of `group.manage`, in the
  members page's order; none for anyone else.

These are the service's own first two questions, asked of the roles as the
overview read them. Today only an `OWNER` or `ADMIN` passes the ceiling for
anyone, and both hold `group.manage` by template. So an `OWNER` may add and
remove anyone, itself included; an `ADMIN` only `MANAGER`, `CREATOR` and
`VIEWER` members; and a `MANAGER` granted `group.manage` sees no member form.

An address is shown as before: only to a viewer who also holds
`member.view`. The overview now also reads the accounts of the members the
viewer may add, in the same single read of accounts.

## Decision 2 — An add form on each group

A group with someone to add shows a closed **Add member…** form: one
required list of the members the viewer may add, each as its name, address
(where shown) and role. Its post is
`POST /api/organizations/{id}/groups/{groupId}/members`, field `userId`.

It calls `GroupService.addMember`, which asks, in this order:
1. `group.manage` (a refusal is audited);
2. the group, of this organization;
3. the member, of this organization;
4. the role-assignment ceiling on the member's role (audited);
5. then, under the group's lock, the grant ceiling for each permission the
   group carries (audited, ADR-0061). Groups carry none until AT-11.

Adding a member already in the group writes and audits nothing, as before,
so the page says the member is in the group rather than that they were
added.

## Decision 3 — A remove form on each member the viewer may remove

Each such member shows a closed **Remove…** form. Opened, it says what
removing does before its one button: the member leaves the group and loses
only what it gave them, so a `MANAGER` no longer reaches the Properties
assigned to it (ADR-0064); they stay in the organization with their role.
Its post is
`POST /api/organizations/{id}/groups/{groupId}/members/{userId}/remove`, with
no field. It calls `GroupService.removeMember`, which asks the same
first four questions, then the grant ceiling for what the group gave.

**Neither form carries the role the page showed.** The role change and
removal of the members page do (ADR-0139, ADR-0140), because they write the
role. A group membership change writes none: the ceiling is judged on the
role as the service reads it, and the result is the same as if the change
had committed just before any role change (ADR-0060 Decision 3). A member
whose role changed since the page was shown is judged on the new role.

## Decision 4 — A missing group or member says which

Adding and removing a group's member answered four different absences
with `NOT_FOUND`, told apart only by their messages. Each now carries
`details.reason`, as a refused name does (ADR-0141); the type is
`GroupNotFoundReason`:
- `GROUP`: no such group in this organization;
- `MEMBER`: no such member of this organization;
- `STALE`: an addition found the group or the member's membership gone as
  it wrote;
- `NOT_IN_GROUP`: a removal of a member who is not in the group, also when
  the group went as the removal wrote.

Codes, messages and audit entries do not change. A missing group carries
`GROUP` wherever the service answers one. Revoking a permission the group
does not carry still answers `NOT_FOUND` without a reason, until AT-11
offers revoking on a page.

## Decision 5 — Codes, and a member id from the address

Each route refuses a post whose `Origin` is not this site with `403` before
anything is read, and sends a signed-out visitor to `/login`. Every other
answer is `303` to the groups page with exactly one code:

| Code | Route | When |
| --- | --- | --- |
| `notice=group-member-added` | add | added (`group.member_added`), or already in the group |
| `notice=group-member-removed` | remove | removed (`group.member_removed`) |
| `error=group-gone` | both | `GROUP`, or a group id longer than 64 characters |
| `error=group-member-gone` | both | `MEMBER` (including no `userId`), or a member id longer than 64 characters |
| `error=group-members-changed` | add | `STALE` |
| `error=not-in-group` | remove | `NOT_IN_GROUP` |
| `error=may-not-add-group-member` | add | `FORBIDDEN`: no `group.manage`, past either ceiling, or no member |
| `error=may-not-remove-group-member` | remove | `FORBIDDEN`, likewise |
| `error=add-group-member-failed`, `error=remove-group-member-failed` | each | anything else |

**A member id longer than 64 characters is answered before the service is
asked,** as a group id is (ADR-0142) and as the members page's routes bound
a member's id (ADR-0139). A refused change is audited against the member id
it named. An empty one is asked: the permission comes first, so a refusal
keeps its audit entry, and an allowed actor then finds no such member.

Names never go into the address or the log. A failure that is not a refusal
is logged with the error's code alone.

## Consequences

- Two routes and two forms are new. There is no migration, permission or
  audit action. An addition is audited as `group.member_added` and a
  removal as `group.member_removed`, each with the member's role, and each
  refusal as `group.change_refused` with `operation: "add_member"` or
  `"remove_member"`, as before.
- The groups dormancy test now allows the service's `create`, `rename`,
  `delete`, `addMember` and `removeMember`, each called once in
  `apps/web/src/lib/groups.ts`, and each route's function from its own route
  only. The membership dormancy test's `.removeMember(` pin now excludes the
  group service's call, which the groups test pins.
- The browser test of the groups page adds its owner to the group it
  created, removes them, and then renames and deletes the group.
- With AT-9c, AT-9 is complete. AT-10 assigns a Property to a group or a
  responsible user from the product.
