# ADR-0148 — A group's permissions on the groups page

Status: Accepted (AT-11c, 2026-11-16). Third and last part of AT-11 in the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "Individual grants and
group permissions, for holders of `permission.manage`, inside the ceilings
already built".

Builds on: ADR-0052 Decision 10 (the grant ceiling; `disclosure.none` only
to an individual), ADR-0061 (group permissions: what a group may carry, and
each change checked as a direct grant or revocation to every member it
reaches, under the group's lock), ADR-0065 Decisions 7 and 15 (who must use
MFA, and setting it up first, read on every request), ADR-0141 to ADR-0143
(the groups page, its form posts, renaming, deleting and changing a group's
members), ADR-0146 (how a permission is named) and ADR-0147 (individual
grants on a member's permissions page).

## Context

Group permissions have been built and enforced since Phase 6G: a member
holds what each of their groups carries, the MFA requirement counts it, and
every change and refusal is audited. No route reaches them, and the groups
page does not show them. The page also decides Delete, and whom it offers to
add to or remove from a group, from `group.manage` and the role-assignment
ceiling alone. That was exactly where the group service succeeds only while
no group carries a permission (`TODO.md`, AT-9b).

---

## Decision 1 — Who may give and take back, and how the page knows

Nothing changes who may change a group's permissions. `GroupService` decides
every post as built (ADR-0061):
1. `permission.manage`;
2. the ceiling's actor half, `groupGrantRefusal`: no group carries
   `disclosure.none` or `video.share`; `permission.manage` and
   `billing.manage` are `OWNER`-only; anyone else gives only what it holds;
3. under the group's lock, the ceiling's member half: the actor's role must
   be able to assign every member's role.

So an `OWNER` gives any group anything a group may carry. An `ADMIN` gives
what it holds, never `permission.manage` or `billing.manage`, and only to a
group whose members are all `MANAGER`, `CREATOR` or `VIEWER` members. Any
other role given `permission.manage` reaches only a group with no members,
and only with what it holds; whoever adds a member later must pass the
ceiling on everything the group gives. Every refusal of a member is audited
as `group.change_refused`, and every change commits with its audit entry,
as before. Someone who is not a member is refused unaudited.

The groups page's reading, `GroupsOverviewService.overview`, now also reads
the permissions of the organization's groups, in one read by the groups'
ids (`listPermissionsOfGroups`, by the primary key's leading column, so no
index or migration is needed). For each group it answers:
- `permissions`: what the group gives each of its members;
- `givable`: what the viewer may give it, of what it does not give;
- `revocable`: what the viewer may take back, of what it gives;
- `mayDelete`: Decision 2.

They are asked of the same `groupGrantRefusal` and `mayAssignRole`, with the
viewer's role and effective permissions and the members' roles as read. A
holder of `group.view` sees a group's permissions, as
`GroupService.listPermissions` already allows. A test checks, for an
`OWNER`, an `ADMIN`, a `MANAGER` given `permission.manage` and
`group.manage`, and a `BILLING` member given `group.view` and
`permission.manage`, and for five groups, that each answer is what the
service then does: for every permission, every member and the deletion.

## Decision 2 — Delete, add and remove, decided per group

The group service asks the grant ceiling of each of these too (ADR-0061),
and the page now asks the same:
- **Delete** takes each of the group's permissions from each of its members.
  It is offered to a holder of `group.manage` who is an `OWNER` or `ADMIN`,
  on a group that gives nothing, or whose permissions the viewer may take
  from every member. So an `ADMIN` is not offered Delete on a group giving
  `billing.manage`, nor on a group with an `OWNER`, `ADMIN` or `BILLING`
  member once it gives anything.
- **Add** and **Remove** give or take each of the group's permissions. They
  are offered, as before, for a member whose role the viewer may assign, and
  now only on a group whose permissions the viewer may give and take. So an
  `ADMIN` adds no one to, and removes no one from, a group giving
  `billing.manage`.

The organization-wide `GroupsOverview.mayDelete` is replaced by each
group's. This settles the AT-9b item in `TODO.md`.

## Decision 3 — What the page shows and offers

Each group says what it gives each of its members, by the names a member's
permissions page uses (ADR-0146), saying of one that nothing in VTaVision
uses it yet, and of `property.create` that it is never in effect for a
`VIEWER` or `BILLING` member; a group giving nothing says so.

- **Take back**, on each permission the group gives, where `revocable`.
- **Give a permission…**, a closed form listing what is `givable`, where
  there is any. A permission some members already hold by role is offered
  too: the group gives it to every member, now and later, so it is never a
  button that does nothing for all of them.

Opened, the form says before its list what giving brings:
- each member will hold it, and so will anyone added to the group later;
- it applies to the Properties their role reaches and never widens them
  (Scope stays fixed by role): an `OWNER`, `ADMIN` or `BILLING` member
  reaches every Property of the organization, a `MANAGER` the Properties of
  the groups they belong to, and a `CREATOR` or `VIEWER` the Properties they
  are responsible for. So a permission over Properties given to a group with
  a `BILLING` member reaches every Property of the organization, and the
  form says what each role reaches before anyone gives it;
- when `property.create` is offered: it is never in effect for a `VIEWER` or
  `BILLING` member;
- when `permission.manage` or `billing.manage` is offered: whoever holds it
  must use two-step sign-in. The requirement is read from the memberships on
  every request, group permissions included, so each member is asked to set
  it up at their next page (ADR-0065 Decisions 7 and 15);
- when `member.manage`, `group.manage` or `permission.manage` is offered:
  whatever a group gives, only an `OWNER` or `ADMIN` can act on other
  members (ADR-0146 Decision 3).

A group never carries `disclosure.none` or `video.share` (ADR-0061, and the
table's CHECK), so the page never offers them, and the group service needs
no list of withheld permissions, unlike the grant service (ADR-0147).

## Decision 4 — Two form posts, answered with the page and a fixed code

`POST /api/organizations/{id}/groups/{groupId}/permissions/grant` and
`.../revoke`, field `permission`, call `GroupService.grantPermission` and
`revokePermission`. Like the groups page's other routes (ADR-0141), each
refuses a post whose `Origin` is not this site with `403` before anything is
read, and sends a signed-out visitor to `/login`. A `groupId` over 64
characters is refused before the service is asked, so it never reaches the
audit log. Every other answer is `303` to the groups page with exactly one
code:

| Code | When | The page says |
| --- | --- | --- |
| `notice=group-permission-granted` | given, or given already (nothing written) | the group gives that permission now, to each of its members |
| `notice=group-permission-revoked` | taken back | the group no longer gives it; a member keeps it only if their role, an individual grant or another group gives it |
| `error=group-permission` | `permission` is missing or not one; the service is not asked | that permission cannot be given to a group or taken back here |
| `error=may-not-grant-group-permission` | the service refused giving: no `permission.manage`, past the ceiling for the viewer or for a member, `disclosure.none` or `video.share`, or the viewer is not a member | you cannot give that permission to this group |
| `error=may-not-revoke-group-permission` | the service refused taking back | you cannot take that permission back from this group |
| `error=group-permission-not-granted` | taking back a permission the group does not give | the group does not give it, so there was nothing to take back |
| `error=group-gone` | no such group in the organization, or a `groupId` over 64 characters | that group no longer exists |
| `error=grant-group-permission-failed`, `error=revoke-group-permission-failed` | anything else, logged by its error code alone | something went wrong; check below |

Taking back a permission the group does not give is now `NOT_FOUND` with
the reason `NOT_GRANTED`, as the group service's other `NOT_FOUND`s carry
theirs (ADR-0143), so the route tells it from a group that is gone.

A post carries nothing the page showed: the ceiling is asked again of the
group as it is locked when the post arrives, so a page shown before a member
joined can never give more than the ceiling allows then.

## Decision 5 — Reached through one module only

The Phase 6G shape test said no application calls a group's permissions. It
now says the web app's groups module alone asks the group service to give
and take them back, called for that from the two routes alone; the page
reads them through the groups overview. The Phase 6F shape test lists the
group service's seven calls from that module.

## Consequences

- No migration, permission, audit action or refusal reason. One repository
  read, and one `NOT_FOUND` reason.
- The browser test of groups now gives a group a permission and takes it
  back.
- AT-11 is complete; AT-12 (the browser test of the team and the completion
  report) follows.

## Not decided here

- A member given `permission.manage` whose role reaches no one may change
  the permissions of a group with no members, as ADR-0061 built it; the
  page offers what the service allows. It reaches no member, and whoever
  adds one must pass the ceiling on what the group gives. Recorded in
  `TODO.md` for confirmation.
