# API Changes — AT-7a

Accepting an invitation now needs the account with the invited address,
verified, and a seat counting members, counted under the organization's lock
(ADR-0137). **No migration, permission, audit action, page or route.** No
route accepts yet; `/accept-invitation` and its route are AT-7b's.

## HTTP

Not applicable: no route or page changes. `acceptInvitation` still has no
caller in either application.

## Internal API

### Changed: `@app/domain`

| Export | Shape |
| --- | --- |
| `MembershipService.acceptInvitation(userId, token)` | same signature. Refuses, in this order, writing nothing except where noted: a token of no pending invitation (`NOT_FOUND`); an expired one (`EXPIRED`, marked `EXPIRED`); an account gone or disabled (`NOT_FOUND`); an address not verified (`EMAIL_NOT_VERIFIED`); another account's address (`WRONG_ACCOUNT`); a member (`ALREADY_MEMBER`); an inviter past its ceiling (`FORBIDDEN`, audited); no plan (`NO_PLAN`); no seat counting members (`NO_SEAT`) |
| `AcceptanceRefusal` | new: `EXPIRED`, `EMAIL_NOT_VERIFIED`, `WRONG_ACCOUNT`, `ALREADY_MEMBER`, `NO_PLAN`, `NO_SEAT`, as `details.reason` of the `VALIDATION_FAILED` |
| `InvitationAcceptance` | adds `{ outcome: "NO_SEAT" }`; `STALE` now also covers an invitation expired at the acceptance's instant |
| `InvitationRepository.accept(invitation, userId, audit, { includedSeats, clock })` | was `accept(invitation, userId, acceptedAt, audit)`. One `READ COMMITTED` transaction under the organization's row lock, which reads the instant from `clock` once it holds the lock: `STALE` unless pending and not expired at that instant, then `NO_SEAT` when the members number `includedSeats` or more, then the invitation `ACCEPTED` at that instant, the membership and `audit` |

### Changed: `@app/database`

| Export | Shape |
| --- | --- |
| `createPrismaIdentityRepositories(...).invitations.accept` | implements the port above: `SELECT … FOR NO KEY UPDATE` on the organization, the instant, a count of the invitation still open, a count of the memberships, a conditional update, the membership and the audit entry |
| `createPrismaIdentityRepositories(...).invitations.create` | unchanged, but now sets `READ COMMITTED` explicitly, as `accept` does |

## Sequence

```mermaid
sequenceDiagram
    participant C as Caller (AT-7b's route)
    participant S as MembershipService
    participant R as Invitation repository
    participant D as PostgreSQL
    C->>S: acceptInvitation(userId, token)
    S->>R: findByTokenHash; expire if past expiry
    S->>S: account active? verified? its address the invited one?
    S->>S: not a member? inviter's ceiling? a plan?
    S->>R: accept(invitation, userId, audit, { includedSeats, clock })
    R->>D: BEGIN (READ COMMITTED); lock the organization's row FOR NO KEY UPDATE
    R->>R: now = clock.now()
    R->>D: invitation still pending and not expired at now? (else STALE)
    R->>D: members < includedSeats? (else NO_SEAT)
    R->>D: invitation ACCEPTED, membership, invitation.accepted; COMMIT
    R-->>S: ACCEPTED, or a refusal
    S-->>C: the membership, or an AppError naming the reason
```
