# ADR-0059 — Membership changes: atomic with their audit entry, and race-free

Status: Accepted (Phase 6E)
Implements: ADR-0052 Decision 10 (*the last `OWNER` cannot be removed*, *no role
may escalate itself past its ceiling by any route*) on the membership paths of
ADR-0057, with the atomic audit ADR-0058 introduced for grants. Third of the
authorization packages; groups and row Scope follow.

## Context

Phase 6C (ADR-0057) put the role-assignment ceiling on every membership path:
invitation, acceptance, role change and removal. Each path read the state it
checks, then wrote in separate steps. Reviewing Phase 6D found two defects in
that shape, and two more of the same kind:

1. **The audit entry was a separate write.** A crash or a failed audit write
   after the change left a role changed, a member removed or an invitation
   accepted with no record.
2. **The last `OWNER` could be removed.** A role change or removal counted the
   organization's `OWNER`s, then wrote. Two `OWNER`s demoting or removing each
   other at once each counted two, and the organization ended with none.
3. **A change could apply to a role its ceiling never saw.** An `ADMIN`'s change
   to a `CREATOR` was checked against `CREATOR`, but written to whatever role
   the member then held. Had an `OWNER` promoted that member to `ADMIN`
   meanwhile, the `ADMIN`'s change demoted or removed an `ADMIN`, which its
   ceiling forbids.
4. **One invitation could be accepted twice.** Two acceptances each found it
   pending and each created a membership. Expiry wrote the copy it had read back,
   so it could also turn a concurrent acceptance back into `EXPIRED`.

No route or page calls these operations, so none was reachable. Groups add
operations of the same shape, so the pattern is settled here first.

---

## Decision 1 — The repository writes the change and its audit entry together

Each membership change is one repository method that writes its row changes
and its audit entry in one database transaction, as grants do (ADR-0058):

| Change | One transaction |
| --- | --- |
| Invitation | the invitation, `invitation.created` |
| Acceptance | the invitation `ACCEPTED`, the membership, `invitation.accepted` |
| Role change | the role, `member.role_changed` |
| Removal | the membership and, by cascade, its grants; `member.removed` |

The service still decides everything: who may act, the ceiling, and the audit
entry's content. Refusals of the ceiling are audited by the service as before;
they write nothing else.

## Decision 2 — A change applies only to the state it was checked against

A role change or removal names the role the member held when its ceiling was
checked. The write applies only while the member still holds it
(`WHERE role = expected`). Otherwise nothing is written and the service answers
`VALIDATION_FAILED` ("This member changed meanwhile; reload and try again").

An acceptance moves its invitation from `PENDING` exactly once
(`WHERE status = 'PENDING'`). A second acceptance, concurrent or later, writes
nothing and answers `NOT_FOUND` as for a used invitation. If the user became a
member meanwhile, the unique membership key refuses the row, the whole
acceptance rolls back, the invitation stays pending, and the service answers
`VALIDATION_FAILED` as before. Expiry marks an invitation `EXPIRED` only while it
is still pending.

These are the same-row races: the two writers touch one row, and the later one
would otherwise overwrite a change its checks never saw. The result would match
no order in which the two could have run one after the other.

## Decision 3 — Taking an `OWNER` away counts the `OWNER`s under a lock

A role change that demotes an `OWNER`, and the removal of an `OWNER`, lock the
organization's `OWNER` memberships (`SELECT … FOR UPDATE`) inside their
transaction, then:

- if the member is no longer among them, answer `STALE`;
- if it is the only one, answer `LAST_OWNER` (`VALIDATION_FAILED`, "Cannot
  remove or demote the last owner");
- otherwise write.

The rows are locked in `userId` order, so two such changes cannot deadlock.
Under PostgreSQL's default isolation, a transaction that waited on the lock
re-reads each locked row once the holder commits. A row that was demoted or
removed meanwhile drops out of its count. Of two `OWNER`s demoting or removing
each other at once, the second therefore counts one and is refused.

This is the cross-row race: each change writes a different row, so neither
waits on the other's write. Only a lock on the rows both read makes them wait.

Adding an `OWNER` takes no lock. It cannot break the invariant, and a count that
misses a concurrent addition can only refuse more, never less.

## Decision 4 — What is not locked

The ceiling is still judged on the actor's membership as read. If the actor is
demoted between the check and the write, the result equals the change committing
just before the demotion, which the ceiling allowed. ADR-0058 makes the same
argument for grants. Locking the actor's row would only reorder that race.

## Consequences

- The four membership changes, like grants, cannot commit unaudited.
- An organization can no longer be left without an `OWNER` by any interleaving
  of role changes and removals.
- A member changed meanwhile is never changed again on the strength of the old
  role, which closes the last route past the role-assignment ceiling on these
  paths.
- No schema change. No error code is added; `STALE` reuses `VALIDATION_FAILED`.
- The database suite reproduces each race deterministically. A third
  transaction holds the contested rows until every contender is waiting on a
  lock, so all have read before any writes. Removing the lock fails it.

## Not decided here

- Two concurrent invitations of the same email can both be created; closing that
  needs a partial unique index (a migration). It creates no access, since each
  acceptance is checked.
- Organization creation (`POST /api/organizations`) writes the organization,
  the founding `OWNER` membership and `organization.created` separately.

Both are recorded in `TODO.md`. Groups follow, reusing Decisions 1–3: each group
change locks what its ceiling reads.
