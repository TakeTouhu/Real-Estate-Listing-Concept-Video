# ADR-0137 — Accepting an invitation: the invited address, verified, within the seats

Status: Accepted (AT-7a, 2026-11-11). Third part of stage B, the team, of the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "The emailed link leads
the person to sign in, or to create an account with the invited email. Once
that email is verified, they join with the invited role. The ceiling and the
seat limit are checked again at acceptance." Its defaults: an invitation is
accepted only by an account with the invited email, once that email is
verified; acceptance needs a free seat, counting members.
Builds on: ADR-0057 (roles and the role-assignment ceiling), ADR-0059
(membership changes), ADR-0128 (a verified address), ADR-0134 (what a seat
is), ADR-0135 (invitations within the seats).

## Context

`MembershipService.acceptInvitation` (Phase 6C, ADR-0057) accepted for any
signed-in account that held the token: the link was the only key. It asked the
inviter's ceiling again, but counted no seat, and its transaction took no lock,
so two acceptances could each find the last seat free. AT-6a's review recorded
that acceptance must lock the organization's row and count in the transaction
that writes the membership (`TODO.md`).

This milestone builds the rules in the domain and the database, with no route,
as AT-6a did. AT-7b adds `/accept-invitation`, the route that accepts, and
carries the invitation through sign-in, sign-up, verification and MFA.

---

## Decision 1 — Only the invited address, once verified, accepts

The signed-in account's address must be verified (ADR-0128), or the
acceptance is refused (`EMAIL_NOT_VERIFIED`): anyone can sign up with an
address that is not theirs, and verification proves the mailbox the link was
sent to. The address must then be the invited address; both are stored in
lower case and compared as stored. Otherwise the acceptance is refused
(`WRONG_ACCOUNT`), also for a member of the organization holding a colleague's
link. A link that reaches someone else therefore accepts nothing for them.

Verification is asked first so that only an account that proved its mailbox
learns whether its address is the invited one. Asked the other way round, a
link holder could sign up with guessed addresses, never verify them, and read
from the two answers which guess was invited.

These refusals write nothing and are not audited. The refusal is the
protection, and it changes nothing in the organization: someone outside it is
refused without writing into its trail, as everywhere, and a member holding a
colleague's link is refused the same way. An account that is gone or disabled
is answered as email verification answers it, `NOT_FOUND` "Account not
found".

The checks run in this order, each before anything after it is read:

1. The invitation: a token of no invitation, or of one accepted, cancelled or
   marked expired, is `NOT_FOUND`. One past its expiry is refused
   (`EXPIRED`) and marked `EXPIRED`, as before.
2. Who accepts: the account, its verification, its address.
3. An account already a member is refused (`ALREADY_MEMBER`).
4. The inviter's ceiling, asked again as Phase 6C does: an inviter who left,
   lost `member.manage` or may no longer give the role makes the acceptance
   `FORBIDDEN`, audited (`member.role_change_refused`, operation
   `accept_invitation`). Since it comes after step 2, only the invitee's own
   attempt writes that entry; before, any account holding the link could.
5. The plan, then the seats (Decision 2).

## Decision 2 — A seat counting members, under the organization's lock

An organization with no plan has no seats, so the acceptance is refused
(`NO_PLAN`) before anything is written. The plan is read before the
transaction, as inviting reads it (ADR-0135 Decision 1).

The acceptance is written in one transaction that first locks the
organization's row (`FOR NO KEY UPDATE`), as inviting does, so invitations and
acceptances to one organization are made one at a time. It then reads the
instant, so an acceptance that waited behind an invitation is judged no
earlier than that invitation counted the seats: an invitation it found expired,
and whose seat it gave to another address, is not accepted afterwards. The
transaction runs at `READ COMMITTED`, set explicitly, since its counts after
the lock must see what committed before it; inviting's transaction now sets it
too. Within it:

- The invitation must still be pending and not expired at that instant;
  otherwise nothing is written (`STALE`, answered `NOT_FOUND`). This comes
  before the seats, so an invitation accepted twice at once is answered as
  already used, not as a full organization.
- The members are counted, as the approved plan says, and pending invitations
  are not: the invitation held its own seat while it was pending. At or above
  the seats nothing is written (`NO_SEAT`) and the invitation stays pending,
  so it can be accepted once a seat is free.
- The invitation becomes `ACCEPTED` at that instant only if it is still
  pending and not expired, since a cancellation takes no organization lock;
  then the membership with the invited role and `invitation.accepted` are
  written. A membership the key refuses is answered `ALREADY_MEMBER`, and the
  whole acceptance rolls back, as before (ADR-0059).

Two acceptances racing for the last seat make one member. An acceptance and
an invitation racing for it wait on each other, and the invitation's one
count (ADR-0135 Decision 1) sees the seat taken once, by the member or by the
pending invitation. This closes the `TODO.md` item from AT-6a's review.

Since every pending invitation already holds a seat, `NO_SEAT` happens only
when the organization's seats fell below its members and pending invitations
after they were made: a plan with fewer included users. Accepting never buys a
seat (ADR-0053 Decision 5A).

## Decision 3 — Each refusal names its reason

Every refusal above that is not `NOT_FOUND` or `FORBIDDEN` is a
`VALIDATION_FAILED` naming its reason in `details.reason`
(`AcceptanceRefusal`: `EXPIRED`, `EMAIL_NOT_VERIFIED`, `WRONG_ACCOUNT`,
`ALREADY_MEMBER`, `NO_PLAN`, `NO_SEAT`), for AT-7b's page to say which, as
inviting does (ADR-0135 Decision 2). The messages of an expired invitation and
of a member are unchanged. No refusal carries the invited address, so a page
can tell a wrong account apart without showing whoever holds the link the
address it was sent to.

## Consequences

- No migration, permission or audit action.
- `InvitationRepository.accept` takes the seats and a clock
  (`{ includedSeats, clock }`) in place of `acceptedAt`, and answers
  `NO_SEAT`. Both the inviting and the accepting transaction set
  `READ COMMITTED`, the database's default, explicitly.
  The in-memory double checks and writes with no `await` between, as the
  transaction does, and takes the acceptance back when its audit entry cannot
  be kept.
- No page or route accepts yet: the dormancy test in
  `role-templates-shape.test.ts` still finds no caller of `acceptInvitation`
  in either application. The invitation emails AT-6b sends reach only the
  development outbox, and their link's page arrives with AT-7b.
