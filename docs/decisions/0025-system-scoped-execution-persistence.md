# ADR-0025: A separate system-scoped execution persistence boundary

Status: Accepted (Phase 4C-1b)
Date: 2026-08-18

## Context

ADR-0024 made the `SceneGeneration` row the durable queue: work is discovered by
`state = 'QUEUED'`, and there is no transport, no job record, and no payload.
That closed the delivery question and opened the reading one.

Every method on the tenant-facing `SceneGenerationRepository` takes
`organizationId` as an **addressing argument** — deliberately, so that a read
which forgets to scope is a missing predicate rather than a silently unfiltered
result. Execution cannot satisfy that contract. A worker scanning for queued work
has no customer request to read a tenant from, no session, and no payload; it
has only the state of rows it has not yet seen. The requirement ADR-0017 §13
recorded, and Phase 4C-1a restated, is what this milestone answers.

`SceneGeneration` carries no `organizationId` column. Its tenant is whichever
organization owns the parent `VideoProject`.

## Decision

### 1. A separate port, not a widened one

`SceneGenerationExecutionRepository` is its own interface, in its own file, with
its own adapter. The tenant-facing repository is untouched.

The alternative — a `findByIdSystem`, an optional `organizationId`, or a
`skipTenantCheck` flag on the existing repository — was rejected for a reason
that is structural rather than stylistic. That repository is injected into
tenant-facing services; a trusted method on it is reachable from every one of
them, so the blast radius of the trusted surface becomes every call site rather
than one file. Worse, an *optional* `organizationId` makes the unscoped call the
easier one to write, and the tenant-isolation tests that protect the scoped
methods would still pass.

Two ports means the trusted surface is exactly two methods, in one file, and the
existing isolation tests keep their full force.

### 2. Tenant identity is resolved, never accepted

Both methods return the `organizationId` they derived by joining the generation
to its `VideoProject`. Neither takes one.

That direction is the whole security property. A worker never chooses a tenant —
the claim hands it one — so there is no input a caller could get wrong, and no
path by which customer-supplied data becomes a tenant assertion. A compile-time
assertion pins it: `findNextQueuedForPreparation` takes no parameters and
`claimQueuedForSubmission` takes exactly one `string`.

**No `organizationId` column is added to `SceneGeneration`.** A duplicated tenant
id can disagree with its parent, and the moment it does, one of the two is
silently wrong — with no way to tell which. The join is the authority because it
cannot disagree with itself.

### 3. Discovery and claiming are two calls, in that order

```
findNextQueuedForPreparation()   read-only, non-exclusive
      ↓   (a later milestone prepares the request here)
claimQueuedForSubmission(id)     CAS: QUEUED → SUBMITTING
```

Claiming first would hold the row in `SUBMITTING` across asset resolution, URL
signing, and input assembly. `SUBMITTING` is the state whose only honest recovery
is `SUBMISSION_UNKNOWN` — no automatic exit, holds the request identity, needs a
human (ADR-0016) — so every crash in that stretch would park customer work.
Claiming immediately before the provider call keeps that bucket as small as the
design allows.

What makes prepare-then-claim safe is already merged: everything preparation
reads is immutable (ADR-0018's snapshot, ADR-0023's frozen prompt), so nothing
can drift between the two calls **except** `state` — and the CAS is precisely a
state check.

Discovery being non-exclusive is therefore a feature, not a compromise. Two
workers may prepare the same row; one loses the CAS and moves on, having wasted a
signed URL and some assembly, neither of which is billable.

### 4. The claim is a compare-and-swap, not a lease

`updateMany({ where: { id, state: 'QUEUED' }, data: { state: 'SUBMITTING' } })`.
The predicate travels with the write, so the database decides the winner rather
than anything the process observed beforehand. The loser receives `null`, which
is an ordinary outcome and not an exception: losing a race is not an error, and
modelling it as one would push callers toward `try`/`catch` around a normal path.

No lease columns, no `SKIP LOCKED`, no raw SQL, and no schema change. The state
machine already provides the exclusion — `QUEUED → SUBMITTING` is a legal
transition and the row can make it only once — so a second mechanism would be a
second source of truth about who holds the work. `SKIP LOCKED` remains available
as a contention optimization if measurement ever justifies one.

**Legality stays with the domain.** `assertTransition` answers whether the move
is legal; this port answers who gets to make it. Both, not either.

### 5. Two methods, and no more

No `findById`, no listing, no completion write, no lease renewal, no abandonment
sweep, no retry scheduling. Each belongs to a milestone that does not exist yet.

This repository has three times paid for surface that reads as a capability the
system has — unread `ProviderGenerationInput` fields, undocumented request
fields sent to WaveSpeed, and a queue port nothing implemented. Speculative
surface on the boundary that decides whether a provider gets paid is the worst
place to repeat that.

### 6. The milestone is production-dormant

Nothing calls either method outside tests. The adapter is exported and unused, by
design: this is the foundation a later milestone consumes, and shipping it alone
keeps that milestone's diff about execution rather than about persistence.

Admission must never acquire this port. The Phase 4C-1a compile-time dependency
pin is extended with `execution`, `executions` and `executionRepository`, so
`GenerationServiceDeps` cannot declare one even optionally. Admission is
tenant-facing and always knows its organization; a port that resolves tenants for
itself is a trusted surface it has no reason to hold.

## Consequences

**`SUBMITTING` must remain in `ACTIVE_SCENE_GENERATION_STATES`.** A claimed row
still holds its request identity, so admission cannot create a duplicate attempt
while a claim is in flight. A test asserts that membership rather than trusting
it, because if that set ever stopped covering `SUBMITTING`, a claim would quietly
open the duplicate-charge window this phase exists to close.

**A crash after claiming strands the row in `SUBMITTING`.** There is no
abandonment recovery yet, by scope. The row is not lost — it is durable, it holds
its identity, and it is visible — but nothing will move it without one. The
recovery path is recorded in `docs/decisions/TODO.md` as a requirement on the
milestone that adds submission, and its shape is already decided by the state
machine: an abandoned `SUBMITTING` becomes `SUBMISSION_UNKNOWN`, because a
crashed worker leaves genuine doubt about whether the POST reached the provider.

**Concurrency is proven against PostgreSQL, not asserted in a double.** The
in-memory implementation is single-threaded and can only show that a second
*sequential* call is refused. Whether two concurrent callers can both win is a
question about the database, and it is the question that decides whether a
provider is paid twice, so the integration suite asks it of the real thing — at
two callers and at eight.

**No schema, no migration, no state-machine change.** Everything this design
needs — `state`, the `(state)` index, the `VideoProject` relation — shipped in
Phase 4A-2a.

## Alternatives rejected

**A system-scoped method on the tenant-facing repository** — see §1. Turns one
trusted file into a trusted surface reachable from every service holding that
repository.

**An `organizationId` column on `SceneGeneration`** — see §2. Creates a second
answer to a question that already has one, and no way to tell which is right when
they disagree.

**Claim-then-prepare** — see §3. Widens the `SUBMITTING` window from one provider
call to an entire preparation sequence, and `SUBMITTING` is the most expensive
state to be stranded in.

**Lease columns with a heartbeat** — a second mechanism for exclusion when the
state machine already provides one, plus schema this milestone is not authorized
to change. Revisit only if abandonment recovery proves the CAS insufficient.
