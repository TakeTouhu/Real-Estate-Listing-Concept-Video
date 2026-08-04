# ADR-0015: Human review corrections to room classification and ordering

Status: Accepted (Phase 3D-1)
Date: 2026-08-04

## Context

`docs/Roadmap.md` puts **"editable room labels and image order"** in Phase 3
scope, with the completion criterion *"users can review and correct all AI
decisions before generation."* Phase 3A–3C shipped analysis, review decisions,
and the storyboard, but a reviewer could only **approve or reject** a photo.
There was no way to correct a wrong room classification or influence the order,
so the only remedy for a misclassified but otherwise usable photo was rejecting
it — which is not a correction path, and blocks Phase 3 from being closed.

Two facts about the existing code shaped this decision.

**The analyzer's `suggestedOrder` is inert.** It is written as
`roomOrderRank(roomType)` — the room type's index in `ROOM_ORDER` — and
`orderScenes` sorts by `ROOM_RANK[roomType]` first, using `suggestedOrder` only
as a tie-break. `ROOM_ORDER` and `ROOM_RANK` are the same sequence, so two
photos with different room types always separate at the room rank and two with
the same room type always carry the same `suggestedOrder`. **The tie-break can
never change an outcome.** `suggestedOrder` therefore cannot serve as the human
override (it is a pure function of `roomType`), and a human correction needs its
own field.

**The storyboard consumes a narrow projection.** `selectEligibleAnalyses` maps
`AssetAnalysis` to `EligibleInput`, and `orderScenes`,
`computeCompositionFingerprint`, and `StoryboardService` read nothing else. That
projection is the single point at which corrected values can enter composition.

## Decision

### 1. Preserve AI output; store human corrections beside it

Four nullable columns on `asset_analyses`: `roomTypeOverride`, `orderOverride`,
`correctedBy`, `correctedAt`. The analyzer's `roomType` and `suggestedOrder` are
**never overwritten**.

`effectiveRoomType(analysis) = roomTypeOverride ?? roomType`, defined once in
`packages/domain/src/analysis/effective.ts`.

Rejected: mutating `roomType` in place. It would be two columns smaller and
worse in four ways. The model's answer becomes unrecoverable, so
"how often are we correcting the analyzer?" — a question this product needs for
provider evaluation — cannot be answered. `confidence` would describe a value
that no longer exists, while `isLowConfidence` drives the "confirm the room
before approving" caution. Refresh becomes ambiguous, because `reserve()` clears
AI fields wholesale and could not distinguish an analyzer value from a human
one. And provenance would need a history table to recover what the current row
would otherwise state directly.

There is **no** correction-history table. `correctedBy`/`correctedAt` plus the
preserved original give the current revision's provenance from the row itself,
and the audit log (Phase 3D-2) records each change.

### 2. `orderOverride` is a global sort priority, not an absolute position

Lower values appear earlier. It is **not** a guaranteed final array index, and
it is deliberately **not** a fallback for `suggestedOrder` — no
`effectiveOrder` helper exists, because there is nothing to resolve and a
wrapper would imply a derivation that does not exist. How the priority competes
with the automatic room rank is the storyboard ordering primitive's contract,
not the analysis model's.

Duplicate priorities across photos are legitimate and resolve deterministically.
No uniqueness constraint, no renumbering transaction, no gap management.

### 3. Ordering precedence (to be implemented in Phase 3D-3)

Primary key: `orderOverride ?? roomRank(effectiveRoomType)`. On equal primary
keys, an explicit human override wins over an automatic key; then the existing
deterministic baseline applies — effective room rank, `suggestedOrder`,
`assetId`.

So priority `1` can intentionally lead the walkthrough and a larger priority can
intentionally move a photo later, while one corrected photo behaves sensibly
without requiring a full batch reorder. The rejected alternative — placing every
overridden photo ahead of every automatic one — would make a priority of `8`
sort ahead of an un-corrected exterior shot, which is not intuitive.

