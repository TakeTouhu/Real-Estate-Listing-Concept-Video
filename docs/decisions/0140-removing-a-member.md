# ADR-0140 — Removing a member from the members page

Status: Accepted (AT-8b, 2026-11-12). Second part of AT-8 in the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "change a member's
role, remove a member". AT-8a changed roles (ADR-0139); this part removes a
member. The plan's default 6 applies: removing a member is not deleting their
account. Builds on: ADR-0052 Decision 10 (the ceiling, Property-rooted
access), ADR-0057 (removal needs `member.manage` and the ceiling of the
member's role), ADR-0058 (individual grants), ADR-0059 (a removal applies
only to the role it was checked against, never takes the last `OWNER` away,
and takes the member's grants with it), ADR-0060 (group memberships go with
it), ADR-0062 Decision 5 (a removed member's Properties are unassigned),
ADR-0137 (an invitation is accepted only while its inviter may still give
its role), ADR-0139 (the role the page showed).

## Context

`MembershipService.removeMember` has existed since Phase 6C with the ceiling,
the last-`OWNER` lock, the release of the member's Properties and the audit
entry, and no page or route has called it. An organization could add members
(AT-6, AT-7) and change their roles (AT-8a), but not remove one. This ADR
puts removal on the members page. It adds no rule about who may remove whom,
and no effect of a removal: every refusal and every effect is the membership
service's and the database's, as built.

---

## Decision 1 — A removal form on each member the viewer may remove

Removing a member needs `member.manage` and the ceiling of the role the
member holds (ADR-0057). Inviting with a role needs exactly that, so the
members overview's `invitableRoles` (ADR-0136) already names the roles whose
members the viewer may remove; no field is added. By template an `OWNER` may
remove a member of any role and an `ADMIN` a `MANAGER`, `CREATOR` or
`VIEWER`; everyone else may remove no one, and a `MANAGER` granted
`member.manage` still may not, since the ceiling goes by role.

The page shows the form on each such member, **never on the viewer's own
row**, for the reason ADR-0139 gives for roles: leaving an organization is a
product decision recorded in `TODO.md`. The service still lets an `OWNER`
remove itself while another `OWNER` remains (ADR-0057, ADR-0059), so a
crafted post can; the page does not offer it, and the other `OWNER` can make
the removal instead. An `ADMIN` could not remove itself anyway.

The form is closed at first (`<details>`). Opening it says what removing
does, then offers the **Remove member** button. What it says is what the
service and the database do:

- the member can no longer open the organization: every request reads the
  memberships, so their next one is refused; their account stays, and their
  sessions and other organizations are untouched. A short-lived signed
  download link handed out before the removal names one file, not a member,
  and works until it expires;
- the organization keeps its Properties, photos and videos, whose access is
  Property-rooted, never by who made them (ADR-0052 Decision 10);
- the Properties they are responsible for are left with no responsible user
  (ADR-0062 Decision 5), and their individual permissions and group
  memberships in the organization go with the membership (ADR-0058,
  ADR-0059, ADR-0060);
- invitations they sent cannot be accepted while they are not a member,
  since acceptance asks the inviter's membership again (ADR-0137); they stay
  listed, holding their seats, until cancelled or expired;
- their seat becomes free. The plan, its seats and its charges do not change.

**The form carries the role it shows** (`from`), as ADR-0139's role form
does. Without it, an `OWNER` whose page still shows a Creator another `OWNER`
has since made an `OWNER` would remove that `OWNER`, a removal it never saw.
With it, the removal applies only while the member holds the role the page
showed (Decision 3).

Hiding a form only spares a refusal. The service decides every post: a post
past the poster's permission or ceiling is refused and audited as before.

## Decision 2 — One form post, answered with the page and a fixed code

`POST /api/organizations/{id}/members/{userId}/remove`, field `from`, calls
`MembershipService.removeMember`. Like the role route (ADR-0139), it refuses
a post whose `Origin` is not this site with `403` before anything is read,
and sends a signed-out visitor to `/login`. Every other answer is `303` to
the members page with exactly one code:

| Code | When | The page says |
| --- | --- | --- |
| `notice=member-removed` | removed (`member.removed`) | they can no longer open the organization, and their Properties have no responsible user |
| `error=may-not-remove` | `FORBIDDEN`: the poster is a member without `member.manage` or past the ceiling (both audited), or no member of this organization | cannot remove that member |
| `error=not-a-member` | `NOT_FOUND`: no such member here; or an id longer than 64 characters, refused unread | that person is not a member |
| `error=last-owner` | `LAST_OWNER` | the organization must keep an Owner |
| `error=removal-member-changed` | `STALE`: the member no longer holds the role the page showed, or not by the time of the write, or is gone; or `from` is not a role, the service not asked | check below, and remove them again if needed |
| `error=removal-failed` | anything else | check below whether that person is still a member |

`not-a-member` and `last-owner` are AT-8a's codes and sentences, which fit
a removal as they are. The page shows a known code's fixed sentence and
nothing for any other value or a repeated parameter. A member of another
organization is answered as an unknown one. Anything else is logged with the
error's code alone. The bound on the path's id is AT-8a's
(`MEMBER_ID_MAX_LENGTH`, 64, where an account's id is 20 characters): an id
longer than any account's never reaches the refusal's audit entry.

## Decision 3 — `removeMember` takes the role the page showed

Given `seenRole`, a member who holds another role is refused `STALE` and
nothing is written. It is asked after the ceiling, so a post naming a wrong
role never spares a refusal its audit entry, exactly as `changeRole` does
(ADR-0139 Decision 3). The database's removal already applies only to the
role the ceiling was asked of, under the member's row lock (ADR-0059), so a
change landing between the read and the write is still `STALE`.

## Consequences

- One route and the form are new. There is no migration, permission or audit
  action; a removal is audited as `member.removed` with
  `unassignedPropertyCount`, and a refusal as `member.role_change_refused`
  with `operation: "remove_member"`, as before.
- A removed person can be invited again, and joins with the invited role and
  none of their earlier grants, groups or Property assignments.
- The pending invitations a removed member sent hold seats until a member
  who may cancel them does (an `ADMIN` only those for a `MANAGER`,
  `CREATOR` or `VIEWER`) or they expire. Whether a removal should cancel
  them is recorded in `TODO.md`, with an acceptance already past its check
  of the inviter when the removal commits.
- The dormancy test now allows `.removeMember(` in `lib/members.ts` only,
  called from this route through `removeOrganizationMember`.
- The browser test of joining by invitation goes on: the owner removes the
  colleague, and the colleague's organizations page no longer lists the
  organization.
