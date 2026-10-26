# Completion — starting a video, and previewing and downloading it

Branch: `claude/project-thread-az06z2`
ADRs: `docs/decisions/0082-a-failed-deliverable-settles-its-job.md` (GS-1)
Gap analysis: `docs/generation-e2e-gap-analysis.md`
Plan: `/mnt/project-files/cto/generation-e2e-proposal.md`, approved by the
product owner on 2026-10-26, including the development-only pipeline command

The product owner approved connecting the built, dormant generation steps and
adding the screens, so that a person on a development machine can start a
video on the test provider and preview and download it, in about thirteen pull
requests (GS-1 to GS-13), each merged only with their yes. Each extends this
record. The plan is not a Roadmap phase, so it receives no `phase-N-complete`
tag.

## GS-1 — a failed deliverable settles its job

Base: `dbe8038` (PR #104 merge commit on `main`; post-merge CI run 666 green).
ADR: `docs/decisions/0082-a-failed-deliverable-settles-its-job.md`

**No migration**, although the plan expected one: every state and column the
settlement needs already exists.

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `70a09ac` | the domain decision, the database settlement, both writers' wiring, the reserved edges, the tests, ADR-0082 and the documentation |
| `0316afa` | the review's answers: the claim's work row matched, the cost-admission lock first, the replacement's replay requiring its consumed Unit, the settlement defect's code reported, the guards rewritten onto the settlement, the ADR and TODO corrections |
| this commit | this record |

The exact head SHA is reported with the pull request.

### What GS-1 does

- **One decision for every failure class.** `settleFailedDeliverable` reads
  the job's deliverable pointer and its reservation's state: an initial
  generation whose Unit is `RESERVED` or `RECONCILIATION_HOLD` fails and
  releases it; a replacement whose earlier delivery is `CONSUMED` rolls back to
  `DELIVERABLE_READY`; anything else is refused with
  `RESERVATION_NOT_SETTLEABLE` and nothing is written.
- **In the commit that records the failure.** `blockComposition` and the
  three terminal verdicts call `settleDeliverableFailure` after writing their
  terminal row, so the failure and its settlement commit together or not at
  all. The release is stamped with the block's or the verdict's instant.
- **The cost-admission lock, then Reservation, then Job.** Both writers take
  the organization and billing-cycle lock every entitlement release takes,
  then lock the reservation, tenant-scoped through the version, then their
  chain.
- **Only the running cycle.** A block or verdict for a job that left the
  cycle's state, for a version that is not the job's newest, or (a block)
  with a claim whose work row is not the version's own, is `LEASE_LOST`.
- **A replay must find its settlement**, or throws `SETTLEMENT_INCOMPLETE`.
- **The generic API cannot end a Unit-holding job**: eight edges reserved.
- **Still dormant.** Nothing in production constructs either runner.

```mermaid
sequenceDiagram
    participant W as Block or verdict
    participant R as Reservation
    participant J as Job chain
    participant D as settleFailedDeliverable
    W->>W: cost-admission lock (organization, billing cycle)
    W->>R: lock (tenant-scoped, through the version)
    W->>J: lock job, version, work rows
    alt terminal row already written (replay)
        W->>W: settled? else SETTLEMENT_INCOMPLETE
    else job not in this cycle, an older version, or another version's work
        W-->>W: LEASE_LOST, nothing written
    else
        W->>W: write BLOCKED / INVALID_MEDIA / INTEGRITY_MISMATCH
        W->>D: pointer, reservation state
        alt initial generation, Unit held
            D-->>W: RELEASE
            W->>J: COMPOSING or DELIVERABLE_VALIDATING -> FAILED_TERMINAL
            W->>R: -> RELEASED, releasedAt
        else replacement, Unit consumed
            D-->>W: ROLL_BACK
            W->>J: -> DELIVERABLE_READY, pointer unchanged
        else contradiction
            D-->>W: RESERVATION_NOT_SETTLEABLE (all rolled back)
        end
        W->>W: pointer unmoved, commit
    end
```

### Verification

Measured locally on `0316afa` (PostgreSQL 16 configured like CI; FFmpeg
6.1.1, the version CI's `media` job installs). This record's commit changes
only this file.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5976 / 5976**, 215 files (5937 on `dbe8038`) |
| `pnpm test:db` | **1538 / 1538**, 58 files (1505 on `dbe8038`) |
| `pnpm test:media` | **169 / 169**, on `70a09ac`: no media code changed since |
| `pnpm build` | succeeded |
| `prisma migrate diff` (migrations against the schema) | no difference |

New and changed tests:

- `packages/domain/src/deliverable-settlement/settlement.test.ts` (new):
  both held reservations released and a consumed one rolled back; every
  other pointer and reservation pair refused with
  `RESERVATION_NOT_SETTLEABLE`, checked over the whole table; the replay
  check for each arm and each failed cycle, a replacement's only while its
  Unit is still `CONSUMED`; the defects' fixed messages.
- `packages/domain/src/deliverable-settlement/settlement-shape.test.ts` (new):
  the database settlement updates the job and the reservation once each and
  inserts or deletes nothing; it moves the reservation only to `RELEASED` with
  its instant, never consumes or writes the pointer, writes only the job state
  the domain chose, and takes the cost-admission lock before the reservation;
  neither writer releases or fails a job itself, and each settles in one
  place.
- `tests/integration/deliverable-failure-settlement.db.test.ts` (new): the
  replacement arm for a block and a verdict, each replayed; a replay after the
  job moved on to a later cycle; a reconciliation hold released by a block and
  by a verdict; every contradicting reservation writing nothing, the terminal
  row included; a replay whose settlement is missing refused; a cycle the job
  no longer runs, an older version, or a claim naming another version's work,
  lost; another tenant's claim lost; the eight reserved edges refused by the
  generic API; and the lock order: a writer holding the reservation and then
  needing the job makes both a block and a verdict wait, without a deadlock,
  and each waits for the cost-admission lock of its organization and cycle.
- `tests/integration/unit-entitlement-ledger.db.test.ts`: a deliverable that
  fails validation gives every frozen Unit back; the balance equals the
  balance before the reservation and no allocation moves.
- `tests/integration/deliverable-composition-execution.db.test.ts`,
  `deliverable-validation.db.test.ts`, `deliverable-plan.db.test.ts` and
  `deliverable-composition-execution-races.db.test.ts`: the five tests that
  pinned "a failure settles nothing" now pin the settlement: an initial job
  `FAILED_TERMINAL` with its reservation `RELEASED` at the failure's instant, a
  replacement `DELIVERABLE_READY` with its reservation untouched, and the
  settlement's job and reservation events.
- `packages/domain/src/orchestration/state-machines.test.ts`: the new
  `COMPOSING → DELIVERABLE_READY` edge.
- `packages/domain/src/deliverable-validation/dormancy.test.ts` and
  `deliverable-composition-execution/dormancy.test.ts`: the guards that said
  neither repository moves money now say what is true, that neither writes a
  Unit or a terminal job state itself and each reaches the settlement from its
  failure path alone; the settlement module and its lock reach nothing outside
  the database package, the domain and Prisma.
- `packages/domain/src/deliverable-validation/runner.test.ts`: the sweep
  reports a settlement defect's code.

The lock-order test was checked against the inverted order: with
`blockComposition` locking the job before the reservation, it fails with a
PostgreSQL deadlock.

### Mutation testing

Each mutant applied to the source, the relevant suites run, and the file
restored and checked by SHA-256; the repository's manifest was identical
before and after each pass.

**Round 1, on `70a09ac`: 44 mutants, 44 killed.** None survived, none broken.

| Mutant | Area | Change | Killed by |
| --- | --- | --- | --- |
| S01 | decide | a held Unit is not released | settlement, db-settle |
| S02 | decide | a reserved Unit is not released | settlement, db-compose |
| S03 | decide | an initial generation released whatever its Unit | settlement, db-settle |
| S04 | decide | a replacement rolled back whatever its Unit | settlement, db-settle |
| S05 | decide | a replacement releases instead | settlement, db-settle |
| S06 | replay | an initial settlement held without its release | settlement |
| S07 | replay | an initial settlement held without its job | settlement |
| S08 | replay | a later cycle not recognised | settlement, db-settle |
| S09 | replay | a replacement always held settled | settlement, db-settle |
| S10 | defect | a defect's message changed | settlement |
| M01 | state | the rollback edge missing from the state machine | state-machine |
| H01 | lock | the reservation read without its lock | db-settle |
| H02 | settle | the job not moved | db-compose, db-settle |
| H03 | settle | the Unit not released | db-compose, db-ledger |
| H04 | settle | no release instant | db-compose |
| H05 | settle | released only from RESERVED | db-settle |
| H06 | events | the job event types swapped | db-compose, db-settle |
| H07 | events | no reservation event | db-compose |
| H08 | events | no reason code | db-compose |
| H09 | replay | a missing settlement never refused | db-settle |
| H10 | settle | the reservation's state never read | db-compose |
| K01 | compose | a block settles nothing | db-compose |
| K02 | compose | the reservation locked after the chain | db-settle |
| K03 | compose | a block on an older version settles | db-settle |
| K04 | compose | a block on a job that left composing settles | db-settle |
| K05 | compose | a replayed block's settlement unchecked | db-settle |
| K06 | compose | the block's cycle named as validation | db-compose |
| K07 | compose | every version taken as the newest | db-settle |
| K08 | compose | the newest ordinal read as the lowest | db-settle |
| V01 | validate | a verdict settles nothing | db-validation |
| V02 | validate | the reservation locked after the chain | db-settle |
| V03 | validate | a verdict on a job that left validation settles | db-settle |
| V04 | validate | a verdict on an older version settles | db-settle |
| V05 | validate | a replayed verdict's settlement unchecked | db-settle |
| V06 | validate | the release stamped with the clock | db-validation |
| V07 | validate | every version taken as the newest | db-settle |
| E-RESERVED→CANCELLED | edges | the generic API takes RESERVED → CANCELLED | db-settle |
| E-RESERVED→FAILED_TERMINAL | edges | the generic API takes RESERVED → FAILED_TERMINAL | db-settle |
| E-GENERATING→FAILED_TERMINAL | edges | the generic API takes GENERATING → FAILED_TERMINAL | db-settle |
| E-SCENES_READY→FAILED_TERMINAL | edges | the generic API takes SCENES_READY → FAILED_TERMINAL | db-settle |
| E-COMPOSITION_PENDING→FAILED_TERMINAL | edges | the generic API takes COMPOSITION_PENDING → FAILED_TERMINAL | db-settle |
| E-COMPOSING→FAILED_TERMINAL | edges | the generic API takes COMPOSING → FAILED_TERMINAL | db-settle |
| E-DELIVERABLE_VALIDATING→FAILED_TERMINAL | edges | the generic API takes DELIVERABLE_VALIDATING → FAILED_TERMINAL | db-settle |
| E-COMPOSING→DELIVERABLE_READY | edges | the generic API takes COMPOSING → DELIVERABLE_READY | db-settle |

Suites: `settlement` = `settlement.test.ts`; `state-machine` =
`state-machines.test.ts`; `db-settle` = the new settlement database suite;
`db-compose` = the composition database suite; `db-validation` = the
validation database suite; `db-ledger` = the Unit entitlement ledger suite.
K02 is the inverted order the lock-order test was checked against by hand:
with it, a block deadlocks behind a writer holding the reservation.

**Round 2, on `0316afa`: the 44 again, with S08 and S09 re-anchored on the
replacement's new replay check, and eleven added for the review's answers: 55
mutants, 54 killed.** V08 survived: it added a bare reference
`void settleDeliverableFailure;` inside the verdict, which settles nothing and
is no second settlement, so the guard, which counts calls, rightly passes. It
was replaced by V09, a second settlement call from the `VALID` verdict, run on
its own afterwards and killed by the guards. None broken.

| Mutant | Area | Change | Killed by |
| --- | --- | --- | --- |
| S08 | replay | a later cycle not recognised | settlement, db-settle |
| S09 | replay | a replacement always held settled | settlement, db-settle |
| S11 | replay | a replacement held settled without its Unit | settlement |
| C01 | cost-lock | no cost-admission lock | db-settle, shape |
| C02 | cost-lock | the lock taken on another cycle | db-settle |
| C03 | cost-lock | the lock taken after the reservation | shape |
| G01 | guard | the settlement consumes instead | shape |
| G02 | guard | the settlement names its own job state | shape |
| G03 | guard | the settlement writes the pointer | shape |
| K09 | compose | a claim's work row not matched to its version | db-settle |
| K10 | guard | the block appends an event of its own | dormancy-compose |
| R01 | runner | a settlement defect's code dropped | runner |
| V08 | guard | a bare reference to the settlement in the verdict (no call) | **survived**, equivalent |
| V09 | guard | the VALID verdict settles too | dormancy-validation, shape |

New suites: `shape` = `settlement-shape.test.ts`; `runner` = the validation
`runner.test.ts`; `dormancy-compose` and `dormancy-validation` = the two
dormancy suites.

### Review

Codex is at its usage limit, so, as for DS-3 to DS-6b, an independent review
agent reviewed `70a09ac` against `dbe8038`, reading only git objects. It found
no way, with well-formed claims, to consume a Unit, release one twice, or
commit a terminal row without its settlement; it confirmed that a job holds one
reservation, so a replacement has nothing of its own to release, that no
transaction locks the job before the reservation, and that nothing in
production took any of the newly reserved edges. Verdict: nothing blocking;
five should-fix findings and five nits, answered in `0316afa`:

| Finding | Answer |
| --- | --- |
| `blockComposition` never matched the claim's work row to the version it locked: a claim pairing one version with another's work would block that other work unlocked and unsettled, and settle this job while its work still ran | Fixed: `LEASE_LOST` unless the locked work row is the claim's, as `finalizeComposition` asks (ADR-0082 Decision 4). Test: a block whose claim names another version's work writes nothing to either job. Mutant K09 |
| A settlement defect rolls the whole transaction back, so the work stays `RUNNING`, is re-offered after its lease and repeated, re-encoding each time; the validation sweep recorded its code as `null` | The defect stays a defect, as Transaction G's refusals of the same reservations are. ADR-0082 Decision 2 now says the work is re-offered and repeated, its cost (as ADR-0078's), and that nothing in production can produce such a reservation today. The validation sweep now reports the defect's code (mutant R01); TODO's operator-tooling and findability items name it. The generic reservation API's release is not reserved here: many suites use it, and its owners are later milestones' |
| Five guard tests (three in composition's dormancy suite, two in validation's) now passed vacuously and stated the opposite of the code | Rewritten as what is now true: each repository writes no Unit or terminal job state itself and reaches the settlement from its failure path alone. A new suite, `settlement-shape.test.ts`, holds the settlement module: one update each of the job and the reservation, the reservation only to `RELEASED` with its instant, never `CONSUMED` or the pointer, only the job state the domain chose, and the cost-admission lock before the reservation. Mutants G01 to G03, K10, V09 |
| The documented rule that every entitlement release takes the cost-admission lock before the reservation was skipped, and the ADR misattributed the order to Transaction H | Fixed: both writers take the organization and billing-cycle lock first, as Transaction H does (ADR-0082 Decision 3). Tests: a block and a verdict each wait for that lock. Mutants C01 to C03 |
| A failed replacement after a delivered scene regeneration keeps the new rendition and the counted right; if the block came from that rendition, every later revision fails the same way, while a regeneration that fails earlier spends no right | Recorded as an open decision gate in TODO, not decided here; ADR-0082's *Not decided here* and *Consequences* and the Roadmap now say "charging no Unit" and name the right |
| Nit: the ADR said the suite proves the inverted order deadlocks; the wait helper counted any waiting backend | The ADR now says that was checked by hand. The helper counts only a backend waiting on the reservation's lock statement, or on the advisory lock |
| Nit: `lockClaimChain` reads the work row and `highestOrdinal` from the pre-wait snapshot | Commented: safe because the work row's writes are compare-and-set and Transaction I, the only writer of versions, holds the reservation the block now takes first |
| Nit: a replacement's replay check never read its reservation | It now requires `CONSUMED`. Mutant S11 |
| Nit: "never consumes a Unit" only searched the JSON | Replaced by the whole table: three rows settle, every other pair is the defect |
| Nit: about 1,900 changed lines against the ~500-line policy | About 810 are production code with its comments (after these answers); the rest are tests and documentation. DS-6b's PR was a similar size. Splitting the decision from its wiring would leave a dormant module nothing calls in one PR |

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: the composition-execution and validation rows |
| Entity-relationship diagram | `docs/er-diagram.md`, *GS-1*: not applicable, no entity, relationship or column changes |
| Critical sequence diagram | the diagram above; the decision is ADR-0082 Decision 2 |
| OpenAPI / API change summary | `docs/api-changes-gs-1.md`: no HTTP change; the domain decision, the writers' new behaviour, the reserved edges |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *GS-1*: no migration, what rolling back means, and a query for terminal rows recorded before this build |
| Completion report | this file |

Also updated: `docs/Roadmap.md`, `docs/generation-e2e-gap-analysis.md` and
`docs/decisions/TODO.md` (the Phase 5B and 5C settlement items, the permanent
technical-failure item, the operator-tooling and findability items, and two new
open decision gates: whether operator recovery consumes a Unit, and whether a
failed replacement gives back the scene regeneration right that started it).

### Activation status

Nothing paid or scheduled is activated. Nothing in production constructs the
composition or validation runner: no worker, scheduler, credential,
environment variable or payment integration. Paid Provider Activation,
production Provider credentials, production paid AI calls, the production
scheduler and live Stripe charges remain BLOCKED.

### Known limitations

- **Provider-side failures** (a refusal, a failure, an unresolved submission)
  before composition still leave the job and its Unit where they are. GS-2
  settles them.
- **Transaction G's defects and a claim refused as `UNSUPPORTED_TARGET`**
  write no terminal row, so nothing settles them; they wait for an operator.
- **A failed replacement after a delivered scene regeneration** keeps the
  scene's new rendition and its counted regeneration right (ADR-0082, *Not
  decided here*; TODO).
- **A settlement defect is repeated, not parked.** Work whose reservation
  contradicts its job rolls back and is re-offered every lease period,
  repeating its encode or probe (ADR-0082 Decision 2). Nothing in production
  can produce such a reservation today; the operator tooling that finds and
  stops it is in TODO.
- **Terminal rows recorded before this build** are never settled late: a
  replay refuses them with `SETTLEMENT_INCOMPLETE`. Only development data can
  hold them; the migration notes give the query.
- **Whether a video delivered by operator recovery consumes a Unit** is not
  decided (TODO).

### Remaining work

GS-1 waits for the product owner's yes before merge. GS-2 (provider-side
failures settle the job) comes next.
