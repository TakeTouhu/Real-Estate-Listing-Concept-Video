# ADR-0077 — Composition's records for the Clean Master

Status: Accepted (DS-5b-2a, 2026-10-22). Part of the AI-generated disclosure plan
the product owner approved on 2026-10-20
(`/mnt/project-files/cto/disclosure-proposal.md`).
Implements: the database half of ADR-0076 Decision 5. DS-5b-2b builds the
other half: composition profile v2, the runner making the master before the
video, and `compose` removed.
Builds on: ADR-0050 (Transactions J1 and J2), ADR-0073 (the frozen mode),
ADR-0074 (the master's record and key), ADR-0076 (its store and inspector).

## Context

ADR-0076 Decision 5 planned DS-5b-2 as one change: the claim carries what the
runner needs, Transaction J2 records the master beside the video, discovery
stops offering work no claim will take, two block codes exist for a master
that cannot be used, and the runner makes the master before the video. The
runner's rewrite and its tests are on their own near the size a milestone may
be, so DS-5b-2 is two pull requests. This one, DS-5b-2a, makes the records
ready and changes nothing composition does: the runner still runs profile v1,
which makes no master.

## Decision 1 — Two block codes, migration 31

Migration 31 adds `CLEAN_MASTER_SIZE_LIMIT_EXCEEDED` and `CLEAN_MASTER_UNUSABLE`
to the block-code enum of migration 15, and the domain's list grows with them,
in the same order:

| Code | When (from DS-5b-2b) |
| --- | --- |
| `CLEAN_MASTER_SIZE_LIMIT_EXCEEDED` | the stored master is over `MAX_CLEAN_MASTER_BYTES` (ADR-0076 Decision 1) |
| `CLEAN_MASTER_UNUSABLE` | the inspector refuses the stored master, or it is not the profile's size and frame rate (ADR-0076 Decision 3) |

- **Deterministic, so blocks and not deferrals.** The master is stored
  first-wins and never replaced, so a later attempt reads the same bytes and
  reaches the same answer, as for the four existing codes.
- **`ALTER TYPE … ADD VALUE`**, the statement Prisma itself writes for an added
  value. Migration 19 recreated its enum only because it removed a value.
  PostgreSQL does not let a value added in a transaction be used before that
  transaction commits; the migration uses neither value, so that does not
  arise. No row is touched.
- **Nothing blocks with either yet.** DS-5b-2b's runner is the first to.

## Decision 2 — The claim carries the version's mode and the master's key

`DeliverableCompositionClaim` gains two fields, on the first claim and on every
retry:

- **`disclosureMode`**, read from the deliverable version under the claim's
  lock (`FOR UPDATE OF j, v`). The version's mode, not the job's: it is what
  that version is planned and delivered under (ADR-0073), and a later
  disclosure change will plan a version with a mode of its own. It is narrowed
  by `assertRenderableDisclosureMode` (`@app/domain`) before anything is
  written: a value this build does not know is a build running behind its
  database, and refusing it with `CONFIGURATION_ERROR`, as an unrunnable
  profile is refused, is the only answer that never draws the wrong disclosure.
- **`cleanMasterStorageKey`**, built by the claim from the same two
  identifiers as the video's key. The runner builds no key.

## Decision 3 — Transaction J2 records the master in the same commit as the video

`FinalizeCompositionInput` gains `cleanMaster: { sha256, sizeBytes, verifiedAt }
| null` (`CleanMasterReceipt`), the receipt of the master the video was made
from:

- **Together or not at all.** The record is written after the work row's
  guarded move to `OUTPUT_VERIFIED` and before the job's move to
  `DELIVERABLE_VALIDATING`, in the one transaction. A record the database
  refuses rolls back the video's receipt and the job's move with it, and a
  finalize whose lease moved on writes neither. Two finalizes of one claim
  that race record one master: the second waits on the first's locks and then
  finds the job moved on.
- **Written as ADR-0074 says**, once and complete: at the key J2 rebuilds from
  the claim's identifiers (never the claim's own key, as for the video), with
  the receipt's own `verifiedAt`, the instant the master's stored bytes were
  proven (ADR-0076's store), which comes before the video is made. The
  finalize's `verifiedAt` stays the video's `outputVerifiedAt`; the two are
  different proofs and are not merged into one instant.
- **J2 records the receipt it is given.** It does not check the receipt
  against the frozen profile; the runner that made both files is what knows
  whether a master was due. Under profile v1 none is, and the runner passes
  `null`.
- **A replay compares both receipts.** The video's first, so a replay wrong in
  both is reported as `OUTPUT_RECEIPT_CONFLICT`. Then the master's: the
  recorded key, digest and size must be the replay's, and a record must exist
  exactly when the replay names a master. Any other answer is the new defect
  `CLEAN_MASTER_RECEIPT_CONFLICT`, and nothing is rewritten. Absence is a
  receipt too: the first commit wrote a record exactly when it was given one.
  The receipt's `verifiedAt` is not compared, as the video's is not: a replay
  proves the same bytes at a later instant.
- **`null` only under profile v1**, which makes no master; the runner passes
  `null`, so nothing writes a record in practice yet. DS-5b-2b's profile v2
  always has a master, makes the receipt required, and J2 then refuses `null`.
- **A recomposed version is not decided here.** ADR-0074 lets a version made
  by a later disclosure or logo change reuse an earlier version's master
  instead of encoding its own. That composition is not built; when it is, it
  decides what its own J2 records. This J2 always records the master at the
  version's own key, which is right for every composition that exists.
- **Why J2, and not when the master is stored.** ADR-0074's record is the
  master of a *composed* version, one per version whose composition encoded
  it. J2 is the transaction that already proves this worker still holds the
  lease and moves the work to `OUTPUT_VERIFIED`; recording the master when it
  is stored would need a transaction of its own and the same proof. A master
  stored by an attempt that then fails before J2 has no record, and is not
  lost: its key is the version's, and the next attempt finds it there.

## Decision 4 — Discovery offers only work the claim will take

Candidate discovery adds two conditions:

- a work row is offered only when its frozen `profileKey` is this build's
  `COMPOSITION_PROFILE_KEY` (a version with no work row yet is offered as
  before, and its first claim freezes the current profile);
- a version is offered only when its frozen `disclosureMode` is one this build
  renders, read from the same `DISCLOSURE_MODES` list the claim's
  `assertRenderableDisclosureMode` reads, bound as parameters. The composer's
  overlay choice is an exhaustive switch over that type, so a mode added to
  the list without being drawn does not build.

- **Why.** A claim refuses a row frozen under another profile
  (`assertRunnableProfile`) or a version planned under a mode it cannot draw
  (`assertRenderableDisclosureMode`), both with `CONFIGURATION_ERROR`, on every
  attempt, so a sweep that kept offering either would claim and refuse it
  forever, and enough such rows at the head of the queue would starve work
  that can run. It is the same discipline that already keeps blocked rows and
  unsupported targets out.
- **What becomes of such a row.** Nothing: a work row stays `PENDING` or
  `RUNNING`, its job `COMPOSING`, and a version not yet claimed keeps its job
  `COMPOSITION_PENDING`, until an operator decides (ADR-0052 Decision 20's
  recovery, unbuilt) or a build that carries its profile and mode runs. Under
  profile v1 and the one mode that exists, no row is either. When DS-5b-2b
  moves to profile v2, a v1 row could exist only in a development database:
  composition has never been activated. A claim called directly still
  refuses such a row.

## Decision 5 — Still dormant

Nothing in production constructs the repository or the runner, and the
dormancy tests still say so. The runner records no master and blocks with
neither new code; a test holds both. The master's table is now named only by
the composition repository.

---

## Consequences

- Once DS-5b-2b makes masters, every verified composition carries the record of
  the master its video was made from, committed with the video's receipt, and
  a replay that disagrees about either is a defect, never an overwrite.
- The claim hands the runner the mode to draw and the key to store the master
  at; the runner reads neither from anywhere else.
- A row frozen under a profile the build does not carry, or planned under a
  mode it does not draw, is never offered, so changing either cannot fill the
  queue with work every claim refuses.
- Two block codes exist that nothing yet records.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.
