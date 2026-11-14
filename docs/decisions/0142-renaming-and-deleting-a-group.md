# ADR-0142 — Renaming and deleting a group from the groups page

Status: Accepted (AT-9b, 2026-11-14). Second part of AT-9 in the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "Groups page". AT-9a
listed and created groups (ADR-0141); this part renames and deletes one;
AT-9c adds and removes a group's members.

Builds on: ADR-0052 Decision 11 (only an `OWNER` or `ADMIN` deletes a group,
whose Properties become ungrouped), ADR-0060 (renaming and deleting need
`group.manage`; a rename applies only to the name it was checked against; a
deletion names the group as it locked it), ADR-0061 (deleting a group that
carries permissions takes them from its members, under the grant ceiling),
ADR-0062 Decision 4 (a deletion ungroups and counts the group's Properties),
ADR-0139 and ADR-0140 (a form carries what the page showed), and ADR-0141
(the groups page, its codes and its overview's `mayManage` and `mayDelete`).

## Context

`GroupService.rename` and `GroupService.delete` have existed since Phase 6F,
with their permission checks, their audit entries and the deletion's lock.
No page or route called them. An organization could create a group (AT-9a)
but not correct its name or remove it. This ADR adds both to the groups page.
It adds no rule about who may rename or delete a group, and no effect of a
deletion: every refusal and every effect is the group service's and the
database's, as built.

---

## Decision 1 — A rename form on each group, carrying the name the page showed

A holder of `group.manage` (the overview's `mayManage`) sees a closed
**Rename…** form on each group: one name field holding the group's name,
required, at most 100 characters. A hidden field `from` carries the name the
page showed. Its post is `POST /api/organizations/{id}/groups/{groupId}/rename`,
fields `name` and `from`.

`GroupService.rename` takes the shown name as an optional `seenName`, as
`MembershipService.changeRole` takes the role the page showed (ADR-0139). It
asks, in this order:
1. `group.manage` (a refusal is audited, as before);
2. the new name (`INVALID_NAME`);
3. the group, of this organization (`NOT_FOUND`);
4. the group still named as the page showed it (`STALE`);
5. then it renames only while the group still has that name, as ADR-0060
   built (`STALE`, or `NAME_TAKEN`).

Without the shown name, a rename posted from a page that showed an older
name would silently replace a rename someone else had made since. A form
without `from` carries an empty name, which no group has, so it is stale.
It is still asked after the permission, as ADR-0139 asks the role shown, so
a refusal keeps its audit entry.

A stale rename's `VALIDATION_FAILED` now carries `details.reason` `STALE`,
beside the name reasons of ADR-0141. The type is `GroupRenameRefusal`. Its
message and audit do not change. Renaming a group to the name it has writes
and audits nothing, as before, so the page says the name was saved rather
than that the group was renamed.

## Decision 2 — A delete form on each group, for an `OWNER` or `ADMIN` holding `group.manage`

The overview's `mayDelete` (ADR-0141) is `group.manage` and the `OWNER` or
`ADMIN` role. Such a viewer sees a closed **Delete…** form on each group.
Opened, it says what deleting does before its one button:
- the group's members stay in the organization with their roles, and lose
  only what this group gave them;
- Properties assigned to it are left with no group, so no Manager reaches
  them through it (ADR-0062, ADR-0064);
- nothing else is deleted, and it cannot be undone.

Its post is `POST /api/organizations/{id}/groups/{groupId}/delete`, with no
field. It calls `GroupService.delete`, which asks `group.manage`, then the
role, then, for a group that carries permissions, the grant ceiling for each
member and permission (ADR-0061). Each refusal is audited and answered with
one sentence. Groups carry no permissions until AT-11, so today only the
first two can refuse.

**The deletion names the group by its id alone.** A rename committed
meanwhile does not stop it: it is the same group, and its audit entry
records the name the deletion locked (ADR-0060). Members added meanwhile
are counted in that entry too.

## Decision 3 — Codes, and a group id from the address

Like the members page's routes (ADR-0136), each route refuses a post whose
`Origin` is not this site with `403` before anything is read, and sends a
signed-out visitor to `/login`. Every other answer is `303` to the groups
page with exactly one code:

| Code | Route | When |
| --- | --- | --- |
| `notice=group-renamed` | rename | renamed, or the name it had (`group.renamed` only for a change) |
| `notice=group-deleted` | delete | deleted (`group.deleted`) |
| `error=group-name` | rename | `INVALID_NAME`, or no `name` field |
| `error=group-name-taken` | rename | `NAME_TAKEN` |
| `error=group-changed` | rename | `STALE`, or no `from` field |
| `error=group-gone` | both | `NOT_FOUND`: no such group in this organization, or an id longer than 64 characters |
| `error=may-not-rename-group` | rename | `FORBIDDEN`: no `group.manage`, or no member of this organization |
| `error=may-not-delete-group` | delete | `FORBIDDEN`: no `group.manage`, not an `OWNER` or `ADMIN`, past the grant ceiling, or no member |
| `error=rename-group-failed`, `error=delete-group-failed` | each | anything else |

**A group id longer than 64 characters is answered `group-gone` before the
service is asked.** A group's id is 20 characters. A refused rename or
deletion is audited against the group id it named, so an id the address
carries would otherwise reach the audit log at any length. The members
page's routes bound a member's id the same way (ADR-0139).

Names never go into the address or the log. A failure that is not a refusal
is logged with the error's code alone.

## Consequences

- Two routes and two forms are new. There is no migration, permission or
  audit action. A rename is audited as `group.renamed` and a deletion as
  `group.deleted`, each refusal as `group.change_refused` with
  `operation: "rename"` or `"delete"`, as before.
- `GroupService.rename` takes an optional fifth argument, `seenName`.
  Callers that pass none rename as before.
- The groups dormancy test now allows the service's `create`, `rename` and
  `delete`, each called once in `apps/web/src/lib/groups.ts`, and each of
  `renameGroup` and `deleteGroup` from its own route only. AT-9c widens it.
- The browser test of the groups page renames the group it created, then
  deletes it.
- AT-9c adds and removes a group's members under the role-assignment ceiling
  (ADR-0060).
