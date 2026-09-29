# Phase 5C completion — deliverable validation and the publication boundary

Branch: `phase-5c-deliverable-validation-and-publication`
Base: `74247282ecd30e4716a1102f3260267c14c745d0` (Phase 5B merge commit on `main`)
ADR: `docs/decisions/0051-deliverable-validation-and-the-publication-boundary.md`

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `b13cd8a` | the durable verdict, Transaction G, migration 16, the domain and database suites, and ADR-0051 |
| *(this commit)* | the phase documentation, and the races suite's discriminated-union fix |

The exact head SHA is reported with the pull request rather than written into a
file it would have to contain the hash of.

## Gap analysis — what was missing before this phase

Phase 5B leaves a job in `DELIVERABLE_VALIDATING` with an `OUTPUT_VERIFIED`
composition behind it and nothing draining it. Five things did not exist:

1. **No deliverable media verdict.** `OUTPUT_VERIFIED` claims only that an object
   exists at the canonical key and its digest and byte count were read from the
   bytes actually there. Whether it is a playable container with a real duration
   had never been asked, and `ManagedOutputMediaValidation` could not answer it —
   its `sceneGenerationId` is `@unique` with a required foreign key, so it is
   one-to-one with a *provider attempt* by construction.
2. **No actor for the publication edges.** `DELIVERABLE_VALIDATING ->
   DELIVERABLE_READY` and both edges into `CONSUMED` were reserved from the
   generic transition API with nothing able to take them.
3. **No unit settlement.** `consumedAt` had no writer anywhere in the system, and
   `GenerationReservation` could not leave `RESERVED` except by release.
4. **No deliverable pointer writer.** `GenerationJob.currentDeliverableVersionId`
   was constrained, documented and never assigned. Phase 5A and 5B each prove
   they leave it untouched; nobody moved it.
5. **No distinction between "not usable" and "not now".** A deliverable-level
   storage failure and a deliverable-level media failure had no vocabulary at
   all, so neither could be recorded without inventing one under pressure.

## What this phase adds

- **`GenerationDeliverableValidation`** (migration 16) — one durable verdict per
  deliverable *version*, unique on `deliverableVersionId`, with the composition's
  receipt frozen into it at creation.
- **The lifecycle** — `claimDeliverableValidation`, `finalizeValid`,
  `finalizeInvalidMedia`, `finalizeIntegrityMismatch` and `deferValidation`: five
  short, database-only transactions with every external byte between them.
- **Transaction G** (`publishDeliverable`) — the publication boundary. The job
  move, the deliverable pointer, the entitlement consume where one is owed, and
  every transition event, in one commit.
- **`DeliverableMediaValidationPort`** — a second port over the *same* adapter,
  so one implementation answers the media question for both an attempt's output
  and a composed deliverable without either key brand widening.
- **A bounded runner** — one pass, no loop, no timer, no production caller.

## The business fact

A composed deliverable is proved playable before anyone can be shown it, and a
customer's unit is spent in the same commit that makes the video theirs — once,
whatever crashes or races happen around it.

## The publication sequence

```mermaid
sequenceDiagram
    autonumber
    participant R as DeliverableValidationRunner
    participant DB as PostgreSQL
    participant S3 as Object storage
    participant FF as ffprobe

    R->>DB: findValidationCandidates(now, limit)
    DB-->>R: identifiers only
    R->>DB: claim (tx: Job → version → composition → validation)
    DB-->>R: CLAIMED { key, frozen receipt }
    Note over R,DB: no transaction open, no row lock held
    R->>S3: GET canonical deliverable object
    S3-->>R: bytes (streamed, hashed on the way past)
    R->>FF: probe(local file)
    FF-->>R: container, duration, dimensions, streams
    R->>DB: finalizeValid (tx: verdict + deliverable.validated)
    DB-->>R: FINALIZED { publication }
    R->>DB: Transaction G (tx: Reservation → Job → version → …)
    Note over DB: DELIVERABLE_VALIDATING → DELIVERABLE_READY,<br/>pointer set, unit consumed, 3 events
    DB-->>R: PUBLISHED_AND_CONSUMED
```

The three database boxes are three separate transactions. Nothing holds a row
lock across the object-store read or the inspector, and Transaction G — which
holds the entitlement lock — is last.

## Lock order

```text
validation lifecycle : GenerationJob → version → composition → validation
Transaction G        : GenerationReservation → GenerationJob → version
                       → composition → validation
```

`Reservation → Job` is the system-wide order Transaction H and Transaction I both
take. The lifecycle transactions never lock the reservation at all — validation
moves no entitlement — so they cannot form the inverse pair with Transaction G
either. Both directions are pinned behaviourally against the real publication
path in `tests/integration/deliverable-validation-races.db.test.ts`.

## Two defects the suites found

**The composition receipt was read and never compared.** `finalizeValid` proved
the caller's receipt against the validation row's frozen binding, then called
`provenCompositionReceipt` and discarded its result. A composition whose receipt
changed underneath a running validation was therefore finalized as a `VALID`
verdict about bytes nobody had measured. Found by
*"refuses to judge a deliverable whose composition receipt moved underneath it"*,
which resolved `FINALIZED` instead of rejecting. All three receipts — the
caller's, the row's frozen binding, and the composition's — are now proved to
agree in one function with one call site per transaction.

**The lock and the read were one statement.** `lockValidationChain` took
`FOR UPDATE OF j, v` in the same statement that outer-joined the composition and
validation rows. Under `READ COMMITTED` a blocked statement re-evaluates only the
*locked* row when released; every other table in it is still read from the
snapshot taken when the statement began. Two workers racing to create the first
validation record therefore both saw no row, both inserted, and the loser learned
it through a raw `P2002` rather than through the `NOT_CLAIMABLE` its caller is
written against. Found by *"gives the lease to exactly one of two simultaneous
claimers"*. The lock and the read are now separate statements, and the second one
takes a fresh snapshot.

