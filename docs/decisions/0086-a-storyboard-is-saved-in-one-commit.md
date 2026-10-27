# ADR-0086 — A storyboard is saved in one commit

Status: Accepted (GS-4a, 2026-10-27). First of three pull requests for GS-4,
the whole-video start step, in the generation-to-preview plan the product owner
approved on 2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`,
Design 2).
Builds on: ADR-0012 (freshness is derived from a fingerprint, never flagged),
ADR-0015 (what the fingerprint covers), ADR-0016 (generation history outlives
recomposition), ADR-0064 (reach).

## Context

The start step GS-4 builds checks that the storyboard is current, then copies
its scenes into the job, in one commit. "Current" is derived (ADR-0012): the
project's `compositionFingerprint` is compared with a digest of the approved
analysis inputs read now. A match means the inputs have not moved since the
storyboard was composed, and therefore that **its scenes** are the composition
of those inputs.

That last step held only if a project's scenes and its fingerprint always came
from the same composition. They did not have to. `StoryboardService.compose`
wrote them apart, in two commits, scenes first and then the project, on the
reasoning that a failure between the two leaves a project that is not marked
ready. That is true of one composition. Two compositions of one project, racing
an analysis change, could interleave:

```text
A  reads the inputs I1 (photo X approved)        -> scenes S1, fingerprint F1
   (X's approval is withdrawn: the inputs are now I2)
B  reads I2                                       -> scenes S2, fingerprint F2
B  commits its scenes S2
A  commits its scenes S1                          (S1 replaces S2)
A  marks the project F1
B  marks the project F2
```

The project ends with S1's scenes, which include X, under F2, the fingerprint
of inputs without X. Every reader then sees a current storyboard: F2 matches the
inputs. The storyboard page shows X, and a generation started from it would
render a photo whose approval was withdrawn. Nothing afterwards could tell,
because each row looks internally consistent.

The two scene writes could also collide outright: both delete the old rows and
insert their own positions from 1, and the second insert of position 1 fails on
the unique index once the first commits, so a customer pressing compose twice
could get a server error.

## Decision 1 — The scenes, the status and the fingerprint are one commit

`StoryboardSceneRepository.replaceForProject` becomes `saveComposition(org,
project, { scenes, compositionFingerprint })`. In one transaction it replaces
the project's scenes wholesale and marks the project `STORYBOARD_READY` with
the fingerprint, and returns the project and the scenes as that commit left
them. `compose` makes this one call in place of the former two.

A project's scenes and fingerprint therefore always come from the same
composition, whichever of two racing compositions commits last. In the example
above the project ends with S1 and F1, or with S2 and F2. S1 under F1 reads as
stale against I2, so the customer composes again; it is never presented as
current.

A failure anywhere writes nothing: the previous composition, its scenes, status
and fingerprint, stays whole. Before, a failure after the scene write left the
new scenes under the old fingerprint and status.

`projects.update` is unchanged and no longer used by composition.

## Decision 2 — The project row orders compositions and the start step

The transaction's first statement locks the project row, scoped to the
organization:

```sql
SELECT "id" FROM "video_projects" WHERE "id" = $1 AND "organizationId" = $2 FOR NO KEY UPDATE
```

- **Two compositions take turns.** The second waits at the lock, then deletes
  the first's rows and inserts its own. The unique-index collision cannot
  happen.
- **The start step sees one composition whole.** GS-4b's start step will hold
  the same row `FOR SHARE` while it reads the fingerprint and the scenes, so a
  composition waits for it, and it waits for a composition already saving. It
  can never read one composition's scenes with another's fingerprint.
- **`FOR NO KEY UPDATE`, not `FOR UPDATE`.** It is the lock the project's own
  `UPDATE` takes anyway, taken earlier. Rows that only reference the project (a
  job, an attempt) check their foreign key with `FOR KEY SHARE`, which this
  lock does not block; `FOR UPDATE` would.
- **Another tenant's project** matches no row: the call throws before anything
  is written, as before.

No other writer locks `video_projects` and then waits for a lock this
transaction holds: the job creation's `FOR SHARE` (Phase 4C) is taken first in
its own transaction, and composition takes no advisory lock. So no cycle is
added.

## Not decided here

- **Analysis changes are not locked.** An approval, a correction or a re-run
  writes the analysis without touching the project, so it can commit while a
  composition or the start step is reading the inputs. Each then acts on the
  inputs it read: the composition is stale the moment the change commits, and
  shows as stale, and a start that read them first has started from the
  storyboard as it then was. This is the ordering ADR-0012 already accepts; the
  start step's own handling is GS-4b's.
- **Project settings.** No route edits a project's settings after creation
  (`docs/decisions/TODO.md`). The fingerprint covers the analysis inputs, not
  the duration, camera motion or prompt; when settings editing is built, it
  must decide whether a settings change makes the storyboard stale.

## Consequences

- One port method changes name and shape; the four in-memory test doubles and
  the two database tests that used it follow.
- The database tests prove: a failed save leaves the previous composition
  whole; a save waits for a composition already saving and then replaces it
  whole (the case that failed on the unique index before); it waits for a
  reader holding the project `FOR SHARE`; and it does not wait for one holding
  it `FOR KEY SHARE`.
- No migration, no route, no page; the storyboard screens behave as before.
