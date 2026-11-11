# ADR-0135 — Invitations within the seats, and cancelling one

Status: Accepted (AT-6a, 2026-11-11). Second part of stage B, the team, of the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): an invitation needs a
free seat, counting members and pending invitations; an organization with no
plan cannot invite; an invitation is valid for 7 days; one pending invitation
per email address.
Builds on: ADR-0057 (roles and the role-assignment ceiling), ADR-0059
(membership changes), ADR-0126 (the email port), ADR-0129 (links on the
configured base address), ADR-0134 (what a seat is).

## Context

`MembershipService.invite` (Phase 6E) asked the role ceiling and refused a
second pending invitation of an address, but only by a read before writing:
two invitations sent at once could both pass it. Nothing counted seats and
nothing sent the invitation. ADR-0134 defined a seat: every member takes one,
and so does every pending invitation that has not expired. Its review found
that an invitation nobody opened stays `PENDING` past its expiry, so its
address could never be invited again (`TODO.md`).

This milestone builds the rules in the domain and the database, with no route:
AT-6b adds the members page's invite form and its cancel buttons, and AT-7 the
page that accepts an invitation.

---

## Decision 1 — An invitation needs a plan and a free seat, counted where it is written

The seats are the plan's included users (ADR-0134). An organization with no
plan is refused (`NO_PLAN`) before anything is written. A plan whose first
period has not started yet gives its included users: inviting needs a seat,
and such a plan has them. This is the gate ADR-0134 left open; the product
owner's answer is recorded in `TODO.md`.

The invitation is written in one transaction that first locks the
organization's row (`FOR NO KEY UPDATE`), so invitations to one organization
are made one at a time. Within it, members plus pending invitations that have
not expired are counted; at or above the seats the invitation is refused
(`NO_SEAT`) and nothing more is written. Two invitations racing for the last
seat make one. `NO KEY UPDATE` lets writes that only refer to the organization,
such as an audit entry or a Property, go on meanwhile.

The plan is read before the transaction. A plan changed between that read and
the count can let one invitation through on the old number; plans change only
when VTaVision provisions them. Inviting never buys a seat (ADR-0053 Decision
5A), and a refusal says every seat is taken.

## Decision 2 — One pending invitation per address

Migration 34 adds a unique index on `(organizationId, email)` over the rows
whose status is `PENDING`. Under the lock above it is a backstop: a second
pending row from any path is refused by the database.

An invitation past its expiry no longer holds its address. The inviting
transaction first marks `EXPIRED` the address's pending invitation that has
expired, then checks. This closes the `TODO.md` item from AT-5. An invitation
of an address with a pending invitation is refused (`ALREADY_INVITED`), and so
is the address of an account that is already a member (`ALREADY_MEMBER`).
Addresses are compared as stored, lower case. An address mail cannot reach is
refused (`INVALID_EMAIL`) before anything else is asked.

Every refusal is a `VALIDATION_FAILED` naming its reason in `details.reason`,
for AT-6b's page to say which. Authorization comes first: a member without
`member.manage`, or one inviting past its ceiling, is refused and audited as
before, whether or not the organization has a plan.

## Decision 3 — The invitation email

The email says which organization invites, as which role, and when the
invitation expires, and carries one link, in plain text (kind `INVITATION`,
ADR-0126). The organization's name is the customer's text, so it is kept to
one line. The link's address is built by the application from its configured
base address, never from a request (ADR-0129); its page is AT-7's.

The email is built before anything is written, so an application that cannot
mail writes nothing. It is sent after the invitation and its audit entry are
kept, as a password reset link is (ADR-0131). If sending fails, the invitation
stays pending and the inviter gets the error. The plan has no resend: the
inviter can cancel and invite again (AT-6b).

The product's invitation works for 7 days (`INVITATION_TTL_SECONDS`, now in
the domain; the web app's own constant is gone).

## Decision 4 — Cancelling an invitation

Cancelling takes the invited role away before anyone holds it, so it asks what
removing a member asks: `member.manage`, and the role ceiling of the invited
role (an `ADMIN` cannot cancel an `ADMIN`'s invitation). A refused member is
audited (`member.role_change_refused`, operation `cancel_invitation`); someone
outside the organization is refused unaudited, as everywhere.

Only a pending invitation of the organization that has not expired can be
cancelled; anything else is `NOT_FOUND`, another organization's included. It
becomes `REVOKED` with an `invitation.revoked` entry naming its address and
role, in one transaction, and only if it is still pending then: a cancellation
and an acceptance racing end with one of them. Its seat is free at once, and
its link accepts nothing.

## Consequences

- Migration 34, one partial unique index. No existing row is changed.
- `MembershipService` now needs the plan's seats (`includedSeatsFrom` reads
  the subscription), an email sender and the link builder. The web app built
  it with none of these and called none of its writes, so it no longer builds
  it; AT-6b does, for its routes.
- The invitation repository's `create` counts and refuses in its transaction,
  and gains `find` and `revoke`. `findPending`, which read the status alone, is
  gone.
- New audit action `invitation.revoked`.
- No page or route invites or cancels yet: the dormancy test in
  `role-templates-shape.test.ts` still finds no caller in either application.
- Acceptance is unchanged here. AT-7 checks the invited, verified address, and
  needs a free seat counting members only, under the same lock.
