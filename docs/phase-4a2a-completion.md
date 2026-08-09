# Phase 4A-2a Completion Report — Scene-generation persistence

Milestone: Phase 4A-2a (second milestone of Phase 4)
Scope: persistence only — no repository port, no adapter, no service, no queue,
no worker, no HTTP/UI, no provider call

## What this milestone is

The table behind Phase 4A-1's state model, plus the database invariants that make
it safe. The repository port, the Prisma adapter, and the neutral conflict
translation are Phase 4A-2b.

Everything here treats a generation row as a **financial** record rather than a
workflow row, because it can represent a paid external call. That single premise
produces every decision below.

## Schema

`SceneGenerationState` — exactly the eight Phase 4A-1 states, no
database-only additions:

```
QUEUED · SUBMITTING · PROCESSING · SUCCEEDED
FAILED_RETRYABLE · FAILED_TERMINAL · SUBMISSION_UNKNOWN · CANCELLED
```

`scene_generations`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `TEXT` PK | |
| `videoProjectId` | `TEXT` **FK → `video_projects(id)`, `ON DELETE RESTRICT`** | the only foreign key |
| `sourceStoryboardSceneId` | `TEXT` | provenance, **no FK** |
| `assetId` | `TEXT` | provenance, **no FK** |
| `sourceAnalysisRevision` | `INTEGER` | provenance |
| `requestHash` | `TEXT` | local idempotency identity |
| `providerName`, `providerModelId` | `TEXT` | internal |
| `state` | `SceneGenerationState` default `QUEUED` | |
| `providerPredictionId` | `TEXT?` | internal only |
| `submittedAt`, `lastPolledAt` | `TIMESTAMP(3)?` | |
| `normalizedErrorCode`, `normalizedErrorMessage` | `TEXT?` | internal diagnostics |
| `outputStorageKey` | `TEXT?` | null until Phase 4D |
| `createdAt`, `updatedAt` | `TIMESTAMP(3)` | database-managed |

Indexes: `(videoProjectId)`, `(state)`, and the partial unique index below.

**No `organizationId` column.** Tenant scope resolves through
`videoProject: { organizationId }`, the model `storyboard_scenes` already uses. A
live test asserts the column's absence rather than trusting the schema file.

**No retry counter and no temporary provider URL.** No worker exists yet to have
a retry policy, and Phase 4D copies a completed output into managed storage
rather than depending on a link that expires. A live test asserts no column name
contains `url`.

## Foreign-key decisions

**`videoProjectId` → `ON DELETE RESTRICT`.** Every other child in this schema
cascades; this one deliberately does not. A future physical deletion must resolve
retention policy for paid-attempt history *deliberately* rather than discovering
that a cascade erased it. It is fail-closed and changes **no current behaviour**:
`PropertyService.remove` is a **soft** delete (`status = 'DELETED'`, assets to
`DELETION_PENDING`), and nothing in the repository calls `prisma.property.delete`
or `prisma.videoProject.delete`. Recorded as a TODO that must be settled before
Phase 7 or any project-delete feature — and explicitly **not** by switching to
`CASCADE`.

**`sourceStoryboardSceneId` → no FK.** `StoryboardService.compose` writes through
`replaceForProject`, which deletes every scene row for a project and re-inserts
with freshly generated ids. Recomposition is routine. A cascade would destroy the
record of a paid call on an ordinary user action; a restrict would block
recomposition entirely. Referential integrity is the wrong tool for a row the
system deliberately deletes.

**`assetId` → no FK**, for the same reason one step later: the retention pipeline
removes media assets, and generation history may still need to explain what was
generated from what.

Evidence for both: a live test inserts a generation referencing
`scn_never_existed` and another referencing `ast_never_existed`, both succeed,
and an `information_schema` query confirms the table declares exactly one foreign
key — `videoProjectId`.

## The active-request partial unique index

```sql
CREATE UNIQUE INDEX "scene_generations_active_request_key"
  ON "scene_generations" ("videoProjectId", "requestHash")
  WHERE "state" IN ('QUEUED', 'SUBMITTING', 'PROCESSING', 'FAILED_RETRYABLE', 'SUBMISSION_UNKNOWN');
```

Created **in the same migration as the table**, so there is no window in which
duplicate active attempts are possible. Hand-written because Prisma cannot
express `WHERE` on an index — the Phase 3B-1a pattern.

Confirmed present in `psql \d scene_generations`:

```
"scene_generations_active_request_key" UNIQUE, btree ("videoProjectId", "requestHash")
  WHERE state = ANY (ARRAY['QUEUED'::"SceneGenerationState", 'SUBMITTING'::…,
  'PROCESSING'::…, 'FAILED_RETRYABLE'::…, 'SUBMISSION_UNKNOWN'::…])
```

### Active-state uniqueness matrix

Parameterized over `ACTIVE_SCENE_GENERATION_STATES` — a second insert with the
same `(videoProjectId, requestHash)` is refused with `P2002`, and exactly one row
survives:

| Holder state | Duplicate refused | Rows after |
| --- | --- | --- |
| `QUEUED` | ✅ | 1 |
| `SUBMITTING` | ✅ | 1 |
| `PROCESSING` | ✅ | 1 |
| `FAILED_RETRYABLE` | ✅ | 1 |
| `SUBMISSION_UNKNOWN` | ✅ | 1 |

### Terminal-release matrix

Parameterized over `TERMINAL_SCENE_GENERATION_STATES` — a finished attempt
releases the identity so a deliberate regeneration can proceed:

| Finished state | New active row accepted | Rows after |
| --- | --- | --- |
| `SUCCEEDED` | ✅ | 2 |
| `FAILED_TERMINAL` | ✅ | 2 |
| `CANCELLED` | ✅ | 2 |

