# Phase 4C-3B-2G-2 — Completion report

Reconciliation resolution and deadline exhaustion. Base:
`82df709dcd20b8ed1f4fda8ace22ece7b763b6a0`.

> **Revision 2 — CTO review corrections.** The first submission
> (`359f5545942c299216a53f9e2cb40a0faa7b7a64`) was not approved. Two blocking
> defects are corrected here, and both turned out to be **live, exploitable
> bugs rather than theoretical gaps** — each was reproduced against the rejected
> head before being fixed:
>
> | Superseded claim | Correction |
> | --- | --- |
> | The reconciliation write is tenant-scoped | It was scoped at the *read*, which `apply` does not require. A session opened for organization B could name organization A's attempt id and mutate that row, appending an event labelled with B. Reproduced: `apply` returned `APPLIED` and moved another tenant's attempt. Tenancy now sits inside the compare-and-set itself |
> | The observation validator checks the evidence | It trusted the TypeScript union at runtime. `retryable: "false"` is truthy, so it recorded `FAILED_RETRYABLE` and **restored the customer's reserved unit** on the strength of a string saying the opposite; a non-string `providerPredictionId` threw out of the validator instead of refusing; and every discriminant other than `ACCEPTED` was treated as a rejection |
>
> Both defects were also present in **merged Phase 2G-1**, identically, and are
> fixed here as well — the tenancy hole in
> `submission-outcome-repository.ts` was reproduced the same way and is the more
> severe of the two, since that repository is already reachable on `main`.
>
> The lesson both share: **a type is a promise about a value you constructed,
> and neither of these boundaries constructs its own input.**

> **Revision 3 — remaining CTO review corrections.** Revision 2
> (`99fe6f4ef5a347ada850e9abda16da4bd9e86e39`) fixed those two and was not yet
> approved. Four more blocking defects are corrected here:
>
> | Superseded claim | Correction |
> | --- | --- |
> | Reservation resolution depends only on the reservation's current state | `GenerationReservation` is **Job-scoped**. Several attempts in one Job can be durably unknown behind one suspended hold, and restoring on the first conclusion lifted a Job-level suspension while the Job was still uncertain. Restoring now requires the conclusion to leave **no other** `RECONCILIATION_PENDING + SUBMISSION_UNKNOWN` attempt in the same Job |
> | Any already-resolved attempt with matching provider reality is a replay | A direct Phase 2G-1 outcome lands on the same certainty with the same reference and *no reconciliation history*. Calling that `REPLAYED` reports success for an operation that never ran. A replay now requires all three reconciliation timestamps; partial history fails closed as `RECONCILIATION_HISTORY_INCOHERENT` |
> | Every timestamp comes from the single post-lock clock read | The reservation's `releasedAt` did not — the repository called `new Date()`, stamping a customer's release with an instant no lock was held for. The decision now carries `decisionAt` and drives every timestamp from it |
> | One caller-supplied `cutoff` narrows both maintenance queries | They ask different questions of different columns, so one timestamp had to mean two things — and the stale one was wrong by a whole threshold. The runner now owns discovery time and derives both cutoffs from a validated policy; the batch bound is validated at both boundaries and capped at 100 |
>
> Also corrected: the documented claim that a newly uncertain stale attempt always
> has a future deadline. It does not — Phase 2G-1 freezes the deadline from the
> submission boundary, so an attempt discovered late enters `SUBMISSION_UNKNOWN`
> already past it and is legitimately exhausted in the same batch.

Phase 4C-3B-2G-1 gave the platform a way to say "we do not know whether the
provider took this work" and stopped there. An attempt landed in
`RECONCILIATION_PENDING + SUBMISSION_UNKNOWN`, its customer's unit was suspended
in `RECONCILIATION_HOLD`, and a deadline was frozen from the submission boundary
— and nothing knew how any of that ended. Left alone it never would: the
entitlement stays hostage indefinitely and the uncertain charge sits in every
exposure calculation forever.

This phase supplies exactly the exit, and nothing more.

**No provider is contacted anywhere in this phase.** There is no HTTP client, no
polling, no webhook ingestion, no adapter, and no way to add a transport without
editing the port module. The evidence arrives as an argument. Whatever future
layer polls, receives a webhook, or takes an operator's determination normalizes
its findings before reaching this code — and that layer does not exist yet, which
is the correct order: the shape of the record is the constraint its producers
must satisfy, not the other way round.

## The lifecycle this phase closes

```text
        Phase 2F-1              Phase 2G-1                  Phase 2G-2
                                                    ┌──► PROCESSING
                                                    │    + ACCEPTED
 QUEUED ─────────► SUBMITTING ─────► RECONCILIATION ─┼──► FAILED_RETRYABLE
                                     _PENDING       │    FAILED_TERMINAL
                                     + SUBMISSION_   │    + DEFINITIVELY_REJECTED
                                       UNKNOWN      │
                                                    └──► RECONCILIATION_EXHAUSTED
                                                         + SUBMISSION_UNKNOWN
```

