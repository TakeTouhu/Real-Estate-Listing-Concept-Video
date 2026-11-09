# Gap analysis — accounts and team

Base: `main @ be4363e` (PR #149, GS-13d; post-merge CI run 872 green).
Plan: `/mnt/project-files/cto/accounts-team-proposal.md`, approved by the
product owner on 2026-11-09 with its defaults. Each pull request still needs
the product owner's yes before merge.

## What the plan must reach

On a development machine, with no paid service and no email leaving it: an
owner invites a colleague, who opens the emailed link, creates an account,
verifies the email and joins with the role they were given; the colleague
sees only the Properties assigned to them; the owner assigns a Property, and
the colleague works on it. A person who forgets a password can reset it.

## What is implemented on the base

| Piece | State on `be4363e` | Where |
| --- | --- | --- |
| Roles, the role-assignment ceiling, last-`OWNER` protection, audit | built, **no screen or route** | `MembershipService`; ADR-0057, ADR-0059 |
| Invitations: create, accept, 7-day expiry | built, **no screen or route, nothing sends them**; acceptance does not check the accepting account's email | `MembershipService.invite`, `acceptInvitation` |
| Groups and group permissions | built, **no screen or route** | `GroupService`; ADR-0060, ADR-0061 |
| Individual permission grants | built, **no screen or route** | `PermissionGrantService`; ADR-0058 |
| Property responsible user and group, and reach by them | built and enforced; **no screen changes an assignment** | `PropertyService`; ADR-0062, ADR-0064 |
| Sending email | **none** (*a port and a development outbox since AT-1, ADR-0126*) | |
| Email verification (ADR-0052 Decision 18) | **none**: sign-up signs the person in at once, and any text is taken as an email (*links and their service since AT-3a, ADR-0128, dormant*) | `POST /api/auth/register`, `AuthService.register` |
| Password reset (ADR-0052 Decision 18) | **none** | |
| Seat limit (3 / 10 / 30 included users) | **not enforced**; no seat is recorded beyond the plan | `customer-plan-catalog.ts` |
| Organization creation | three writes in separate steps (open TODO) (*one transaction since AT-2, ADR-0127*) | `OrganizationService` |
| A second pending invitation of one email | refused by a read only (open TODO) | `MembershipService.invite` |

## The milestones

Twelve pull requests in three stages: A, accounts (AT-1 to AT-4); B, team
(AT-5 to AT-11); C, the browser proof and the completion report (AT-12). Each
is split further where it would exceed about 500 changed lines.

| PR | What | Migration |
| --- | --- | --- |
| AT-1 | Email port and development outbox, dormant | none |
| AT-2 | Organization creation in one transaction | none |
| AT-3 | Email verification (*split: AT-3a links and service, migration 33; AT-3b sign-up, verify page and guard*) | 1 |
| AT-4 | Password reset | none |
| AT-5 | Members page, read only, with seats used | none |
| AT-6 | Invite and cancel, the seat limit, one pending invitation per email | 1 |
| AT-7 | Accept an invitation with the invited email | none |
| AT-8 | Change a member's role, remove a member | none |
| AT-9 | Groups page | none |
| AT-10 | Property assignment on the Property page | none |
| AT-11 | Individual and group permissions | none |
| AT-12 | Browser test and completion report | none |

## Defaults the product owner approved

1. Email goes to a development outbox only; the production service is chosen
   before launch (`docs/decisions/TODO.md`, decision gates).
2. An unverified account can sign in but sees only the verify page; its link
   lasts 24 hours.
3. A password reset link lasts 1 hour and works once; a reset ends every
   session of the account; the request answers the same whether or not the
   email has an account; MFA is still asked at the next sign-in.
4. Only an account with the invited, verified email accepts an invitation,
   which lasts 7 days.
5. Every member uses a seat. Until seat purchase exists, the seats are the
   plan's included users. An invitation needs a free seat counting members and
   pending invitations; acceptance needs one counting members. An organization
   with no plan cannot invite.
6. Removing a member is in the plan; deleting an account is not.
7. Rate limiting is not in the plan (ADR-0054 keeps its limits until
   measured).

## Out of scope

Account deletion and its 30-day lifecycle, seat purchase, single sign-on, rate
limiting, the production email service, operator-assisted MFA reset.