Also proven: an active row *transitioned* to `FAILED_TERMINAL` releases the
identity; the same hash under a different project does not collide; different
hashes under one project do not collide; the same hash under a different tenant
does not collide.

## SQL ↔ domain agreement

`tests/schema/active-generation-states.test.ts` reads the real migration file,
parses the state literals out of the `WHERE … IN (…)` clause anchored on the
index name, and compares them as a set with `ACTIVE_SCENE_GENERATION_STATES`.
Neither side is derived from the other, so it is not tautological, and a parser
sanity check guards against a silently empty match making the comparison vacuous.

9 tests: exact set match, no unknown states, every terminal state excluded,
`FAILED_RETRYABLE` and `SUBMISSION_UNKNOWN` named explicitly, the indexed
identity, index-after-table ordering, `RESTRICT` present and `CASCADE` absent, and
no FK on either provenance column.

Adding or removing a domain active state now fails this test until the SQL is
updated deliberately.

## Concurrency

Two `create` promises for the same active identity are started **before either is
awaited** — a serial duplicate would prove nothing about a race — and settled
with `Promise.allSettled`:

- exactly **1** fulfilled
- exactly **1** rejected, with code `P2002` (the uniqueness invariant, not
  something incidental)
- the database holds exactly **1** row for that identity, in an active state

## Recompose survival — the headline test

Using the **real** `createPrismaStoryboardRepositories(...).scenes.replaceForProject`,
not a simulated delete:

1. compose scene `scn_original`
2. create a generation carrying it as provenance, state `PROCESSING`
3. recompose to `scn_recomposed`

Result: `scn_original` count `0`, `scn_recomposed` count `1`, and the generation
still exists with `sourceStoryboardSceneId = "scn_original"` unchanged, state
`PROCESSING` unchanged, `videoProjectId` intact, and `videoProject.organizationId`
still `ORG_A`.

## Tenant isolation

Scoped through the project relation. A generation read with the owning
organization is found; the same id read with another organization returns `null`
— **the same answer** as an id that does not exist, so nothing in the result can
reveal that the row exists under another tenant. An insert against a nonexistent
project is refused with `P2003`.

## Real Prisma error shapes, captured for Phase 4A-2b

Not translated here — that is 4A-2b. Captured against **live PostgreSQL** so
4A-2b matches reality rather than memory, per the lesson recorded in
`analysis-repositories.ts:14-22` (*"an earlier version of this function matched
the index name and silently never fired"*).

**Active-identity collision:**

| Field | Value |
| --- | --- |
| class | `PrismaClientKnownRequestError` |
| `code` | `P2002` |
| `meta` | `{"modelName":"SceneGeneration","target":["videoProjectId","requestHash"]}` |
| message | ``Unique constraint failed on the fields: (`videoProjectId`,`requestHash`)`` |

**The hand-written index name does not appear anywhere in the error.** Prisma
reports the *covered fields*, exactly as it does for the Phase 3B-1a index — so
4A-2b must match on `target` containing both fields, never on
`scene_generations_active_request_key`. A test pins this.

**`RESTRICT` violation** (for completeness, no translation planned yet):

| Field | Value |
| --- | --- |
| `code` | `P2003` |
| `meta` | `{"modelName":"VideoProject","field_name":"scene_generations_videoProjectId_fkey (index)"}` |

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | clean |
| `pnpm test` | **806 / 806**, 48 files (797 → +9 schema-guard tests) |
| `pnpm build` | clean production build |
| `pnpm test:db` | **53 / 53**, 5 files (27 → +26 new) |
| migrations from an empty database | all **7** applied in order on a dropped-and-recreated database |
| Prisma drift check | `No difference detected.` (exit 0) |
| partial index + `RESTRICT` FK in real PostgreSQL | both confirmed via `psql \d` |

## Size

| | Lines |
| --- | --- |
| Production (domain type, schema, migration) | see PR |
| Tests | see PR |

Re-cost before implementation was **~725 raw / ~800–900 calibrated**, reported as
*at* the boundary rather than materially above it. Actuals are in the PR
description.

## Scope boundaries

Unchanged: `apps/web`, API routes, UI, `packages/queue`, `apps/worker`,
`packages/video-providers`, `packages/storage`, and all Phase 3 analysis and
storyboard behaviour. No repository port, no Prisma generation repository, no
`ActiveGenerationConflictError`, no P2002 translation — all Phase 4A-2b.

## Documentation drift corrected in this pass

- `CHANGELOG.md` still described Phase 4A-1 as *"Under review. Not merged."* It
  merged as `daa685b`; corrected.
- `schema.prisma`'s `compositionFingerprint` comment still described the Phase 3C
  payload `(assetId, analysisRevision)`. Since Phase 3D-3 it also carries
  `effectiveRoomType` and `orderOverride` — the reviewer's corrections, which do
  not advance `analysisRevision` and would otherwise be invisible. Corrected
  while the file was legitimately open.
- `docs/er-diagram.md` listed provider prediction ids under *"Deliberately not
  stored"*. As of this milestone they **are** stored, in
  `providerPredictionId` — `PROCESSING` asserts a known prediction and polling
  needs it. They remain internal-only. Corrected, with the change called out
  rather than quietly edited.

ADR-0016 is **not** rewritten: persistence exposed no fact that changes an
accepted decision.

## Known limitations

- **Nothing reads this table yet.** The typed access path is 4A-2b.
- **`RESTRICT` will block the first real deletion path built.** That is the
  point, and the TODO says so — but it is a future obligation, not a solved
  problem.
- **No in-memory repository.** Deferred deliberately until 4B shows the port
  shape it needs; building one now would be guessing.