Three conclusions, and there is deliberately no fourth. In particular there is no
"still unknown" write: the row already says that, with a deadline, and
re-recording it would be a mutation that changes nothing while claiming progress
was made. A lookup that still cannot decide simply does not call the service.

## Sequence: resolving one uncertain attempt

```mermaid
sequenceDiagram
    participant C as Caller (future polling layer)
    participant S as ReconciliationService
    participant R as ReconciliationRepository
    participant PG as PostgreSQL

    C->>S: resolveReconciliation(orgId, attemptId, observation, ctx)
    S->>R: withReconcilingAttempt
    R->>PG: BEGIN
    R->>PG: pg_advisory_xact_lock(org, cycle)
    R->>PG: SELECT reservation ... FOR UPDATE OF res
    R->>PG: SELECT attempt (tenant-scoped through the chain)
    S->>S: clock.now()  ← read only now, after the locks
    S->>S: decideReconciliationResolution (pure)
    alt APPLY
        R->>PG: UPDATE attempt WHERE state+certainty+version match
        R->>PG: UPDATE reservation (only from RECONCILIATION_HOLD)
        R->>PG: INSERT attempt event + reservation event
        R->>PG: COMMIT
        S-->>C: APPLIED { stateVersion, entitlementAnomaly }
    else REPLAY / CONFLICT / DEADLINE_EXPIRED / CLOSED / NOT_RECONCILING
        R->>PG: COMMIT (nothing written)
        S-->>C: the corresponding non-mutating result
    end
```

## Entity relationships touched

```mermaid
erDiagram
    SceneGeneration ||--o{ GenerationTransitionEvent : "ATTEMPT events"
    GenerationReservation ||--o{ GenerationTransitionEvent : "RESERVATION events"
    SceneGenerationRequest ||--o{ SceneGeneration : attempts
    GenerationJob ||--|| GenerationReservation : entitlement
    GenerationScene }o--|| GenerationJob : belongs
    SceneGenerationRequest }o--|| GenerationScene : belongs

    SceneGeneration {
        enum orchestrationState "written"
        enum submissionCertainty "written"
        string providerPredictionId "written, acceptance only"
        datetime providerAcceptedAt "written, acceptance only"
        datetime reconciliationResolvedAt "written, resolution only"
        datetime submissionBoundaryEnteredAt "preserved"
        datetime reconciliationStartedAt "preserved"
        datetime reconciliationDeadlineAt "preserved"
        string normalizedErrorCode "preserved"
        int stateVersion "incremented"
    }
    GenerationReservation {
        enum state "RECONCILIATION_HOLD to RESERVED only when no unknown sibling remains; to RELEASED on terminal rejection or exhaustion"
        datetime releasedAt "set from the decision instant, never a wall clock"
    }
```

No column was added, no enum member was added, and **no migration was required**.
Both Prisma diffs report `No difference detected`.

## What was built

### Domain — `packages/domain/src/reconciliation/`

| File | Responsibility |
| --- | --- |
| `observation.ts` | The closed two-arm evidence contract and its well-formedness check |
| `entitlement.ts` | What happens to the customer's unit — including the Job-scoped `KEEP_HOLD` rule — and how anomalous bookkeeping is labelled |
| `decide.ts` | Both pure evaluators — resolution and exhaustion |
| `ports.ts` | Repository, session and clock; the two closed result unions |
| `service.ts` | Lock/clock sequencing, the five event types, safe audit metadata |
| `limits.ts` | The frozen batch maximum and the one canonical limit validator |
| `maintenance.ts` | One batch pass; owns discovery time, derives both cutoffs |

### Persistence — `packages/database/src/reconciliation-repository.ts`

One transaction, in the lock order Phase 2F-1 fixed and 2G-1 joined:

```text
organization + billing-cycle advisory lock
  → GenerationReservation row FOR UPDATE (null when absent — an anomaly, not a block)
  → authoritative attempt read, tenant-scoped through its own chain
  → count of other durably unknown attempts in the same Job
  → post-lock clock
  → pure decision
  → attempt compare-and-set on {state, certainty, version}
  → reservation mutation, only from RECONCILIATION_HOLD and only on RESTORE/RELEASE
  → append-only attempt + reservation events
  → COMMIT
```

Plus two bounded, lock-free candidate queries returning identifiers only.

### Modified, minimally

- `packages/domain/src/submission/outcome.ts` — exported
  `isStateCompatibleWithCertainty` so this phase's replay reuses Phase 2G-1's
  compatibility table rather than copying it. Two copies would drift and
  manufacture false conflicts.
