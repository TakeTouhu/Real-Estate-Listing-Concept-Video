# ADR-0134 — The members page and an organization's seats

Status: Accepted (AT-5, 2026-11-11). First part of stage B, the team, of the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): the members page lists
members with their roles, pending invitations, and seats used out of the
plan's included users, and needs `member.view`; every member uses a seat, the
`OWNER` and `BILLING` included, and until seat purchase is built the seats are
the plan's included users.
Builds on: ADR-0057 (roles and the role-assignment ceiling), ADR-0059
(membership changes), ADR-0066 (the Units page), ADR-0053 Decision 5A (seats).

## Context

The roles, invitations and their audit were built in Phases 6C and 6E, and no
page showed them: an organization's `OWNER` could not see who belonged to it.
The plan's included users (Standard 3, Premium 10, Enterprise 30) were in the
plan catalog, and nothing counted them. AT-6 will refuse an invitation when no
seat is left; this ADR fixes what a seat is and shows the count first.

---

## Decision 1 — `/organizations/{id}/members`, for a holder of `member.view`

The page shows, for a holder of `member.view` (by template `OWNER`, `ADMIN`,
`MANAGER` and `BILLING`; an individual or group grant counts, as everywhere):

- **Seats:** how many are taken out of how many the plan includes.
- **Members:** each one's name, email address, role and when they joined, by
  role (`OWNER`, `ADMIN`, `MANAGER`, `CREATOR`, `VIEWER`, `BILLING`) and then
  the longest-standing first. The viewer is marked "(you)".
- **Pending invitations:** each one's email address, role, when it was sent and
  when it expires, oldest first.

Anyone else, a member without `member.view` or someone outside the
organization, gets the same refusal, without the organization's name, as the
Units page does. The dashboard links each organization to the page, beside
"Units and plan".

## Decision 2 — Every member takes a seat, and so does a pending invitation

An organization's seats are its plan's included users from the plan catalog,
until seat purchase is built. A plan that has not started yet already gives its
seats. **An organization with no plan has no seats**, and the page says that
its seats come with the plan.

Seats taken = members + invitations that can still be accepted. An invitation
can be accepted while it is `PENDING` and its expiry is still ahead
(`holdsSeat`, the same boundary acceptance uses: at its expiry instant it no
longer can). An invitation past its expiry and not yet marked `EXPIRED` holds
no seat and is not listed. Every member counts, whatever their role.

The page shows the count as it is, even above the seats (an organization's
members were never limited before AT-6). It chooses, removes or deactivates no
one, and buys nothing (ADR-0053 Decision 5A).

## Decision 3 — Viewing reads only

The page writes nothing: no audit entry, as a `member.view` listing never had
one (ADR-0060), and an invitation past its expiry is left as it is. The
members, the invitations and the subscription are read separately, not in one
transaction, so a change committed while the page reads can show in one count
and not yet in another. That is enough for a page, and a seat limit must not
rely on it: AT-6 must count again in the transaction that writes the
invitation.

The accounts behind the members are asked for together, so the database client
reads them in one query.

## Consequences

- No migration, route, permission or audit action. The page and the dashboard
  link are the only change a person sees.
- Who can invite, cancel an invitation, change a role or remove a member is
  unchanged: no page or route does any of these yet (AT-6 and AT-8).
- `includedSeats` and `holdsSeat` state the seat rule once, for AT-6's
  invitation and AT-7's acceptance to check against when they are built.
