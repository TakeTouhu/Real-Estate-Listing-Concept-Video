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
question and opened the reading one.

Every method on the tenant-facing `SceneGenerationRepository` takes
`organizationId` as an addressing argument, so a read that forgets to scope is a
missing predicate rather than an unfiltered result. **Execution cannot satisfy
that contract**: a worker scanning for queued work has no request, no session,
and no payload to read a tenant from — only the state of rows it has not seen.
This milestone supplies the boundary that answers it, and nothing else.

## What shipped

### One new port, two methods

```ts
findNextQueuedForPreparation(): Promise<SystemGenerationCandidate | null>
claimQueuedForSubmission(id: string): Promise<ClaimedSceneGeneration | null>
```

Both return the `organizationId` they resolved through the generation's owning
`VideoProject`. **Neither accepts one.** That direction is the security property:
a worker never chooses a tenant, the claim hands it one, so there is no input a
caller could get wrong.

The tenant-facing repository is untouched — no `findByIdSystem`, no optional
`organizationId`, no trusted flag. A trusted method on that interface would be
reachable from every service holding it, turning one trusted file into a trusted
surface at every call site; an *optional* tenant argument would additionally make
the unscoped call the easier one to write while the isolation tests still passed.

**No `organizationId` column was added to `SceneGeneration`.** A duplicated tenant
id can disagree with its parent, and when it does there is no way to tell which is
right. The join cannot disagree with itself.

### Discovery and claiming are separate, in that order

Discovery is read-only and non-exclusive; the claim is the exclusive step.
Claiming first would hold the row in `SUBMITTING` across asset resolution, URL
signing, and input assembly — and `SUBMITTING` is the state whose only honest
recovery is `SUBMISSION_UNKNOWN`, which parks work for a human. Narrowing the
claim to the provider call keeps that bucket as small as the design allows.

Prepare-then-claim is safe because everything preparation reads is already
immutable (ADR-0018, ADR-0023): nothing can drift between the two calls except
`state`, and the compare-and-swap is precisely a state check.

### The claim is a compare-and-swap

`updateMany({ where: { id, state: 'QUEUED' }, data: { state: 'SUBMITTING' } })` —
the predicate travels with the write, so the database picks the winner. The loser
gets `null`, not an exception: losing a race is an ordinary outcome, and throwing
would push callers to wrap a normal path in `try`/`catch`.

No lease columns, no `SKIP LOCKED`, no raw SQL, **no schema or migration change**.
The state machine already provides the exclusion; a second mechanism would be a
second source of truth about who holds the work.

### Production-dormant, and pinned that way

Nothing calls either method outside tests. The Phase 4C-1a compile-time
dependency pin is extended with `execution`, `executions`, and
`executionRepository`, so `GenerationServiceDeps` cannot declare one even
optionally — admission is tenant-facing and always knows its organization, so a
port that resolves tenants for itself is a trusted surface it has no reason to
hold.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | **1186 passed**, 59 files (baseline 1158 / 58) |
| `pnpm build` | exit 0 |
| `pnpm test:db` | **152 passed**, 7 files (baseline 126 / 6) |
| `prisma migrate diff --from-migrations` | `No difference detected.` exit 0 |

### Where each property is proven

The split is deliberate. The in-memory double is single-threaded, so it can only
show that a second **sequential** call is refused — it cannot demonstrate that
PostgreSQL picks one winner among concurrent callers. That is the question that
decides whether a provider is paid twice, so it is asked of the real database. A
unit test claiming to prove exclusivity would be the most dangerous kind of green.

| Property | Proven by |
| --- | --- |
| Ordering, state filtering, tenant resolution, claim semantics | 28 unit tests against the in-memory double |
| **Concurrent exclusivity** (2 callers, and 8) | PostgreSQL integration suite |
| Tenant agreement between the two ports | PostgreSQL — the execution port's resolved org can read the row through the tenant-facing port, and the other tenant cannot |
| Claim mutates `state`/`updatedAt` and nothing else | PostgreSQL row comparison before/after |

### Mutation verification

| Mutation | Result |
| --- | --- |
| Claim predicate loses `state: "QUEUED"` | **9 fail** — including both race tests |
| Discovery ordering reversed to newest-first | **1 fail** |
| Claim returns a pre-claim (`QUEUED`) view | **1 fail** |

Each restored, with `git diff --stat` confirming the adapter byte-identical
afterwards.

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

## Size

| Category | Lines changed |
| --- | --- |
| Production | 290 |
| Tests | 503 |
| Docs | 430 |
| **Total** | **1,223** across 15 files |

Measured from `git diff --numstat e8dbd01..HEAD` after the final commit existed,
reconciling with the raw diff (`+1190 −33 = 1223`).

Against the Phase 4C-0 plan's estimate for this milestone — **~1,020–1,295**
with the in-memory double included, or ~790–1,065 had it been deferred — this
lands inside the applicable range. That is the first milestone since 4A-2a to
finish inside its estimate rather than over it.

Production is **290** — the port, its adapter, and the double — comfortably under
the ~500 reviewability target. Only 33 lines are deletions, because this
milestone adds a boundary rather than removing one.
