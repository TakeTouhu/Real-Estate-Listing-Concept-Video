# ADR-0018: Immutable generation request snapshot

Status: Accepted (Phase 4B-1c)
Date: 2026-08-15

Amends ADR-0016 §3 and ADR-0017 §10.

## Context

Phase 4B-1b shipped `GenerationService.startScene`, which admits one storyboard
scene for generation and enqueues `{ generationId }`. Pre-merge review of PR #32
raised a finding that turned out to be correct and to expose a gap in a contract
merged two phases earlier:

> A worker receiving only a generation id cannot execute the admitted request.

Tracing the actual data confirmed it. `ProviderGenerationInput` requires
`prompt`, `negativePrompt`, `durationSeconds`, `aspectRatio`, `resolution`,
`cameraMotion`, `modelId`, `sourceImageUrl` and `requestHash`. Of those:

- `compiledPrompt`, `durationSeconds` and `cameraMotion` existed **only** on
  `StoryboardScene`, and `replaceForProject` deletes every scene of a project on
  each recomposition;
- `aspectRatio` and `resolution` existed only on `VideoProject`, whose
  `VideoProjectUpdate` can change both **after** admission;
- `sourceStoryboardSceneId` is provenance with no foreign key and, by ADR-0016
  §3, "not dereferenced, not joined, and not required to exist".

ADR-0016 §3 reasoned that `requestHash` "already fixes everything that decides
what would be generated" and concluded a scene snapshot was unnecessary. That is
true of *identity* and false of *reconstruction*: SHA-256 is one-way. The ADR
never analysed reconstruction, so the gap was recorded nowhere.

Two consequences, both real:

1. **Unexecutable work.** A recomposition landing between admission and
   submission strands a `QUEUED` row no worker could ever run.
2. **Wrong-request spend**, which is worse. Reading the project's *current*
   `aspectRatio`/`resolution` at execution time would submit — and pay for — a
   request the customer never approved, while the stored `requestHash` silently
   misdescribed the paid call.

## Decision

### 1. `requestHash` is identity, not reconstruction

The hash proves two requests are the same. It cannot say what either one was.
Identity and reconstruction are separate obligations and need separate storage.

### 2. An admitted generation snapshots its execution inputs

`SceneGeneration` gains five immutable fields, taken at admission:

| Field | Source at admission |
| --- | --- |
| `requestCompiledPrompt` | the admitted scene's `compiledPrompt` |
| `requestDurationSeconds` | the admitted scene's `durationSeconds` |
| `requestCameraMotion` | the admitted scene's `cameraMotion` |
| `requestAspectRatio` | the admitted project's `aspectRatio` |
| `requestResolution` | the admitted project's `resolution` |

These are exactly the `GenerationRequestFacts` the row did not already carry.
With `assetId`, `providerName` and `providerModelId`, an attempt now holds all
eight hash facts and can **recompute its own `requestHash`** — an invariant that
is asserted in tests, not merely intended:

```
computeGenerationRequestHash(generationRequestFactsFrom(g)) === g.requestHash
```

Nothing beyond that is copied. Scene position, room type, and project
presentation settings stay out, because they never reach the provider. This is a
request snapshot, not a scene snapshot.

### 3. Mutable state must not alter an admitted request

"Still queryable later" is not "safe to read later". `aspectRatio` and
`resolution` survive recomposition on `VideoProject`, yet are snapshotted anyway
**because they are editable**. An admitted request is frozen at admission; a
later edit produces a different request, with a different hash, admitted
separately or not at all.

### 4. `sourceStoryboardSceneId` remains provenance only

Unchanged from ADR-0016 §3, and now clearly sufficient: nothing dereferences it,
so recomposition deleting the scene costs nothing.

### 5. The compiled prompt is snapshotted as the opaque canonical string

Stored byte-identical to the string that was hashed — never parsed, never
re-serialized. A parse/re-encode round trip could reorder keys or change
whitespace and silently break the hash invariant.

