# Phase 4B-1c — Immutable generation request snapshot

Merged as PR #33.
Base: `c169bd604543cc973c741f85bcec168562ec742a` (merged Phase 4B-1b, PR #32)

## Why this milestone exists

Pre-merge review of PR #32 raised a P1 finding: *"Persist provider inputs before
enqueueing."* It was correct, and it exposed a gap in a contract merged two
phases earlier rather than a defect in PR #32.

`requestHash` is a one-way SHA-256. ADR-0016 §3 concluded that because the hash
"fixes everything that decides what would be generated", minimal provenance was
sufficient. That holds for request *identity* and fails for request
*reconstruction*. Tracing the real data showed:

- `compiledPrompt`, `durationSeconds`, `cameraMotion` lived **only** on
  `StoryboardScene`, which `replaceForProject` deletes wholesale on every
  recomposition;
- `aspectRatio` and `resolution` lived on `VideoProject`, whose
  `VideoProjectUpdate` can change both **after** admission;
- `sourceStoryboardSceneId` has no FK and is, by design, "not required to exist".

Two consequences, the second worse than the first:

1. A recomposition between admission and submission stranded a `QUEUED` row that
   no worker could execute.
2. Reading the project's *current* settings at execution time would have
   submitted — and paid for — a request the customer never approved, while the
   stored `requestHash` silently misdescribed the paid call.

## What shipped

Five immutable fields on `SceneGeneration`, captured at admission:

| Field | Source | In `requestHash` |
| --- | --- | --- |
| `requestCompiledPrompt` | admitted scene's `compiledPrompt` | fact 2 |
| `requestDurationSeconds` | admitted scene's `durationSeconds` | fact 3 |
| `requestCameraMotion` | admitted scene's `cameraMotion` | fact 4 |
| `requestAspectRatio` | admitted project's `aspectRatio` | fact 5 |
| `requestResolution` | admitted project's `resolution` | fact 6 |

These are **exactly** the hash facts the row did not already carry. With
`assetId`, `providerName` and `providerModelId`, a generation now holds all eight
and can recompute its own hash:

```
computeGenerationRequestHash(generationRequestFactsFrom(g)) === g.requestHash
```

`generationRequestFactsFrom` rebuilds the request from the row alone and **fails
closed** for a legacy row whose snapshot is absent — a neutral `INTERNAL_ERROR`,
never a fallback to current state.

## Admission ordering — unchanged

```
authorize property:write → assertFresh → getStoryboard → view.fresh guard
→ resolve scene inside view.scenes → compiledPrompt non-null
→ capabilities.current() (once) → assertSettingsSupported
→ computeGenerationRequestHash
→ active lookup → succeeded lookup
→ create  ← now carries the complete immutable snapshot
→ enqueue({ generationId }) → audit generation.requested → return
```

The snapshot is taken from the **same** resolved `scene`, `project` and
`capability` that produced `requestHash`, in the same statement. Nothing is
re-read in between, so the snapshot and the hash cannot describe different
requests.

The compiled prompt is passed into the private admission step typed as `string`
rather than `string | null`, so a null prompt snapshot is a compile error rather
than a runtime possibility.

## Migration

`00000000000007_phase4b1c_request_snapshot` — five nullable columns and nothing
else. **No backfill, no `requestHash` rewrite, no deletion, no index, no
constraint.** `tests/schema/request-snapshot-columns.test.ts` reads the migration
file and asserts each of those absences, so the restraint cannot be silently
undone. Drift check against the datamodel: `No difference detected.`

Nullability is legacy compatibility only. Every newly admitted generation writes
all five except `requestCameraMotion`, where `null` is a legitimate request value.

## Reconstruction proof

`generation-reconstruction.test.ts` is the architectural test, not a
column-existence check. It admits a generation, then **recomposes the storyboard
so the scene is gone and mutates the project's aspect ratio and resolution to
different values**, then seals the storyboard reader so any read fails the test,
then reconstructs from the persisted row and asserts the recomputed hash equals
the original.

It genuinely discriminates. Verified by mutation: writing `null` for
`requestCompiledPrompt` and `requestAspectRatio` in the service made 2 of its 11
tests fail; the implementation was then restored. A companion test asserts the
post-recomposition facts hash *differently*, proving a fallback implementation
could not have passed.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm test` | **952 passed**, 53 files (+30 from this milestone) |
| `pnpm build` | clean |
| `pnpm test:db` | **123 passed**, 6 files (+5 from this milestone) |
| `prisma migrate diff --from-migrations` (CI-equivalent) | `No difference detected.` (exit 0) |

Explicitly re-verified: `computeGenerationRequestHash` unchanged; queue payload
key set is exactly `["generationId"]`; audit metadata carries no compiled prompt;
no provider call path; no worker; no production queue adapter; tenant-facing
repository API unchanged (still five organization-addressed methods);
`SceneGenerationUpdate` cannot express any snapshot field.

## Security and privacy

`requestCompiledPrompt` holds customer-authored text. Byte-identical copies
already exist in `storyboard_scenes.compiledPrompt` and `video_projects.prompt`,
so **no new class of data enters the database** and no new retention surface is
created. It is asserted absent from audit metadata, queue payloads, error
messages, and logs. No encryption or retention machinery was invented; the one
pre-existing recorded requirement in this area (`DataModel.md` stating
`predictionId` is stored encrypted) concerns provider identifiers, is
unimplemented, and is already tracked separately.

## Deliberately not done

- **No prompt renderer.** None exists anywhere in the repository; the compiled
  prompt is stored opaque so that exactly one renderer can be built later at the
  provider boundary, preserving ADR-0014's structural separation. Building one
  here would have put a second implementation in the path before the first.
- No provider call, no worker, no production queue adapter, no real WaveSpeed
  capability values, no HTTP/UI, no change to `roles.ts`.
- No system-scoped worker lookup — deliberately still Phase 4C's, and kept
  separate from this change.

## Phase 4C is now hard-blocked on this milestone

Recorded in `docs/decisions/TODO.md`:

1. Phase 4B-1c merged and verified on `main` before Phase 4C begins.
2. A trusted system-scoped lookup for `generationId`-only jobs, without
   weakening tenant-facing organization scoping.
3. Fail closed for a legacy generation missing its snapshot (Phase 4C owns the
   normalized failure state).
4. Derive a fresh signed source-image URL from durable asset identity.
5. Fail closed when the source asset is missing or deleted.
6. Construct provider requests from the snapshot only — never the current
   storyboard scene or mutable project settings.
7. Exactly one `CompiledPrompt` → provider prompt renderer.

## Known limitations

- Legacy rows (admitted before this migration) remain unexecutable by design.
  They are visibly incomplete rather than quietly wrong. A verified conditional
  backfill is possible — the hash is its own verifier — but is not part of this
  milestone.
- Stranded `QUEUED` rows from an enqueue or audit failure still await the
  Phase 4C recovery sweep; unchanged by this milestone.
- Real WaveSpeed capabilities, pricing, and the aspect-ratio product contract
  remain Phase 4B-2 work.