`suggestedOrder` is **retained** despite being inert: it is persisted analyzer
output, it costs nothing, and removing it is not this phase's business.

### 4. Correction lifecycle

Corrections belong to the current reviewable analysis revision.

| State | Correction |
| --- | --- |
| `SUCCEEDED` + `UNREVIEWED` | allowed, repeatable |
| `PENDING`, `FAILED` | refused — nothing to correct |
| `APPROVED`, `REJECTED` | refused — frozen with the decision |

To change a correction after a decision, refresh the analysis and start the next
review cycle. This preserves immutable-review-per-revision exactly rather than
bending it, and needs no new guard: the correction path reuses
`requireReviewable`, which already enforces this.

**Refresh clears all four correction fields** alongside the stale analysis and
review state, at reservation time. Once the analyzer has re-run, "this is a
living room, not a kitchen" describes a classification that no longer exists.
Clearing at reservation means a correction can never outlive the result it was
made about, not even on a `FAILED` row.

### 5. Composition fingerprint includes correction-sensitive values

From Phase 3D-3 the canonical payload tuple becomes:

```
[ assetId, analysisRevision, effectiveRoomType, orderOverride ]
```

with the same canonical sort, `JSON.stringify`, and SHA-256 already in use.
`analysisRevision` is **not** bumped for a human correction — it continues to
mean an analysis *result* revision, and it is the token a review decision is
immutable against.

Under the lifecycle in §4 the existing `[assetId, analysisRevision]` payload
would already be sufficient, because a correction cannot change while a photo is
in the eligible set (only `APPROVED` analyses are eligible, and their
corrections are frozen). The payload is widened anyway so that freshness is
correction-sensitive **by construction** rather than by an argument about a
lifecycle rule a future phase might relax. The failure mode it forecloses is
severe: a storyboard reading generation-ready while its ordering has changed.

**Accepted one-time consequence:** changing the payload changes every digest, so
every storyboard composed under the old format reads **stale once** after
deployment and must be recomposed. This is the fail-safe direction, requires no
data migration and no fingerprint backfill, and is documented in the release
notes.

### 6. Per-asset correction API

One per-asset correction operation (Phase 3D-2/3D-4). No batch reorder endpoint:
the product UI uses a numeric global priority, so a single-asset correction is
meaningful on its own. If a drag-and-drop editor later genuinely requires an
atomic batch reorder contract, it will be designed when that UI exists.

### 7. Authorization

Corrections require `video:review` — the same authority as approve and reject.
`CREATOR` holds `property:write` but not `video:review`, so it is excluded
automatically by the existing role map, with no special case.

## Consequences

- The analyzer's output stays recoverable, and correction rates become
  measurable without a history table.
- `effectiveRoomType` is the one resolution point; reading `analysis.roomType`
  where the corrected value is meant is now the identifiable mistake.
- The storyboard integration is confined to `selectEligibleAnalyses`'s
  projection plus `EligibleInput`; `StoryboardService` needs no correction
  logic and changes by zero lines.
- Every storyboard composed before the fingerprint change reads stale once.
- Four nullable columns, no index, no backfill, no destructive change; old code
  ignoring them keeps working.
- The migration is additive and reversible by dropping four columns.

## Implementation across milestones

| Milestone | Content |
| --- | --- |
| **3D-1** (this ADR) | schema, migration, domain type, `effectiveRoomType`, repository round-trip, refresh clearing |
| 3D-2 | `AnalysisService.correct`, lifecycle guards, authorization, one audit event |
| 3D-3 | `EligibleInput.orderOverride`, effective room in the projection, ordering precedence, fingerprint payload |
| 3D-4 | HTTP endpoint, DTO exposure, review-UI correction controls |

3D-4 must not precede 3D-3: a correction UI over composition that still ignored
corrections would let a reviewer record a fix that silently does nothing.