**Provider rendering is deliberately not implemented here.** No renderer from
`CompiledPrompt` to provider prose exists anywhere in the repository today, and
writing one in a persistence milestone would put a second implementation in the
path before the first exists. Rendering belongs at the provider boundary, where
ADR-0014's structural separation of preservation rules, system negatives, and
user text must be preserved. **Exactly one such renderer may ever exist**
(recorded as a Phase 4C requirement).

No second, rendered representation is persisted, and no negative-prompt field is
duplicated onto `SceneGeneration`: the compiled prompt already contains it.

### 6. Source image: durable identity, never a URL

`assetId` remains the source-image reference. A fresh signed download URL is
derived at execution time from the asset's `storageKey`. No temporary URL, no
signed URL and no storage credential is persisted on a generation — a URL that
expires must never need to survive a worker step.

`MediaAsset` is Property-scoped and unaffected by recomposition. If an asset is
removed under retention policy the request is genuinely unexecutable; failing
closed is Phase 4C's to implement.

### 7. Legacy rows are nullable and never backfilled

All five columns are nullable **only** so rows admitted before this contract
remain representable. They are not backfilled. Copying today's storyboard or
project values into an old row would forge a request that was never admitted —
one whose facts would not even reproduce the stored hash.

A row is *conditionally* backfillable in principle: only if its storyboard scene
still exists **and** recomputing the hash reproduces the stored value would the
copy be verified reconstruction rather than fabrication. No such script is part
of this milestone.

`null` therefore means "predates the contract, cannot be reconstructed".
`generationRequestFactsFrom` **fails closed** with a neutral `INTERNAL_ERROR`
rather than falling back to current state.

`requestCameraMotion` is excluded from that completeness check: `null` there is a
legitimate request that carries no camera motion, and the hash was computed over
exactly that null.

### 8. Historical request hashes are never rewritten

The migration adds columns and nothing else. No `UPDATE`, no `INSERT`, no
`DELETE`, no index, no constraint — asserted by a test that reads the migration
file.

### 9. The hash contract itself does not change

No fact is added, removed, reordered, or versioned. The snapshot *completes* the
existing contract; it does not alter it.

## Consequences

- An admitted generation is independently executable: a worker holding only
  `{ generationId }` can rebuild the exact request, given a trusted lookup and
  durable asset resolution.
- A recomposition or project edit after admission can no longer change, break,
  or misdirect an admitted request.
- The queue payload stays `{ generationId }`. The snapshot is precisely what
  lets it stay that small.
- `SceneGenerationUpdate` cannot express any snapshot field, so the snapshot is
  immutable by type, not by convention.
- `requestCompiledPrompt` stores customer-authored text. Byte-identical copies
  already exist in `storyboard_scenes.compiledPrompt` and `video_projects.prompt`,
  so no new class of data enters the database and no new retention surface is
  created. It must never appear in audit metadata, a queue payload, an error
  message, or a log — pinned by tests.
- Legacy rows remain visibly incomplete rather than quietly wrong.
- Phase 4C inherits explicit obligations, recorded in `docs/decisions/TODO.md`:
  a trusted system-scoped lookup, fail-closed handling of a missing snapshot,
  fail-closed handling of a deleted asset, request construction from the
  snapshot only, and exactly one prompt renderer.

## Alternatives rejected

**Snapshot rendered provider fields instead of the compiled prompt.** Would have
required building the renderer inside a persistence milestone, and would have
described the request in a representation the hash has never seen — so the
snapshot and the hash could disagree after any renderer change.

**Read current scene/project at execution time.** The failure this ADR exists to
prevent.

**Add a foreign key to `StoryboardScene`.** Rejected in ADR-0016 §2 and still
wrong: `Cascade` destroys the record of a paid call, `Restrict` blocks routine
recomposition.

**Backfill legacy rows from current state.** Fabricates history. Rejected.

**`NOT NULL` columns with defaults.** A default is a request nobody chose.
Rejected.