## Verification

| Check | Result |
| --- | --- |
| `pnpm lint` | clean, exit 0 |
| `pnpm typecheck` (root, all packages) | clean, exit 0 |
| `pnpm test` | **4638 passed / 4638**, 146 files |
| `pnpm test:db` | **1151 passed / 1151**, 37 files |
| `pnpm build` | Next.js production build succeeded |
| `prisma validate` | schema valid |
| `prisma migrate diff --from-migrations … --to-schema-datamodel` | **No difference detected** |
| `prisma migrate status` | up to date after `migrate deploy` applied 16 on top of 15 |
| Mutation ledger (impacted set) | **58 run, 58 killed, 0 survivors**, 0 anchor-missing (one survivor investigated and re-aimed — below) |

The root `pnpm typecheck` covers `tests/integration/`, and it caught a real defect
the per-package typechecks did not: the races suite destructured a `Promise.all`
over two differently-typed settled results, which widens into a union that has
lost its discriminant, so the assertions were reading `value` off an arm that has
none. The two promises are now awaited separately.

## Mutation ledger

**58 run, 58 killed, 0 survivors, 0 anchor-missing.** The harness holds 343
definitions (M01a–M342); the impacted set is every definition whose anchor lies
in a file this phase changed — the twenty-one new Phase 5C definitions (M322–M342)
plus the thirty-seven pre-existing ones anchored in
`packages/storage/src/managed-output/media-validation.ts` and
`packages/database/src/orchestration-repositories.ts`.

Every one of the 343 anchors was verified to still match before the run, which is
the evidence that this phase's refactor of the media validator broke none of the
existing ledger.

**Restoration proved, not assumed.** A `sha256sum` manifest of all 693 tracked
files was taken before the run and re-checked after it: 693 of 693 identical, and
`git status` clean.

### The survivor, and what was done about it

**M339, as originally aimed** — "a stale worker's late finalize overwrites the
reclaimer's row", removing only the `version` check from `holdsClaim` — SURVIVED.
The reason is structural domination rather than a missing test: the finalize CAS
that follows already names `version: claim.version` **and**
`leaseToken: claim.leaseToken`, so a stale worker that gets past the relaxed
guard still matches zero rows and still returns `LEASE_LOST`. The guard is
correct defence in depth with no observable behaviour of its own, so no
single-edit mutation of it can be killed.

The assignment was kept and the slot re-aimed at all three layers at once — the
`holdsClaim` version check and both CAS predicates — which is the only
arrangement under which the property is observable at all. Re-aimed, it is
killed by 2 database failures. The original aim and the reason it survived are
recorded inline in the harness beside the definition, not deleted.

### The two defects the ledger's own suites had already found

M336 (*the lock and the read are collapsed back into one statement*) and M338
(*the composition's own receipt is read but never compared*) are the two defects
described above, re-injected. Both are killed, which is what makes the two tests
that found them load-bearing rather than incidental.

## Required phase documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` — the validation and publication boundary added to the Phase 5 pipeline. The adjacent Phase 5B row still read **“Not implemented”** and was corrected in the same table: documentation must describe implemented behaviour, and leaving a shipped phase marked unimplemented directly above the new row would have been a worse deviation than the one-line fix |
| Entity-relationship diagram | `docs/er-diagram.md` — `GenerationDeliverableValidation` |
| Critical sequence diagram | above, and in ADR-0051 |
| OpenAPI / API change summary | **Not applicable.** No HTTP route, request, response or error was added, removed or changed. The whole phase is behind repository ports with no production caller. |
| Change log | `CHANGELOG.md` |
| Release notes | **Not applicable.** Nothing in this phase is reachable by a customer: no route, no UI, no scheduler and no production caller. There is nothing to announce until publication is activated. |
| Database migration notes | `docs/migration-notes.md` — migration 16 |
| Phase completion report | this file |

## Activation status

| Gate | State |
| --- | --- |
| Paid Provider Activation | **BLOCKED** — unchanged. No provider credential, no live call, no provider code touched. |
| Production scheduler | **Not activated.** No cron, timer, `setInterval` or production caller exists for this phase or any earlier dormant runner. |
| Payment integration | **Not started.** No Stripe, no invoice, no overage purchase. The unit consume is an entitlement-ledger fact, not a charge. |
| Production AWS | **Not activated.** No `S3Client` is constructed in production code. |
| Closed beta | **Not started.** |

## Carried forward

- **A settlement policy for a permanently unusable deliverable.** An
  `INVALID_MEDIA` or `INTEGRITY_MISMATCH` verdict strands its job in
  `DELIVERABLE_VALIDATING` with a reserved unit and, on a recomposition, a
  customer still holding their previous video. Who bears that cost is a separate,
  reviewed decision. Recorded in `docs/decisions/TODO.md`.
- **An operator path out of a terminal verdict**, and out of Phase 5B's
  `BLOCKED`. Deliberately absent for the same reason: re-queueing work without
  deciding *why* it failed re-enters the loop these states exist to end.
- **Human review before publication.** `CLAUDE.md` requires that AI output is
  never published automatically. Transaction G is the *technical* publication
  boundary and is dormant; the review gate that must precede it does not exist
  yet, and activating this runner without one would violate that rule.
- **The AI-generated disclosure.** The composition profile renders no overlay and
  no watermark, and validation does not check for one. The mandatory disclosure
  is still unimplemented.
- **The scheduler.** Every runner from Phase 4C-3B onward is dormant. Activating
  them is its own decision, and this phase does not make it.
