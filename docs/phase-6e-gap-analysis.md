# Phase 6E gap analysis — membership changes made atomic and race-free

Status: implemented on branch `claude/project-thread-az06z2`.
Base: `main @ 0f0dd53` (PR #77, Phase 6D, merged 2026-10-13; migration 20 is the
latest).

Authority: ADR-0052 Decision 10 (*the last `OWNER` cannot be removed*, *no role
may escalate itself past its ceiling by any route*), ADR-0057 (Phase 6C, the
role-assignment ceiling on every membership path), ADR-0058 (Phase 6D, a change
commits together with its audit entry), CLAUDE.md (*audit … admin actions*).

## Why this package is next

Reviewing PR #77 found two defects in the Phase 6C membership paths
(`MembershipService`). Neither is reachable today, because no route or page
calls these operations, but both must be fixed before any member-management
screen ships. Groups (the next package) add operations of the same shape, a
ceiling checked against what was read followed by a write, so they should
reuse a pattern that is already tested.

## Gap

| Concern | Today (after Phase 6D) | Required | Where |
| --- | --- | --- | --- |
| Audit of an invitation | written after the invitation, separately | one transaction | `InvitationRepository.create` |
| Audit of an acceptance | membership, invitation and audit in three separate writes | one transaction | new `InvitationRepository.accept` |
| Audit of a role change | written after the change, separately | one transaction | `MembershipRepository.changeRole` |
| Audit of a removal | written after the removal, separately | one transaction (the grants still cascade) | `MembershipRepository.remove` |
| Last `OWNER` | counted, then written in a separate step: two `OWNER`s demoting or removing each other at once can leave none | the count taken under a lock on the organization's `OWNER` rows, in the same transaction as the write | both repository methods |
| Ceiling against a stale role | the ceiling is checked against the role read, but the write does not require it: a concurrent promotion of the target (to `ADMIN`, say) can be overwritten by an `ADMIN` who may not touch an `ADMIN` | the write applies only if the member still holds the role the ceiling was checked against; otherwise nothing is written | both repository methods |
| Concurrent acceptance | two acceptances of one invitation can each create a membership | the invitation moves from `PENDING` exactly once; the other acceptance writes nothing | `InvitationRepository.accept` |
| Expiry | `update({...invitation, status: "EXPIRED"})` from the copy read: a concurrent acceptance can be overwritten back to `EXPIRED` | expires only a still-pending invitation | `InvitationRepository.expire` |

## Choices the ADRs leave open (defaults taken)

1. **A change checked against a role the member no longer holds is refused**
   with `VALIDATION_FAILED` ("This member changed meanwhile; reload and try
   again") and writes nothing. It is not audited as a ceiling refusal: nothing
   was attempted past a ceiling; the request was made against stale data.
2. **The lock covers only changes that take an `OWNER` away** (demotion or
   removal of an `OWNER`). Adding an `OWNER` cannot break the invariant, and a
   count that misses a concurrent addition only refuses more, never less.
3. **No `CONFLICT` error code is added.** `VALIDATION_FAILED` already carries the
   last-`OWNER` refusal; adding a code would change the HTTP error mapping, which
   no route needs yet.

## Out of scope (carried forward in `TODO.md`)

- Two concurrent invitations of the same email can both be created (the
  pending-invitation check is a read). Closing it needs a partial unique index,
  that is, a migration; it creates no access, because each acceptance is still
  checked.
- Organization creation writes the organization, the founding membership and
  their audit entries in separate steps.

## Milestone

One PR (6E): the repository ports, their Prisma and in-memory implementations,
`MembershipService` on top of them, unit and database suites (forced audit
failures, deterministic concurrency), mutation pass, ADR-0059, phase
documentation. **No schema change, no migration.**

**Dormant:** no HTTP route or page calls these operations. No behavior a member
can notice changes. Paid Provider Activation, production credentials, the
production scheduler and live Stripe charges remain BLOCKED.
