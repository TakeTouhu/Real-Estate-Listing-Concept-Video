# ADR-0012: Composition input set and its fingerprint

- Status: Accepted
- Date: 2026-08-03
- Phase: 3C-2a

## Context

A storyboard is composed from analyses that a human has approved. Two questions
follow, and both need answers that survive later phases:

1. **Which analyses may compose?** Approval is per analysis *revision*, and a
   refresh clears the review state and advances the revision, so eligibility is
   a moving target.
2. **How does anything know a storyboard has gone stale?** After composition,
   an approved photo can be added, removed, or re-analyzed. Phase 4 must refuse
   to generate from a storyboard whose inputs have moved on, and the review UI
   should be able to say so.

The obvious mechanism for (2) — have `AnalysisService` mark storyboards stale
when it refreshes an analysis — was rejected during planning. It would couple
two modules that otherwise know nothing about each other, require an event or
hook system, and fail silently if a future write path forgot to fire it.

## Decision

**Eligibility is `status === "SUCCEEDED" && reviewStatus === "APPROVED"`, and
nothing else.** `selectEligibleAnalyses` returns a narrow projection —
`assetId`, `analysisRevision`, `roomType`, `suggestedOrder` — sorted by
`assetId`. An `UNREVIEWED` or `REJECTED` analysis is never admitted, including
to reach a minimum scene count.

**Duplicate suppression is not re-implemented.** The partial unique index from
ADR-0011 already guarantees at most one approved analysis per duplicate group.
Selection *checks* that invariant and raises `VALIDATION_FAILED` if two approved
members of one group ever arrive, rather than choosing a winner: reaching that
state means a database guarantee has been violated, and silently picking one
would hide a real defect. Several approved analyses with no duplicate group are
ordinary and always valid.

**Staleness is derived, not pushed.** `computeCompositionFingerprint` digests the
complete eligible input set: each input becomes the tuple
`[assetId, analysisRevision]`, the tuples are sorted by `assetId`, the array is
serialized with `JSON.stringify`, and the result is hashed with SHA-256 and
returned as `sha256:<hex>`. A reader compares a stored fingerprint with a freshly
computed one.

The payload is a **canonical structure, not concatenated text**. Delimiter
joining would make `("a|b", 1)` and `("a", "b|1")` collide unless every id were
escaped by hand; JSON's own escaping makes the encoding unambiguous without
inventing an escape scheme.

The fingerprint covers **input identity only** — not scene order, not durations.
Reordering a storyboard or changing its length does not make it stale; an
approved photo appearing, disappearing, or being re-analyzed does.

## Consequences

- No cross-module hook, event bus, or notification exists.
  `packages/domain/src/analysis/` has no knowledge of storyboards, and the
  freshness answer is correct however long after the refresh it is asked.
- Staleness costs a read of the current analyses plus a hash — cheap, and always
  computed from present state rather than from a flag that could have been
  missed.
- A stored fingerprint stays comparable as long as the tuple shape holds.
  Changing what a fingerprint covers is a **breaking change**: every stored value
  becomes incomparable, so projects would read as stale until recomposed. Any
  such change needs its own ADR.
- The digest deliberately says nothing about *why* it differs. A caller learns
  that the input set moved, not which asset moved — enough for the gate, and it
  keeps the value a pure function of the set.
- Minimum scene count is **not** enforced here. Selection and fingerprinting are
  defined for 0, 1, and 2 inputs; the minimum-three rule belongs to composition
  (Phase 3C-2b), so duration and ordering logic can evolve without changing what
  "eligible" means.

## Alternatives considered

- **A `storyboardStale` boolean maintained by `AnalysisService`** — rejected:
  cross-module coupling, and a missed write path makes it silently wrong in the
  unsafe direction.
- **Storing the input list itself instead of a digest** — accurate and
  diffable, but it grows with the property and duplicates data that already
  exists in `asset_analyses`. The digest answers the only question the gate asks.
- **Hashing the whole `AssetAnalysis` rows** — would make a storyboard stale
  when an unrelated field changed, which is noise rather than safety.
