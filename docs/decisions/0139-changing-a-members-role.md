# ADR-0139 — Changing a member's role from the members page

Status: Accepted (AT-8a, 2026-11-11). First part of AT-8 in the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "change a member's
role, remove a member". This part changes roles; removing a member is AT-8b.
Builds on: ADR-0052 Decision 10 (roles, their fixed scopes, the ceiling),
ADR-0057 (the ceiling on every membership path), ADR-0058 (grants survive a
role change), ADR-0059 (a change applies only to the role it was checked
against, and never takes the last `OWNER` away), ADR-0134 and ADR-0136 (the
members page and its form posts), ADR-0065 Decision 18 (who must use MFA).

## Context

`MembershipService.changeRole` has existed since Phase 6C with the ceiling,
the last-`OWNER` lock and the audit entry, and no page or route has called it.
An organization's `OWNER` could invite a colleague with a role (AT-6b) but
never change it afterwards. This ADR puts the role change on the members page.
It adds no rule about who may give which role: every refusal is the membership
service's.

---

## Decision 1 — A role form on each member the viewer may move

The members overview now answers `assignableRoles`: the roles the viewer may
give a member. That is every role the viewer's role may assign
(`mayAssignRole`) when the viewer holds `permission.manage`, the permission a
role change needs (ADR-0057), and none otherwise. By template an `OWNER` gets
all six roles, an `ADMIN` gets `MANAGER`, `CREATOR` and `VIEWER`, and everyone
else gets none. The ceiling goes by role, so a `MANAGER` granted
`permission.manage` still gets none. Each member now carries its `userId`,
which names it for the change. It is an account's id and opens nothing.

A role change asks the ceiling of the role the member holds and of the new
one. So the page shows a form on a member only when the member's role is in
`assignableRoles`, and the form offers the other roles in it, none chosen to
begin with. An `ADMIN` sees forms on `MANAGER`, `CREATOR` and `VIEWER` members
only, offering the other two of those three.

**The form carries the role it shows** (`from`). ADR-0059 applies a change
only to the role its ceiling was asked of, but that read is the post's, not
the page's. Without `from`, an `OWNER` whose page still shows a Creator
another `OWNER` has since made an `OWNER` would demote that `OWNER` by
choosing Viewer, a change it never saw. With it, the change applies only
while the member holds the role the page showed (Decision 3).

**Not on the viewer's own row.** The service lets an `OWNER` demote itself
while another `OWNER` remains, but one press would take away the authority to
undo it, and the other `OWNER` can make the change instead. Stepping down and
leaving an organization are recorded in `TODO.md`. An `ADMIN` could not change
its own role anyway (ADR-0057).

Above the list, a viewer with a role to give reads what a change does, in the
terms the rules already fix:

- the role decides what the member can do and which Properties they reach
  (its fixed scope, ADR-0052 Decision 10);
- the member keeps their individual permissions, groups and Property
  assignments (ADR-0058, ADR-0052);
- an `OWNER`, `ADMIN` or `BILLING` member, and anyone allowed to manage
  permissions or billing by any grant, must use two-step sign-in (ADR-0065
  Decision 18). It is read from the memberships on every request, so a
  member made one is asked to set it up at their next page.

Hiding a form only spares a refusal. The service decides every post, and a
post the page did not offer is refused and audited as before.

## Decision 2 — One form post, answered with the page and a fixed code

`POST /api/organizations/{id}/members/{userId}/role`, fields `role` and
`from`, calls `MembershipService.changeRole`. Like the invitation routes
(ADR-0136), it refuses a post whose `Origin` is not this site with `403`
before anything is read, and sends a signed-out visitor to `/login`. Every
other answer is `303` to the members page with exactly one code:

| Code | When | The page says |
| --- | --- | --- |
| `notice=role-changed` | changed, or already that role | the member's abilities and reach follow the new role now |
| `error=new-role` | `role` is not a role; the service is not asked | choose the member's new role |
| `error=may-not-change-role` | `FORBIDDEN`: the poster is a member without `permission.manage` or past the ceiling (both audited), or no member of this organization | cannot give that member that role |
| `error=not-a-member` | `NOT_FOUND`: no such member here; or an id longer than 64 characters, which no account has, refused unread | that person is not a member |
| `error=last-owner` | `LAST_OWNER` | the organization must keep an Owner |
| `error=member-changed` | `STALE`: the member no longer holds the role the page showed, or did not by the time of the write; or `from` is not a role, the service not asked | check the role below and change it again if needed |
| `error=role-change-failed` | anything else | check below whether the role changed |

The page shows a known code's fixed sentence and nothing for any other value
or a repeated parameter. A member of another organization is answered as an
unknown one (`not-a-member`). Anything else is logged with the error's code
alone. An account's id is 20 characters, so bounding the path's id at 64
keeps a crafted one out of the refusal's audit entry.

## Decision 3 — Three refinements in the membership service

- **`changeRole` takes the role the page showed** (`seenRole`, optional).
  Given it, a member who holds another role is refused `STALE` and nothing is
  written. It is asked after the ceiling, so a post naming a wrong role
  never spares a refusal its audit entry. An `ADMIN` whose page is older
  than a promotion to `ADMIN` is therefore refused and audited, as any post
  past its ceiling is; the entry records the role the member held.
- **A change to the role the member holds writes nothing.** After the
  ceiling, which a refusal still audits, the service returns the membership
  as it is: no write and no `member.role_changed` entry, since nothing
  changed. The page never offers the role shown, so only a crafted post
  lands here, and it is answered as changed.
- **A refusal that wrote nothing says why in `details.reason`:**
  `LAST_OWNER` or `STALE` (ADR-0059), so the route need not read the message.
  The messages are unchanged. Removing a member (AT-8b) uses the same two.

## Consequences

- One route and the form are new. There is no migration, permission or audit
  action; a change is audited as `member.role_changed` with the previous
  role, the new one and its scope, and a refusal as
  `member.role_change_refused`, as before.
- A seat is a seat whatever its role, so a change frees or takes none.
- An invitation a member sent is accepted only while the inviter can still
  give its role (ADR-0137). Moving an inviter below that role leaves the
  invitation pending, holding its seat until it expires or is cancelled, and
  its acceptance is refused. The members page shows it with a cancel button.
- The dormancy test now allows `changeRole` in `lib/members.ts` only, called
  from this route. Removing a member still has no caller (AT-8b).
- The browser test of joining by invitation goes on: the owner makes the new
  colleague a Viewer, and the colleague's organizations page says so.
