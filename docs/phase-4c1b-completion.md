# Phase 4C-1b — System execution persistence foundation

Milestone: Phase 4C-1b
Base: `e8dbd016c68466a1862d15e33e8aee750de649e9` (merged Phase 4C-1a, PR #38)
Decision record: ADR-0025

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source, and
> `docs/progress.md` points at it (Phase 4C-1a convention).

## Why this milestone exists

ADR-0024 made the `SceneGeneration` row the durable queue: work is discovered by
`state = 'QUEUED'`, with no transport and no payload. That closed the delivery
question and opened the reading one. Every method on the tenant-facing
`SceneGenerationRepository` takes `organizationId` as an addressing argument, and
**execution cannot satisfy that contract** — a worker scanning for queued work
has no request, no session, and no payload to read a tenant from, only the state
of rows it has not seen. This milestone supplies the boundary that answers it,
and nothing else.

## What shipped

```ts
findNextQueuedForPreparation(): Promise<SystemGenerationCandidate | null>
claimQueuedForSubmission(id: string): Promise<ClaimedSceneGeneration | null>
```

**ADR-0025 carries the reasoning in full.** This report records what was built
and how it was checked, and deliberately does not restate the argument.

- **Tenant identity is resolved, never accepted.** Both methods return the
  `organizationId` they derived through the owning `VideoProject`; neither takes
  one, so a worker never chooses a tenant — the claim hands it one. The
  tenant-facing repository is untouched (no `findByIdSystem`, no optional
  `organizationId`, no trusted flag), and no `organizationId` column was added to
  `SceneGeneration`.
- **Discovery, then claim, in that order.** Discovery is read-only and
  non-exclusive; the claim is the exclusive step, narrowed to sit immediately
  before the provider call so the `SUBMITTING` window — whose only honest
  recovery parks work for a human — stays as small as the design allows. This is
  safe because everything preparation reads is already immutable (ADR-0018,
  ADR-0023): nothing can drift between the two calls except `state`.
- **The claim is a compare-and-swap**, `updateMany({ where: { id, state:
  'QUEUED' }, data: { state: 'SUBMITTING' } })`. No lease columns, no
  `SKIP LOCKED`, no raw SQL, **no schema or migration change**. Legality is asked
  of the domain rather than restated: the adapter calls
  `assertTransition("QUEUED", "SUBMITTING")` before issuing the claim, so a
  hard-coded pair in a persistence file cannot become a second, silent state
  machine.
- **Production-dormant, and pinned that way.** Nothing calls either method
  outside tests, and the Phase 4C-1a compile-time dependency pin is extended with
  `execution`, `executions`, and `executionRepository` so `GenerationServiceDeps`
  cannot declare one even optionally.

### What the claim's transaction does, and does not, guarantee

The update and the read-back share one transaction — found by review. `updateMany`
returns a count, so the row must be read again, and the first revision did that
outside a transaction on the assumption that a claim holder is the only writer
able to move the row on. That assumption was false: `QUEUED → CANCELLED` is legal
and `SceneGenerationRepository.update` deliberately carries no state predicate, so
a cancellation could commit between the two statements and the method would return
a `CANCELLED` row typed as a claim.

**What it guarantees:** this method never hands back a row
other than the one it moved to `SUBMITTING` itself. That is all. It does not make
every future writer of the row safe — a writer that starts after the transaction
commits is entirely unaffected by it, so an unconditional
`update(org, id, { state: 'CANCELLED' })` landing a moment later still overwrites
a live claim, into a state the machine says is unreachable from `SUBMITTING`. No
transaction here can prevent that; the fix belongs to the competing writer, and
`docs/decisions/TODO.md` now records it as a **hard prerequisite** that any
transition able to compete with the claim must carry its own expected-state
predicate.

### `null` means one thing, and invariant failures are not it

`null` tells a caller *you did not win a `QUEUED` claim* — ordinary, handled by
looking for other work. Once `updateMany` reports `count === 1`, this caller
**did** win, so a read-back finding no row, no resolvable `VideoProject`, or a
state other than `SUBMITTING` is a broken invariant, not a lost race. The adapter
throws `INTERNAL_ERROR` from inside the transaction, rolling the claim back so
the row returns to `QUEUED` and stays discoverable. Returning `null` there — as
an earlier revision did — would have laundered a broken invariant into a routine
one and parked the row in `SUBMITTING` with every worker believing it belonged to
someone else: stalled work no alarm fires for.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | **1160 passed**, 59 files (baseline 1158 / 58) |
| `pnpm build` | exit 0 |
| `pnpm test:db` | **153 passed**, 7 files (baseline 126 / 6) |
| `prisma migrate diff --from-migrations` | `No difference detected.` exit 0 |

### Where each property is proven

**There is no in-memory double for this port.** An earlier revision of this
milestone added one, against an explicit instruction not to; it was removed.
Nothing consumes the port yet, and every property worth asserting about the
boundary is decided by the database rather than by any interface satisfying it
(ADR-0025, Consequences).

| Property | Proven by |
| --- | --- |
| Parameter lists take no `organizationId`; `SUBMITTING` is an ACTIVE state | 2 type-level unit tests (all that survives without a double) |
| Ordering — oldest first, `id` breaking a same-instant tie | PostgreSQL |
| State filtering — every non-`QUEUED` state refused by both methods, and the claim's refusal leaves **every column** of the row untouched | PostgreSQL, all 7 states |
| Tenant resolution through the `VideoProject` join | PostgreSQL |
| **Concurrent exclusivity** (2 callers, and 8) | PostgreSQL |
| Tenant agreement between the two ports | PostgreSQL — the execution port's resolved org can read the row through the tenant-facing port, and the other tenant cannot |
| Claim mutates `state`, **advances `updatedAt`**, and touches nothing else | PostgreSQL — row seeded with a known-old `updatedAt`, then compared before/after |

**Not covered by any test, stated rather than hidden:** the three
`INTERNAL_ERROR` guards after a won claim. None is reachable —
`scene_generations` has no deletion path, its `VideoProject` relation is
required, and a non-`SUBMITTING` read-back would mean the row lock did not hold.
Reaching them from a test needs a seam in production code that exists only to be
mocked, a worse trade on this boundary than an uncovered guard.

**Also removed: the claim-versus-cancellation race test.** It could only assert
that the row ended in *either* state — true whatever the adapter does — while
implicitly modelling an unconditional write as a safe cancellation. It is not
one; the requirement belongs to the future writer and is now a hard prerequisite
in `docs/decisions/TODO.md`.

### Mutation verification

| Mutation | Result |
| --- | --- |
| Claim predicate loses `state: "QUEUED"` | **9 fail** |
| Discovery ordering reversed to newest-first | **1 fail** |
| Tie-break reversed to `id: "desc"` | **1 fail** |
| Claim returns a pre-claim (`QUEUED`) view | **1 fail** |
| Claim writes back the seeded-old `updatedAt` instead of advancing it | **1 fail** |
| Claim writes `lastPolledAt` before the CAS, leaving `state` intact | **8 fail** — all 7 refusal states, plus the `updatedAt` test |
| `assertTransition` pointed at an illegal pair (`SUBMITTING → QUEUED`) | **14 fail** — every DB test that invokes the claim |
| `QUEUED → SUBMITTING` removed from the committed domain table | **14 fail** DB, **5 fail** unit |
| `assertTransition` call deleted outright | **0 fail** — see below |

Each restored, with `git diff --stat` confirming the adapter unchanged
afterwards.

The last two closed real gaps. **`updatedAt`** was previously normalized away
before the rows were compared, so a claim that never advanced it would have
passed; it is now seeded at a fixed 2020 timestamp (Prisma honours an explicit
value even on `@updatedAt`) and asserted strictly greater — deterministic, no
sleep. **The refusal matrix** asserted only that `state` survived, so a refusal
writing some *other* column passed all seven states; it now compares the whole
row, and the `lastPolledAt` mutation proves the difference — `state` stays
intact, so the old assertion accepted it and the new one rejects it everywhere.

Both matter downstream: a later abandonment sweep reads `updatedAt` to decide a
`SUBMITTING` row is stranded, so a claim failing to advance it makes a live claim
look stale, and a refusal touching it makes idle rows look freshly active.

**The domain-legality dependency is real, and its one gap is stated.** The last
three mutations answer "is `assertTransition` load-bearing?" separately, because
it has three answers. An illegal pair fails every claim test, so the call
genuinely executes rather than sitting dead. Removing `QUEUED → SUBMITTING` from
the committed `TRANSITIONS` table fails the same 14 — the adapter reads the
domain's table, not a private copy, which is the entire reason for calling it.
**Deleting the call outright changes nothing**, the honest limit: nothing pins
its *presence*, because it guards a future domain change rather than today's
behaviour, and pinning presence would mean asserting on a mock this boundary
should not acquire.

## Invariants held

8-fact `requestHash` **unchanged** · state machine **unchanged** · schema and
migrations **unchanged** · the six request/frozen artifacts untouched · the
tenant-facing `SceneGenerationRepository` untouched · admission
(`generation-service.ts`) untouched · no worker loop, asset lookup, signed URL,
provider input assembly, `createGeneration` call, polling, output ingestion,
`SUBMITTING` recovery, retry scheduling, model routing, or WaveSpeedAI call.

## Known limitations

- **A crash after claiming strands the row in `SUBMITTING`.** No abandonment
  recovery exists, by scope. The row is durable, visible, and holds its request
  identity — but nothing will move it. Recorded in `docs/decisions/TODO.md` as a
  requirement on the submitting milestone, with its shape already decided:
  an abandoned `SUBMITTING` becomes `SUBMISSION_UNKNOWN`, because a crashed
  worker leaves genuine doubt about whether the POST reached the provider.
- **Nothing calls this yet.** Deliberate, and the reason the milestone is small.
- **Discovery returns one row at a time.** No batching, because no caller needs
  one; a batch API would be speculative surface on the trusted boundary.

## Size — above the original estimate, within the final reviewability waiver

| Category | Lines changed | Original estimate |
| --- | --- | --- |
| Production | 272 | ~220–300 |
| Tests | 379 | ~300–400 |
| Docs | 594 | ~180–260 |
| **Total** | **1,245** across 13 files | est. ≤ ~850–900 · **final waiver 1,260** |

Measured from `git diff --numstat e8dbd01..HEAD` after the final commit existed,
reconciling with the raw diff (`+1212 −33 = 1,245`).

**The original preferred estimate was exceeded, and the reasons are specific
rather than general drift.**

- **Production (272) is inside its band.** The speculative in-memory double
  was removed during review, which is also why the port's only implementation is
  the PostgreSQL adapter.
- **Tests (379) grew for safety evidence**, all of it against live
  PostgreSQL: a successful claim proving `updatedAt` strictly advances, and
  whole-row preservation across all seven non-`QUEUED` refusal states.
- **Docs (594) grew for the durable architectural record** — ADR-0025 plus
  this report. Collapsing the duplication between the two recovered 26 lines;
  cutting further would mean gutting the ADR, which is the decision record a
  later milestone will actually read.

**The CTO granted a final reviewability waiver of 1,260 changed lines** for that
required safety evidence and durable record. The measured total is **1,245**,
**within** the waiver. An earlier revision of this report also described 1,305
lines as "inside the applicable estimate" against a wider band that assumed the
double; that claim was wrong and does not apply to this figure.

Only 33 lines are deletions, because this milestone adds a boundary rather
than removing one.