- `packages/domain/src/orchestration/transition-metadata.ts` — three keys added
  to the existing allowlist: `reconciliationResolvedAt`, `retryable`,
  `diagnosticCode`.
- The two package barrels.

`classifyProviderCostExposure` and `isCoherentAttemptRecord` already covered
every pairing this phase produces and were **not modified** — verified by test
rather than assumed.

## One defect found and fixed during implementation

The first draft of `decideReconciliationResolution` treated *any* certainty other
than `SUBMISSION_UNKNOWN` as "already resolved" and sent it to the conflict
comparison. That meant an attempt still at `SUBMITTING + PRE_SUBMISSION` — one
that never became uncertain at all — was answered `CONFLICTING_RESOLUTION /
CERTAINTY_MISMATCH`.

`PRE_SUBMISSION` is the *absence* of a resolution, not a competing one. The
answer sent an operator hunting a second observer who does not exist, when the
truth was simply that the caller had named the wrong attempt. The branch is now
entered only for `ACCEPTED` and `DEFINITIVELY_REJECTED`, and such a row falls
through to `NOT_RECONCILING / ATTEMPT_NEVER_BECAME_UNCERTAIN`. Mutation M16
reintroduces the old condition and is killed.

## Verification

All commands run at the delivered head.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — all 10 projects |
| `pnpm lint` | Pass — clean |
| `pnpm test` | **2659 passed**, 95 files |
| `pnpm test:db` (live PostgreSQL) | **567 passed**, 19 files |
| `pnpm build` | Pass — Next.js production build |
| Prisma schema → database | `No difference detected` |
| Prisma migrations → schema | `No difference detected` |
| Phase 2F-1 regression suite | Pass, unchanged |
| Phase 2G-1 regression suites | Pass, unchanged |

New tests added by this phase:

| Suite | Tests | Layer |
| --- | --- | --- |
| `reconciliation/decide.test.ts` | 75 | unit |
| `reconciliation/service.test.ts` | 62 | unit |
| `reconciliation/observation.test.ts` | 65 | unit |
| `reconciliation/maintenance.test.ts` | 36 | unit |
| `reconciliation/entitlement.test.ts` | 34 | unit |
| `reconciliation/exposure.test.ts` | 10 | unit |
| `submission/observation.test.ts` (2G-1 hardening, new file) | 52 | unit |
| `submission/service.test.ts` (2G-1 hardening, added cases) | 10 | unit |
| **Unit total** | **344** | |
| `tests/integration/reconciliation.db.test.ts` | 85 | database |
| `submission-outcome.db.test.ts` (2G-1 hardening, added case) | 1 | database |
| **Database total** | **86** | |

Unit total rose to **2659** from 2315 (+344, 95 files from 88); database total
rose to **567** from 481 (+86, 19 files from 18).

