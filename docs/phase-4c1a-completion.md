# Phase 4C-1a — Row-as-queue admission contract

Milestone: Phase 4C-1a
Base: `082a596aae5ea0bbb298e97cf289fe19206e8093` (merged Phase 4C-0a, PR #37)
Decision record: ADR-0024; dated amendments to ADR-0017 §10 and §13

> **Convention note.** This report is an immutable technical snapshot and
> carries no lifecycle status. A status line inside a file that nothing rewrites
> at merge is false within minutes of being true, and eight such claims had
> accumulated across earlier reports and the changelog.
>
> **The GitHub pull request is the authoritative lifecycle source.** Checked-in
> files do not track it, because no mechanism updates them when state changes —
> the first draft of this convention named `docs/progress.md` as a second
> lifecycle home "updated at merge", which was the same mistake one level up:
> nothing updates it either. `docs/progress.md` therefore points at the PR for an
> in-flight milestone instead of restating its state, and records durable facts
> (merge commit, PR number) once they exist.
>
> Reports state what shipped, against which base, and what was verified — facts
> that stay true.

## Why this milestone exists

`SceneGenerationQueue` was introduced in Phase 4B-1b with an explicit contract:
a rejected `enqueue` means the job was not accepted, so admission audits only
after acceptance (ADR-0017 §10). Two facts accumulated against it.

**Nothing implemented it.** `@app/queue` is a placeholder exporting a package
name; the only implementation in the repository is a test double. Admission was
calling a production dependency that did not exist.

**The transport manufactured the failure it was meant to prevent.** ADR-0017 §13
made a `QUEUED` sweep a mandatory Phase 4C requirement, because a row persisted
but not enqueued is invisible work. That sweep — a scan for `QUEUED` rows — is a
complete delivery mechanism on its own. The transport's only unique contribution
was a way to lose work.

## What shipped

### The row is the queue

`state = 'QUEUED'` is the durable acceptance condition, discovered over the
`@@index([state])` that shipped in Phase 4A-2a. The invariant the milestone owes —
*loss of an in-process wake signal must not make durable work unreachable* —
holds by construction: there is no wake signal to lose.

### The port is removed, not neutered

Deleted: `SceneGenerationQueue`, `SceneGenerationJob`,
`RecordingSceneGenerationQueue`, the `queue` dependency on
`GenerationServiceDeps`, and the enqueue call.

A no-op adapter was the alternative and was rejected. It would have preserved
merged call sites at the price of a contract false in both halves — acceptance no
longer conferred by the call, and a row nobody enqueued still executable. This
repository has already paid twice for surface that reads as a capability the
system has: `ProviderGenerationInput`'s unread `negativePrompt`/`cameraMotion`
(removed in 4B-2b) and three undocumented fields sent to WaveSpeed (corrected in
4B-2a).

### Admission is create → audit

```
render/freeze → create QUEUED row → audit generation.requested → return
```

`GenerationServiceDeps` loses its `queue` key. What pins that is **not** an
assertion on the key set — that assertion existed in the first commit and was
removed in the second, because it broke on any legitimate new dependency and so
trained a reviewer to update it reflexively. Two behavioural checks pin it
instead: no wired dependency exposes a video-provider, object-storage, or
job-transport method surface, and none is *named* for a transport. A provider or
queue collaborator reappearing is a test failure, not a diff to skim.

### Eligibility is state, never audit existence

If `create` succeeds and `audit` throws, the caller gets the error and **the row
stays executable**. Gating execution on an audit row would let a failing audit
sink silently cancel durable customer work — an observability failure becoming a
correctness failure. The exposure this leaves (a generation with no
`generation.requested`) is **not mitigated by this milestone**. It is inert only
because nothing submits — an incompleteness, not a safeguard — so the mitigation
is recorded as a requirement on whichever milestone adds provider submission:
it must audit the paid call itself, so no provider charge is unaudited. That
requirement lives in `docs/decisions/TODO.md`, not in a claim here.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm test` | **1157 passed**, 58 files (baseline 1155 / 58) |
| `pnpm build` | clean |
| `pnpm test:db` | **126 passed**, 6 files |

### Test ledger

Four cases retired with their subject, five replaced them, six were amended, and
the dependency-shape assertion was replaced by two behavioural ones (below).

| Retired | Why |
| --- | --- |
| `enqueues a new attempt exactly once with a generationId-only payload` | No payload exists to inspect |
| `does not enqueue a reused attempt` | Replaced by "creates no second row for a reused attempt" |
| `leaves a durable QUEUED row, audits nothing, and propagates` (enqueue failure) | Replaced by the audit-failure equivalent |
| `returns the stranded QUEUED row on a later call without re-enqueuing` | No row can strand; replaced by the unaudited-row re-entry case |

New in `describe("startScene — row-as-queue admission")`: admission leaves a
durable `QUEUED` row and nothing else · a reused attempt creates no second row ·
the row is created **before** the audit is attempted · an audit-sink failure
leaves an executable row and propagates · a later call returns that same
unaudited row rather than a second one.

Amended rather than deleted: `keeps the frozen prompt out of the queue payload
and the audit entry` → `…out of the audit entry`. Half its subject retired with
the transport; the surviving half is now the whole leak surface admission has,
which makes the assertion stronger than it was, not weaker.

**The exact-dependency-key assertion was replaced.** Asserting
`Object.keys(serviceDeps)` equals a fixed five-element list fails whenever a
legitimate dependency is added — a clock, a metrics sink — which trains a
reviewer to update it reflexively, precisely when it would otherwise have caught
something. Two checks replace it, and they test capability rather than shape: no
wired dependency exposes a video-provider, object-storage, or job-transport
method surface, and no dependency is *named* for a transport (a stub might expose
no method at all, so the surface check alone would miss it).

Verified in both directions: wiring a provider-shaped and a `queue`-named
collaborator fails both checks, while adding a `clock` and a `metrics` dependency
leaves them green — the brittleness the old assertion had.

### Mutation verification

| Mutation | Result |
| --- | --- |
| Admission swallows audit-sink failures instead of propagating | **5 fail** |
| Admission audits from `input` **before** `create` | **9 fail** |

Both restored, with `git diff --stat` confirming the service file byte-identical
to `HEAD`, and the full suite re-verified at 1157/58.

## Invariants held

8-fact `requestHash` **unchanged** · the frozen prompt is still rendered once at
admission and never re-rendered · the five Phase 4B-1c snapshot fields and the
4C-0a sixth are untouched · reuse precedence unchanged (active, then latest
succeeded) · the partial unique index remains the concurrency authority and
races still converge by re-reading · audit metadata remains an explicit
nine-field allowlist · **no schema, no migration, no state-machine change** · no
worker, no execution repository, no asset lookup, no signed URL, no provider
input assembly, no `createGeneration` call, no polling, no `SUBMITTING`
recovery, no model routing, no WaveSpeedAI call.

## Documentation backlog corrected

**Thirty-one claims** of a review status that stopped being true at merge. The
first pass found eight by grepping for the phrasings this milestone's own reports
used; a wider sweep found the rest — every Phase 3 completion report carries
`implemented, awaiting review`, for milestones merged and tagged months ago.
Fixing eight while leaving twenty-three would have made the convention a claim
rather than a practice.

The eight found first, across six completion reports, the Phase 2 release notes,
and three `CHANGELOG.md` entries:
`docs/phase-3a1-completion.md`, `docs/phase-4b1b-completion.md`,
`docs/phase-4b1c-completion.md`, `docs/phase-4b2b-completion.md`,
`docs/phase-4c0a-completion.md`, `docs/phase-4c0b-completion.md`,
`docs/release-notes-phase-2.md` (a merged, tagged release still described as an
unmerged candidate), and the changelog entries for 4B-1a, 4B-1c, and 4C-0a.

The remaining twenty-three: twenty-two Phase 3 reports carrying
`Status: **implemented, awaiting review**`, plus `docs/phase-3a2b-completion.md`
still awaiting a merge approval it received. Each now points at the milestone
table in `docs/progress.md` for lifecycle facts and declares itself a technical
snapshot.

All are now factual, and the convention prevents the class rather than the
instances — including for this milestone, whose own row points at PR #38 rather
than asserting a state that would expire at merge.

`docs/decisions/TODO.md`'s *"Exactly one `CompiledPrompt` → provider prompt
renderer may exist"* is also closed — satisfied by Phase 4B-2b's `renderPrompt`
and left unchecked since.

## Review finding — canonical guidance still specifies the removed transport

Automated review on PR #38 raised a P2 that verified true against all three files
it named: with the transport gone, the repository's own implementation guidance
would still lead a later milestone to rebuild it.

| Source | What it still says |
| --- | --- |
| `CLAUDE.md` | recommended stack lists **"Queue-based workers"**; the mandated workflow reads `Create idempotent job → Enqueue → …` |
| `docs/SystemArchitecture.md` | **"Queue: Redis/BullMQ, SQS, or Azure Service Bus"** — the three brokers ADR-0024 evaluated and rejected by name — and generation APIs returning after "enqueueing" |
| `apps/worker/src/bootstrap.ts` | "Later phases attach the queue consumer here" |

**All four are now aligned**, but not in one step, and the sequence is the point.
The code comment and `docs/architecture.md` were corrected immediately, being
implementation. `CLAUDE.md` and `docs/SystemArchitecture.md` were not: `CLAUDE.md`
is the governance authority and `SystemArchitecture.md` is source of truth #2, and
an agent editing the constraints it is judged against, so they match what it has
just built, is the wrong direction of authority however reasonable the edit looks.
They were raised as a decision the CTO owns, with the exact conflicting lines and
suggested wording, and changed only after explicit authorization.

| Source | Now reads |
| --- | --- |
| `CLAUDE.md` stack | "Queue-based or state-driven workers", naming ADR-0024 |
| `CLAUDE.md` workflow | `→ Persist as durable executable work` replaces `→ Enqueue` |
| `docs/SystemArchitecture.md` queue line | a dated supersession: no broker, and the three named ones were evaluated and rejected — adding one later must supersede ADR-0024 rather than default to it |
| `docs/SystemArchitecture.md` async section | no enqueue step; the durable `QUEUED` row is the acceptance condition |

The `TODO.md` entry is closed rather than deferred to 4C-1b.

## Known limitations

- **A rejected `startScene` no longer means nothing happened.** It never fully
  did, but the surviving case deserves naming: an audit-sink failure returns an
  error for work that is admitted and will execute.
- **Nothing consumes `QUEUED` rows yet.** Discovery arrives in Phase 4C-1b and
  execution after it; until then a `QUEUED` row is durable, correct, and inert.
- **`startScene` still has no production caller.** The HTTP entry point is Phase
  4E, unchanged by this milestone.

## Size

| Category | Lines changed |
| --- | --- |
| Production | 158 |
| Tests | 193 |
| Docs | 713 |
| **Total** | **1,064** across 48 files |

Measured from `git diff --numstat 082a596..HEAD` after the final commit existed,
reconciling with the raw diff (`+781 −283 = 1064`).

Against the approved estimate of 680–760, and above it by 304. The first commit
landed at 787 across 22 files, within 27 of the estimate; the pre-merge
corrections added the rest, and nearly all of it is the widened documentation
sweep — twenty-three additional stale status lines across Phase 3 reports, at two
changed lines each, in twenty-three files that would otherwise not appear in this
diff at all.

**Production is 158 lines and 283 of the 1,064 are deletions.** The code change
this milestone was approved for did not grow; the honesty debt it uncovered did.
