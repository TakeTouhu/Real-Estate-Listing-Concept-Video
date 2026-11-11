# ADR-0136 — Inviting and cancelling from the members page

Status: Accepted (AT-6b, 2026-11-11). Second part of AT-6 in the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): the members page gets
an invite form that offers only the roles the inviter's ceiling allows, an
invitation is refused when no seat is left (and the page then says a billing
user must buy a seat), and a pending invitation can be cancelled.
Builds on: ADR-0134 (the members page), ADR-0135 (the rules for inviting and
cancelling), ADR-0126 (the development outbox), ADR-0129 (`APP_BASE_URL` and
the mailer), ADR-0068 (a same-origin form post).

## Context

AT-6a built the rules in the domain and the database and left them dormant:
no page or route invited or cancelled, and the web app did not build a
`MembershipService`. This ADR puts the rules on the members page. It adds no
rule: every refusal is the membership service's (ADR-0135).

---

## Decision 1 — The form, for a member who may invite with some role

The members overview now answers `invitableRoles`: the roles the viewer may
invite with. That is every role the role ceiling lets the viewer's role assign
(`mayAssignRole`), when the viewer holds `member.manage` from any grant
source, and none otherwise. By template an `OWNER` gets all six roles, an
`ADMIN` gets `MANAGER`, `CREATOR` and `VIEWER`, and everyone else gets none.
The ceiling goes by role, so a `MANAGER` given `member.manage` by an
individual grant still gets none, which matches what inviting would allow.

The page shows the form only when that list has a role in it:

- **No plan:** it says the viewer can invite once the plan is set up. There
  is no form, because inviting would be refused `NO_PLAN`.
- **Every seat taken:** it says what a `NO_SEAT` refusal says. Every seat is
  taken by a member or a pending invitation, inviting never adds a seat, and
  a member who manages billing must buy one, or an invitation can be
  cancelled. There is no form.
- **Otherwise:** an email address, a role chosen from that list (nothing is
  chosen to begin with), and a line saying the link works for 7 days and the
  invitation takes a seat until it is accepted, cancelled or expires.

Hiding the form only spares a refusal. The service decides every post, and a
post naming a role the page did not offer is refused and audited as before.

## Decision 2 — Cancel buttons, on invitations of roles the viewer may assign

Each pending invitation on the page now carries its id, which names it for
cancelling. The id is not the token, and accepts nothing. Cancelling asks
the ceiling of the invited role (ADR-0135 Decision 4), so the page shows
**Cancel invitation** only on invitations whose role is in
`invitableRoles`. An `ADMIN` sees no button on an `ADMIN` invitation, and
neither does a member who cannot invite. The button stays when every seat is
taken, since cancelling is how a seat is freed.

## Decision 3 — Two form posts, answered with the page and a fixed code

| Route | Fields | Does |
| --- | --- | --- |
| `POST /api/organizations/{id}/invitations` | `email`, `role` | `MembershipService.invite` |
| `POST /api/organizations/{id}/invitations/{invitationId}/cancel` | none | `MembershipService.cancelInvitation` |

Each route refuses a post whose `Origin` is not this site with `403`, before
anything is read (the unit-purchase route's check). A signed-out visitor is
sent to `/login`. Every other answer is `303` to the members page with
exactly one `notice` or `error` code:

| Code | When | The page says |
| --- | --- | --- |
| `notice=invited` | invited and mailed | the link works for 7 days |
| `notice=cancelled` | cancelled | the link no longer works, and its seat is free |
| `error=role` | the role is not a role; the service is not asked | choose a role |
| `error=email` | `INVALID_EMAIL` | enter an address an invitation can be sent to |
| `error=no-plan` | `NO_PLAN` | no plan yet, so no one can be invited |
| `error=already-invited` | `ALREADY_INVITED` | cancel the pending invitation to invite again |
| `error=already-member` | `ALREADY_MEMBER` | the address is a member's already |
| `error=no-seat` | `NO_SEAT` | the `NO_SEAT` sentence of Decision 1 |
| `error=may-not-invite` | `FORBIDDEN` on inviting (audited) | cannot invite with that role |
| `error=may-not-cancel` | `FORBIDDEN` on cancelling (audited) | cannot cancel this invitation |
| `error=gone` | `NOT_FOUND` on cancelling | no longer pending: accepted, cancelled or expired |
| `error=unavailable` | `CONFIGURATION_ERROR` before writing | cannot send now; nothing was saved |
| `error=invite-failed` | anything else on inviting | see Decision 4 |
| `error=cancel-failed` | anything else on cancelling | check below whether it is still pending |

The page shows the fixed sentence a known code names. It shows nothing for
any other value or for a repeated parameter. Nothing the address carries is
shown. The invited address and the token never go in the address. An
unknown invitation, another organization's, and one already cancelled are
answered alike (`gone`).

## Decision 4 — Failures that are not refusals

- **No outbox or no base address:** the link is built before anything is
  written (ADR-0135), so `getMailer` fails with `CONFIGURATION_ERROR` first,
  and the page says nothing was saved (`unavailable`).
- **The email fails once the invitation is kept:** the web app's sender wraps
  whatever the mailer throws, so this is never mistaken for the case above.
  The invitation stays pending, as ADR-0135 decided. The page says that if
  the invitation is listed, its email may not have been sent, and that it
  can be cancelled and sent again (`invite-failed`). The log says the
  invitation was kept and its email was not sent, with the error's code.
- **Anything else:** `invite-failed` or `cancel-failed`, logged with the
  error's code alone.

No log line carries the address, the token or the link.

## Decision 5 — The link opens `/accept-invitation`, which AT-7 builds

The invitation email's link is `{APP_BASE_URL}/accept-invitation?token=…`,
built on the configured base address and never on a request's (ADR-0129).
Until AT-7 builds that page, the link opens nothing. That is acceptable only
because the email reaches no one: it goes to the development outbox, which
production refuses (ADR-0126). The browser test reads it there.

## Decision 6 — No limit on inviting yet

Each pending invitation takes a seat, so an organization has at most its
seats' worth pending at once. Cancelling and inviting again sends again,
though. Only a holder of `member.manage` with the ceiling can do either, and
each is audited (`invitation.created`, `invitation.revoked`). The limit
belongs to the cross-cutting rate-limiting milestone (`TODO.md`). Inviting is
added there, to be in place before production gets an email service.

## Consequences

- Two routes, the form and the cancel buttons are new. There is no
  migration, permission or audit action.
- `MembersOverview` adds `invitableRoles`, and each pending invitation adds
  its `id`.
- The web app builds a `MembershipService` in `lib/members.ts`. The dormancy
  test now allows `invite` and `cancelInvitation` there only, called only from
  these two routes. Accepting an invitation, changing a role and removing a
  member still have no caller (AT-7 and AT-8).
- The browser test invites a colleague as Creator, sees the seat taken and
  the link mailed, then cancels and sees the seat free.