- Revision 1 added 174 unit and 53 database tests.
- Revision 2 added 114 unit (the two validators' hostile-input suites) and 4
  database (three cross-tenant boundary tests, one split-ownership test).
- Revision 3 added 56 unit and 29 database — the `KEEP_HOLD` matrix, the
  reconciliation-history prerequisite, the decision-clock propagation, the
  maintenance discovery-clock and bounded-limit suites, the multi-unknown Job
  suite, the sibling concurrency race, the injected-release-time suite, and the
  same-batch stale→exhaustion regression.

No pre-existing test was modified or removed; the fixtures that changed did so
because a replay now legitimately requires reconciliation history.

## Mutation ledger

**Revision 3 total: 106 mutations, 104 killed, 2 survivors (both reported below).**

| Ledger | Mutations | Killed |
| --- | --- | --- |
| Phase mutations (Revision 1) | 54 | 54 |
| Issues 1–2 corrections (Revision 2) | 22 | 20 |
| Issues 3–6 corrections (Revision 3) | 30 | 30 |
| **Total** | **106** | **104** |

All three ledgers were re-run at the Revision 3 head. Two anchors in the original
54 (`M15`, `M16`, `M35`) were re-aimed at rewritten lines; the mutations they
express are unchanged.

### Issues 3–6 correction mutations (30 — all killed)

| ID | Mutation | Result |
| --- | --- | --- |
| S01 | other pending UNKNOWN siblings ignored during RESTORE | KILLED |
| S02 | first of two UNKNOWN siblings restores the reservation early | KILLED |
| S03 | last UNKNOWN sibling fails to restore the reservation | KILLED |
| S04 | a terminal rejection waits for siblings instead of releasing | KILLED |
| S05 | `KEEP_HOLD` emits a reservation transition event | KILLED |
| S06 | `KEEP_HOLD` moves the reservation anyway | KILLED |
| S07 | `remainingPendingUnknownAttempts` omitted from audit metadata | KILLED |
| S08 | the sibling count is dropped from the metadata allowlist | KILLED |
| S09 | the sibling count includes attempts from other Jobs | KILLED |
| S10 | the sibling count includes the attempt being resolved | KILLED |
| S11 | the sibling count includes attempts that already concluded | KILLED |
| R01 | a direct Phase 2G-1 ACCEPTED is treated as a reconciliation replay | KILLED |
| R02 | partial reconciliation metadata accepted as a replay | KILLED |
| R03 | history is not consulted at all before replaying | KILLED |
| R04 | two of three history fields counts as complete | KILLED |
| R05 | a partial history is silently repaired into an absent one | KILLED |
| C01 | the reservation release uses the process wall clock | KILLED |
| C02 | exhaustion sets a resolution instant merely to obtain a release time | KILLED |
| C03 | the decision instant drifts from the acceptance instant | KILLED |
| B01 | the stale cutoff uses `discoveryNow` rather than subtracting the threshold | KILLED |
| B02 | the due cutoff uses the stale cutoff | KILLED |
| B03 | the stale cutoff adds the threshold instead of subtracting it | KILLED |
| B04 | the runner reads its clock once per query instead of once per pass | KILLED |
| B05 | the maintenance upper bound is removed | KILLED |
| B06 | a limit of 101 is accepted | KILLED |
| B07 | a fractional limit is accepted | KILLED |
| B08 | the limit is clamped instead of refused | KILLED |
| B09 | the repository trusts the runner and skips its own validation | KILLED |
| B10 | the runner validates the limit only after querying | KILLED |
| B11 | the runner accepts a policy that never met the validator | KILLED |

### Issues 1–2 correction mutations (22 — 20 killed)

| ID | Mutation | Result | Detected by |
| --- | --- | --- | --- |
| T01 | the 2G-2 attempt CAS drops its organization predicate | KILLED | db |
| T02 | the 2G-2 CAS keeps only the denormalized project, not the chain | KILLED | db |
| T03 | the 2G-2 post-update read drops its tenant scope | **SURVIVED** | — |
| T04 | the 2G-2 reservation move drops its tenant predicate | KILLED | typecheck |
| T05 | the merged 2G-1 attempt CAS drops its organization predicate | KILLED | db |
| T06 | the merged 2G-1 post-update read drops its tenant scope | **SURVIVED** | — |
| T07 | the merged 2G-1 reservation move drops its tenant predicate | KILLED | typecheck |
| V01 | the 2G-2 validator stops checking it has an object at all | KILLED | unit |
| V02 | the 2G-2 validator accepts an unrecognised discriminant | KILLED | unit |
| V03 | the 2G-2 validator sweeps an unknown kind into the rejection branch | KILLED | unit |
| V04 | the 2G-2 validator trusts retryable for truthiness | KILLED | unit |
| V05 | the 2G-2 validator stops checking retryable is a boolean | KILLED | unit |
| V06 | the 2G-2 validator stops checking the provider reference | KILLED | unit |
| V07 | the merged 2G-1 validator accepts an unrecognised discriminant | KILLED | unit |
| V08 | the merged 2G-1 validator stops checking retryable is a boolean | KILLED | unit |
| V09 | the merged 2G-1 validator stops checking it has an object | KILLED | unit |
| V10 | the merged 2G-1 validator stops checking the provider reference | KILLED | unit |
| V11 | a blank string counts as a name | KILLED | unit |
| V12 | a non-string reaches `trim()`, throwing out of the validator | KILLED | unit |
| V13 | arrays count as plain records | KILLED | unit |
| V14 | a missing diagnostic field counts as absent | KILLED | unit |
| V15 | truthiness replaces the boolean check outright | KILLED | unit |

Three of these initially survived and exposed real gaps in the test set, which
were closed rather than argued away:

- **V03** — sweeping an unknown `kind` into the rejection branch survived because
  every hostile case in the suite lacked a valid `retryable`, so it failed either
  way. The missing case is the dangerous one: `{ kind: "UNKNOWN", retryable:
  true, diagnosticCode: null }`, a well-formed rejection body under an
  unrecognised arm — exactly what a future provider adapter emitting a new kind
  would produce, and exactly what must not be recorded as a definitive rejection.
- **V13** — the array check survived because an ordinary array has no `kind` and
  is refused by the discriminant switch anyway. Killed by an array carrying a
  valid arm's properties, which a JS producer can build and JSON cannot.
- **T02** — the ownership-chain clause survived because in all test data the
  denormalized column and the chain agree. Killed by a row where they disagree,
  which is the corruption the second clause exists for.

### The two survivors, honestly

**T03 and T06** remove the tenant scope from the post-update read that fetches
the committed `stateVersion`. Both survive, and no test can kill them: that read
is only reached after a *tenant-scoped* compare-and-set returned a non-zero
count, which already proves the row is this organization's. The scope is
unreachable-redundant today and is kept because it stays correct if the CAS above
it is ever changed — the same defence-in-depth argument recorded for M40/M45/M51
below, with the difference that here there is no separate boundary to test it
through. Recorded rather than deleted or quietly omitted.

### Original phase mutations (54 — all killed)

54 mutations, each removing exactly one rule from an artefact that executes.
Detection order: reconciliation unit suites → the live-PostgreSQL suite →
`tsc` on `packages/domain` and `packages/database`. Every mutation is restored
byte-identically and the restore is asserted.

**54 of 54 killed. No survivors.** (Re-run at the Revision 2 head; M24 and
M25 were re-aimed at the rewritten validator lines.)

| ID | Mutation | Result | Detected by |
| --- | --- | --- | --- |
| M01 | the deadline becomes strict, so the exact instant may still resolve | KILLED | unit |
| M02 | exhaustion becomes strict, so the exact instant is not yet due | KILLED | unit |
| M03 | the deadline stops being enforced at all | KILLED | unit |
| M04 | the window is recomputed from the start instead of read from the row | KILLED | unit |
| M05 | exhaustion may run before its window closes | KILLED | unit |
| M06 | exhaustion stamps a resolution instant it never earned | KILLED | unit |
| M07 | exhaustion claims certainty it does not have | KILLED | unit |
| M08 | exhaustion invents a provider reference | KILLED | unit |
| M09 | an exhausted attempt can be reopened by late evidence | KILLED | unit |
| M10 | a second exhaustion applies again instead of reporting the first | KILLED | unit |
| M11 | replay compares the landing state instead of certainty compatibility | KILLED | unit |
| M12 | a different provider reference stops being a conflict | KILLED | unit |
| M13 | retryable-vs-terminal disagreement stops being a conflict | KILLED | unit |
| M14 | a certainty mismatch stops being a conflict | KILLED | unit |
| M15 | the deadline is consulted before replay, so a duplicate looks like a failure | KILLED | unit |
| M16 | PRE_SUBMISSION is treated as a competing resolution again | KILLED | unit |
| M17 | a row with no deadline gets one invented rather than failing closed | KILLED | unit |
| M18 | a row already carrying a provider reference is resolved on top of | KILLED | unit |
| M19 | an attempt that never became uncertain is resolved anyway | KILLED | unit |
| M20 | acceptance and resolution instants stop being the same instant | KILLED | unit |
| M21 | a rejection lands in one terminal state regardless of retryability | KILLED | unit |
| M22 | a rejection carries a provider reference it never received | KILLED | typecheck |
| M23 | an acceptance lands somewhere other than PROCESSING | KILLED | unit |
| M24 | a blank provider reference is accepted | KILLED | unit |
| M25 | an arbitrary diagnostic string is accepted | KILLED | unit |
| M26 | a malformed observation is checked after the row is inspected | KILLED | unit |
| M27 | a retryable rejection releases the unit instead of restoring it | KILLED | unit |
| M28 | exhaustion keeps the customer's hold instead of releasing it | KILLED | unit |
| M29 | a spent regeneration unit is moved as if it were a suspended hold | KILLED | unit |
| M30 | a spent INITIAL unit stops being an anomaly | KILLED | unit |
| M31 | a missing reservation stops being recorded | KILLED | unit |
| M32 | a RESERVED hold under reconciliation stops being flagged | KILLED | unit |
| M33 | the clock is read before the lock is taken | KILLED | unit |
| M34 | the caller's event label is trusted instead of the service's | KILLED | unit |
| M35 | the reservation event reuses the restore label for a release | KILLED | unit |
| M36 | acceptance and rejection share one attempt event label | KILLED | unit |
| M37 | the entitlement anomaly stops reaching the durable record | KILLED | unit |
| M38 | the exhaustion event claims a resolution instant | KILLED | unit |
| M39 | a lost compare-and-set is reported as applied | KILLED | unit |
| M40 | the CAS drops the state predicate and keeps only the version | KILLED | db |
| M41 | the CAS drops the version predicate | KILLED | typecheck |
| M42 | the write also rewrites the uncertainty history | KILLED | db |
| M43 | the cost-admission advisory lock is not taken | KILLED | typecheck |
| M44 | the reservation row is not locked for the transaction | KILLED | db |
| M45 | a terminal reservation is moved anyway | KILLED | db |
| M46 | the tenant scope is dropped from the attempt read | KILLED | db |
| M47 | candidate discovery loses its deterministic tiebreak | KILLED | db |
| M48 | candidate discovery stops honouring its bound | KILLED | db |
| M49 | candidate discovery returns attempts that already concluded | KILLED | db |
| M50 | candidate discovery includes windows that have not closed | KILLED | db |
| M51 | the incoherent-write guard is removed | KILLED | db |
| M52 | the batch exhausts before it sweeps, so fresh uncertainty can be closed at once | KILLED | unit |
| M53 | a declined candidate is counted as a success | KILLED | unit |
| M54 | the sweep invents a diagnostic nobody observed | KILLED | unit |

### Three mutations survived the first run, and what that exposed

M40, M45 and M51 all survived the initial ledger with **zero** failing tests.
All three are guards in the persistence layer, and the reason none of them fired
is the same: `apply` receives a `ReconciliationWrite` from its caller, and today
the only caller is the service, which builds that write from the same facts the
repository read under the same lock. Through that path the guards are
unreachable by construction:

- **M40** — the state predicate in the compare-and-set is redundant *given* that
  every writer in the codebase bumps `stateVersion`.
- **M45** — the repository's "only move a `RECONCILIATION_HOLD`" check duplicates
  a decision the domain already made from the same reservation state.
- **M51** — the coherence check duplicates an invariant the pure evaluator
  cannot violate.

The honest reading is not that the guards are dead code. It is that they are the
contract for the *next* caller, and the ledger had been driving only the current
one. Four tests were added that call `ReconciliationSession.apply` directly with
a hand-built write — the boundary those guards actually defend:

- a write whose state and certainty cannot both be true is refused before it can
  surface as an opaque database CHECK violation in production;
- a fabricated provider reference on a rejection is refused;
- a write asking to restore a spent unit does not move it, and appends no
  reservation event claiming it did;
- a write onto a row an operator moved out of band — state changed, version
  untouched — is refused as `LOST`, which is precisely the case the version
  predicate alone cannot catch.

All three mutations are killed by those tests. The point is recorded rather than
smoothed over: a mutation ledger that only exercises the current caller will
report defence-in-depth as dead code, and the fix is to test the boundary, not to
delete the guard.

## Revision 2 — the two corrected defects in detail

### 1. Tenancy was enforced at the read, not at the write

`ReconciliationSession.apply()` compare-and-set filtered on attempt id, state,
certainty and version. The organization was checked only by `loadFacts()` — and
`apply` never required `loadFacts` to have been called.

Reproduced against the rejected head: a session opened as organization B, naming
organization A's attempt id, with the version read out of band and no call to
`loadFacts`, returned `APPLIED`. It mutated another tenant's attempt and appended
a transition event attributed to B.

The fix puts tenancy inside the compare-and-set, in the same statement, which
also closes the check-then-act window between the read and the write. Two clauses
must both hold:

```ts
const attemptScope = (organizationId: string) => ({
  videoProject: { organizationId },                       // the denormalized column
  generationSceneRequest: {                               // the ownership chain
    generationScene: { generationJob: { videoProject: { organizationId } } },
  },
});
```

The first is what the standard orchestration attempt repository scopes on; the
second is the chain every read in this file traverses. Requiring both means a row
whose denormalized project disagrees with its chain — a bad backfill, a partial
restore, a manual edit — is frozen rather than writable by whichever tenant the
corruption happens to favour. The reservation mutation and the post-update read
carry the same scope.

**The identical hole exists in merged Phase 2G-1** and is fixed here too. Its
`submission-outcome-repository.ts` had the same unscoped CAS, unscoped
reservation move and unscoped final read, reachable the same way and reproduced
the same way. It is the more severe of the two, because that code is already on
`main`.

### 2. The validators trusted a type at a boundary that constructs nothing

`isWellFormedResolutionObservation` took a typed union and behaved as though the
type were a runtime fact. It is not: the producers that will call it — a polling
loop, a webhook handler, an operator tool — hand over decoded JSON or a queue
payload, and a type assertion on the way in proves nothing.

Three concrete failures, all reproduced:

| Input | Old behaviour |
| --- | --- |
| `{ kind: "DEFINITIVELY_REJECTED", retryable: "false", diagnosticCode: null }` | Passed validation. `"false"` is truthy, so it recorded `FAILED_RETRYABLE` **and restored the customer's reserved unit** — the opposite of what the value said |
| `{ kind: "ACCEPTED", providerPredictionId: 123 }` | Threw a `TypeError` out of `trim()`, so a validator answered with an exception instead of a refusal |
| `{ kind: "ANYTHING_ELSE", ... }` | Every discriminant other than `ACCEPTED` fell into the rejection branch, so an unrecognised arm could be recorded as a definitive rejection of a paid submission |

Both validators now take `unknown`, prove they have a non-array object, match the
discriminant exhaustively by name, and check every required field's type.
`isBoolean` rather than truthiness; catalog membership rather than a shape test;
`undefined` is not `null`, because a field a sender omitted has not been stated
to be absent. Unrecognised discriminants return `false` rather than being swept
into any arm. Nothing throws — malformed evidence is an answer
(`OBSERVATION_MALFORMED`, with nothing written), not an exception for a caller
to wrap.

The shared predicates live in `packages/domain/src/submission/untrusted.ts` and
are used by both phases: two definitions of "a valid diagnostic field" would
drift.

## Revision 3 — the four corrected defects in detail

### 3. A Job-scoped hold was restored by the first of several unknown attempts

`GenerationReservation` belongs to a `GenerationJob`; an attempt belongs to a
scene. A Job with several scenes can therefore have several attempts durably
unknown behind one suspended hold. The first revision keyed the reservation action
on the reservation's own state alone, so the first conclusion to arrive restored
it — lifting a Job-level suspension while the Job was still uncertain, with the
customer's unit reading as usable while money may still have been spent on a
sibling nobody could account for.

The decision now takes one more persisted fact:
`otherPendingUnknownAttemptsInJob`, counted **inside the transaction, after the
organization+cycle advisory lock**, through the `Attempt → Request → Scene → Job`
chain. Never caller-supplied — a caller able to assert "no siblings" could
unsuspend a unit while spending was still in flight.

```text
accepted / retryable rejection + no unknown siblings → RESTORE
accepted / retryable rejection + unknown siblings    → KEEP_HOLD
terminal rejection / exhaustion                      → RELEASE   (siblings ignored)
not a suspended hold                                 → NONE
```

`KEEP_HOLD` is a fourth action rather than a reuse of `NONE`, because it is a
decision rather than the absence of one: this conclusion *would* have restored the
hold and deliberately did not. It writes nothing — no state change, no version
bump, and **no reservation transition event**, since nothing transitioned. The
reason is recorded on the attempt's own event as
`remainingPendingUnknownAttempts`, a plain count rather than sibling identifiers.

The releasing conclusions ignore siblings deliberately: releasing is how a
customer stops being charged for a question nobody could answer. The asymmetry is
one-way and therefore safe — `RELEASED` is terminal, so a sibling's later
conclusion cannot resurrect it, and a live test asserts exactly that.

The existing lock makes the count authoritative. Two sibling conclusions contend
on the same organization+cycle advisory lock, so whichever commits first is either
already visible to the other or still waiting and still counted. **No second lock
namespace was introduced.**

### 4. `REPLAYED` did not prove a reconciliation had happened

Phase 2G-1 can land an attempt on `PROCESSING + ACCEPTED` directly from a provider
response observed at the submission boundary: same certainty, same provider
reference, all three reconciliation timestamps null. Comparing provider reality
alone called that a replay of a reconciliation that never occurred — reporting
success for an operation never performed, and masking a caller routing attempts to
the wrong service.

An already-resolved attempt is now classified by its history first:

| History | Result |
| --- | --- |
| started, deadline and resolved all set | provider-reality replay rules apply |
| all three null | `NOT_RECONCILING / ATTEMPT_NEVER_BECAME_UNCERTAIN` |
| anything in between | `NOT_RECONCILING / RECONCILIATION_HISTORY_INCOHERENT` |

Partial history fails closed with a distinct reason and the missing timestamps are
**not repaired**. Fabricating a start or resolution instant is precisely the
invention this phase refuses everywhere else.

True advanced replay is preserved: a genuinely reconciled acceptance still replays
at `PROCESSING`, `PROVIDER_SUCCEEDED`, `OUTPUT_INGESTING` and `OUTPUT_VERIFIED`,
after the deadline, with no rollback, no timestamp rewrite and no new event. A
different provider reference is still a conflict, and so is a retryable-versus-
terminal disagreement.

### 5. The reservation's release time came from the process wall clock

The repository called `new Date()` for `releasedAt`. That stamps a customer's
release with an instant no lock was held for, and lets it drift from the
`reconciliationResolvedAt` the same decision wrote.

The write now carries `decisionAt` — the single post-lock clock read — and every
timestamp the decision produces comes from it:

```text
conclusive resolution → reconciliationResolvedAt = decisionAt
accepted resolution   → providerAcceptedAt      = decisionAt
reservation release   → releasedAt              = decisionAt
exhaustion            → reconciliationResolvedAt stays null; decisionAt still exists
```

Exhaustion carries it precisely because it resolves nothing: the release needs a
time, and obtaining one is not a reason to claim a certainty that was never
regained. The repository now contains no unparameterized wall-clock read at all —
`new Date(write.decisionAt)` is the only permitted form — and both a behavioural
test (the injected instant is a fixture date, provably outside the window a
`new Date()` would have produced) and a static source guard enforce it.

### 6. Maintenance cutoff semantics and an unbounded batch contract

One caller-supplied `cutoff` was passed to both discovery queries, which ask
different questions of different columns. Every caller had to encode two meanings
in one timestamp, and the stale one was wrong by a whole threshold.

The runner now reads its clock **once per pass** and derives both:

```text
discoveryNow = clock.now()
dueCutoff    = discoveryNow                                  reconciliationDeadlineAt <= dueCutoff
staleCutoff  = discoveryNow - policy.staleSubmittingAfterMs  submissionBoundaryEnteredAt <= staleCutoff
```

The threshold comes from an opaque validated `ReconciliationPolicy`, checked for
provenance exactly as Phase 2G-1's service checks it, and no production default is
invented. `cutoff` is gone from `MaintenanceBatchInput`; the caller supplies only
`limit` and `context`. The discovery instant is advisory — each single-attempt
service still reads its own post-lock clock.

`MAX_RECONCILIATION_MAINTENANCE_BATCH_SIZE` is frozen at 100, and one canonical
validator guards both the runner and the two public repository methods, because a
direct caller must not be able to put `Infinity`, a fraction or 5000 into a SQL
`LIMIT`. Invalid values are **refused, never clamped**.

**The same-batch claim is corrected.** The earlier documentation asserted that a
newly uncertain stale attempt necessarily has a future deadline. It does not: the
deadline is frozen at `submissionBoundaryEnteredAt + reconciliationWindow`, so an
attempt discovered long after abandonment enters `SUBMISSION_UNKNOWN` already past
it, is found by the due query in the same pass, and is legitimately exhausted
there. That is not special-cased away — deferring it would extend a window that is
already over. A live-PostgreSQL test drives exactly that path end to end.

## Concurrency, proved against live PostgreSQL

| Race | Assertion |
| --- | --- |
| Two identical resolutions | Exactly one `APPLIED`, one `REPLAYED`; one attempt event, one reservation event |
| Resolution versus exhaustion | Exactly one lands; the row is never mixed — a resolved attempt never has a released hold, an exhausted one never has a reference |
| **Post-lock deadline race** | A resolver starts while the window is open, queues behind a Phase 2F-1 cost admission holding the same locks, and gets in after the window closed → `DEADLINE_EXPIRED`, zero mutation, hold untouched |
| Cross-phase serialization | A conclusion blocks behind a 2F-1 cost admission and lands afterwards |
| Reservation writer contention | A conclusion blocks behind a reservation writer, then records provider reality without resurrecting the terminal hold |
| Candidate discovery under load | Discovery takes no lock and returns while a conclusion holds one |
| **Two siblings in one Job resolving at once** | Both apply; the Job-scoped hold is restored exactly once, `stateVersion` increments once, one `RECONCILIATION_HOLD_RESTORED` event, no rejected promises — and the two attempt events record remaining counts of 1 and 0 |
| Same-batch stale → exhaustion | One `runOnce` makes an abandoned attempt uncertain and, its frozen deadline having already elapsed, exhausts it — ending `RECONCILIATION_EXHAUSTED + SUBMISSION_UNKNOWN` with `releasedAt` equal to the decision instant |

The post-lock deadline race is the one that justifies the whole time-authority
discipline. The clock read returns `INSIDE` before the resolver queues and
`AFTER` once it is in; the test asserts the resolver saw `INSIDE` beforehand and
still answered `DEADLINE_EXPIRED`, which is only possible if the judgement used
the post-lock read.

## Known limitations

1. **The service has no producer.** Nothing yet supplies a
   `ReconciliationResolutionObservation`. Both entry points are dormant domain
   services with no route, no worker loop and no scheduled caller. This is
   intentional and is the order the brief specifies.
2. **The batch runner is not scheduled.** `runOnce` exists; nothing calls it on a
   timer. Wiring it to a scheduler is a later decision with its own operational
   requirements.
3. **No stale-`SUBMITTING` threshold is shipped.** Phase 2G-1 deliberately
   removed the invented default and this phase does not reintroduce one; the
   discovery query consumes a caller-supplied cutoff. It remains a
   production-activation decision in `docs/decisions/TODO.md`.
4. **Cost exposure for an exhausted attempt stays `UNCERTAIN` forever.** There is
   no path that ever converts it, because none can honestly exist without
   provider-side actual-cost ingestion. A future accounting pass over the audit
   record is the right owner; this phase does not guess.
5. **`SYSTEM_RECOVERY` admission is not wired.** A retryable rejection restores
   the unit so a recovery attempt *can* stand on it; creating that attempt is not
   this phase's job and is not done automatically anywhere.

## Remaining work before this lifecycle is usable

- Provider polling / webhook ingestion that produces the evidence (later phase).
- A scheduler or worker loop that calls `runOnce`.
- `SYSTEM_RECOVERY` attempt admission after a retryable rejection.
- A production stale-`SUBMITTING` threshold, decided rather than invented.
- Actual-cost ingestion, which is what would let `UNCERTAIN` ever resolve.

## Explicitly not done

No paid provider activation. `FAL_KEY` is not enabled, the fal production factory
is not wired, the Veo production route is not opened, and the WaveSpeed paid
route stays closed. No Stripe, no charging, no output ingestion, no composition,
no upscale. No provider network call of any kind exists in this phase's
dependency graph, and a test enumerates the module's sources to keep it that way.
