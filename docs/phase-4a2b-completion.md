# Phase 4A-2b Completion Report — Scene-generation repository boundary

Milestone: Phase 4A-2b (third milestone of Phase 4)
Scope: repository port and Prisma adapter only — no service, no queue, no
worker, no HTTP/UI, no provider call, no schema change

## What this milestone is

The typed access path to the table Phase 4A-2a created. 4A-2a proved what the
*database* guarantees; this proves what the *adapter* does with it.

Two things had to be got right, and both are about a future worker's ability to
reason:

- **only** the active-request collision becomes a conflict, while every other
  database failure propagates untouched;
- "not yours or not there" is a **typed** error, distinguishable from a driver
  failure without matching message strings.

## Repository API

```ts
export interface SceneGenerationRepository {
  create(input: NewSceneGeneration): Promise<SceneGeneration>;
  findById(organizationId, id): Promise<SceneGeneration | null>;
  findActiveByRequestIdentity(organizationId, videoProjectId, requestHash): Promise<SceneGeneration | null>;
  update(organizationId, id, changes: SceneGenerationUpdate): Promise<SceneGeneration>;
}

export type NewSceneGeneration = Omit<SceneGeneration, "createdAt" | "updatedAt">;
```

Four methods. No `delete` — generation history is retained because it can record
a paid call. No generic `save` — that would defeat the narrow update contract.
No `listByProject` — no caller needs one yet; it belongs with the Phase 4E status
surface. No worker-claim method — the worker is a later milestone and its
claiming strategy is undecided.

`organizationId` is an **addressing argument** on every operation, never payload,
so a write cannot target another tenant's row by carrying a different id in the
body.

`findActiveByRequestIdentity` is documented in the port as a **convenience
lookup, not concurrency control**: two callers can both find nothing, so
`find → if absent → create` is never a sufficient idempotency guarantee. The
partial unique index remains authoritative and `create` still handles the
collision.

## `SceneGenerationUpdate`

```ts
{
  state?, providerPredictionId?, submittedAt?, lastPolledAt?,
  normalizedErrorCode?, normalizedErrorMessage?, outputStorageKey?
}
```

Ten fields are **absent from the type**, so mutating them is a compile error
rather than a silently ignored property: `id`, `videoProjectId`,
`sourceStoryboardSceneId`, `assetId`, `sourceAnalysisRevision`, `requestHash`,
`providerName`, `providerModelId`, `createdAt`, `updatedAt`.

That matters more here than elsewhere. The request identity is what prevents a
second billed provider call; an attempt that could be re-labelled after the fact
would make the audit trail of a paid call unreliable.

Every field is optional, and **an absent key means "leave alone"** — which is
what gives the `providerPredictionId` rule below for free.

## `SceneGenerationNotFoundError`

A typed neutral error rather than the plain `Error` the older repositories throw.
The reason is concrete: this record drives worker orchestration, and a worker
must tell *"the row is gone or not mine"* apart from *"the database failed"* to
classify a retry correctly. Matching message strings for that decision would be a
bug waiting on a wording change.

The message is generic and constant — no id, no organization, no database
detail — because an unknown id and another tenant's id must produce **the same**
error. A test asserts neither organization id, the generation id, `Prisma`, nor
`scene_generations` appears anywhere in it.

Scoped to this module deliberately. The older repositories keep their plain
`Error`; aligning them is a separate layer-wide decision and was not done here.

## `ActiveGenerationConflictError`

Neutral, mirroring `DuplicateApprovalConflictError`. It means exactly one thing:
this request already has an attempt in flight (or in `SUBMISSION_UNKNOWN`, or
awaiting a safe retry). It is not a general uniqueness error.

A test stringifies the thrown error and asserts it contains no `P2002`, no
`Prisma`, no `scene_generations_active_request_key`, no `Unique constraint`, and
carries no `code` property.

Neither error extends `AppError` — they are repository-boundary types, and HTTP
mapping is not part of this milestone.

## P2002 target recognition

```ts
const ACTIVE_REQUEST_TARGET = ["videoProjectId", "requestHash"] as const;
// code === "P2002" && exact, order-insensitive set match on meta.target
```

Based on the runtime shape **verified in Phase 4A-2a**, not on the index name.
Two failure modes avoided at once:

- **Index-name matching would silently never fire.** Prisma identifies a
  constraint by covered fields; `analysis-repositories.ts` carries the scar of an
  earlier version that got this wrong.
- **Loose matching would misclassify.** Exact cardinality is required, so a
  future unique constraint over a superset — say
  `(videoProjectId, requestHash, providerName)` — is a different invariant and
  will not be translated. The older substring-based `covers()` helper is
  deliberately **not** reused.

## Tenant-scoped query strategy

The organization predicate lives **inside the query**, never as an
application-side check after an unscoped read:

| Operation | Predicate |
| --- | --- |
| `findById` | `{ id, videoProject: { organizationId } }` |
| `findActiveByRequestIdentity` | `+ state: { in: ACTIVE_SCENE_GENERATION_STATES }` |
| `update` | `updateMany({ where: { id, videoProject: { organizationId } } })`, then a **same-scoped** reload |

The active-state list is imported from the domain rather than restated, so a
state added there becomes visible here automatically — and the migration's
matching predicate is guarded by its own test from 4A-2a.

`updateMany` returning `count === 0` is the single code path for both "unknown"
and "another tenant's", which makes them indistinguishable by construction
rather than by convention.

## `providerPredictionId` retention — evidence

The mandated regression, proven three ways:

| Case | Result |
| --- | --- |
| `PROCESSING` with `pred_123` → state-only update to `SUCCEEDED` | id remains `pred_123` |
| same, moving to `SUCCEEDED` / `FAILED_RETRYABLE` / `FAILED_TERMINAL` | id remains on all three |
| caller passes `providerPredictionId: null` explicitly | cleared, as asked |

Structural, not incidental: the adapter only writes a key the caller supplied, so
no state change can null it as a side effect. The repository encodes no provider
lifecycle semantics.

## Unrelated errors propagate — evidence

Both triggered as **real database failures**, no mocking of Prisma internals:

| Trigger | Code | Result |
| --- | --- | --- |
| Duplicate primary key (same `id`, different `requestHash`) | `P2002` | **not** translated; propagates with `code === "P2002"` |
| `videoProjectId` referencing a nonexistent project | `P2003` | **not** translated; propagates |

The first is the sharpest guard available: same error code, different covered
fields. A worker retrying on a mis-translated duplicate-key would be retrying the
wrong thing entirely.

## Test matrix — 44 live PostgreSQL cases

| Group | Cases |
| --- | --- |
| create and mapping | full mapped entity, nullable round-trip, timestamps from persistence |
| tenant-scoped reads | owning-org find, foreign `null`, unknown `null`, foreign and unknown **equal** |
| `findActiveByRequestIdentity` | all 5 active states found, all 3 terminal states not found, cross-tenant invisible, same hash in another tenant unaffected, unknown hash `null` |
| tenant-scoped update | owning-org succeeds, foreign throws, unknown throws the **same** error, row untouched after a foreign attempt, no detail leaked |
| mutable fields | all 7 update independently, explicit `null` clearing, unmentioned fields left alone |
| `providerPredictionId` retention | 3 cases above |
| `updatedAt` and immutability | advances on write, `createdAt` stable, all 8 identity/provenance fields unchanged |
| conflict translation | first succeeds, all 5 active states raise the conflict, no database vocabulary leaked, all 3 terminal states release |
| over-translation guards | duplicate PK, invalid FK |

4A-2a's SQL invariant matrix is **not** repeated — that milestone proves the
database, this one proves the adapter.

## In-memory repository — still deferred

Unchanged from the plan, for three reasons: Phase 3C set the precedent (no
in-memory storyboard repository, inline doubles carried six milestones); 4B needs
four methods, which is roughly thirty lines against a fixture it will build
anyway; and the interesting behaviour to simulate is the partial unique index,
where a subtly wrong double would give 4B false confidence about the one
invariant that prevents a duplicate charge. Re-evaluate once the
`GenerationService` harness exists.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | clean |
| `pnpm test` | **806 / 806**, 48 files (unchanged — this milestone adds only live-DB tests) |
| `pnpm build` | clean production build |
| `pnpm test:db` | **97 / 97**, 6 files (53 → +44) |

No migration-from-empty or drift gate is claimed: schema and migrations have zero
diff.

**Infrastructure event:** the local PostgreSQL cluster was down on the first run
of the new suite (`pg_lsclusters` → `Status: down`). Local infrastructure, not a
code defect. Restarted with no repository file modified; the rerun passed 44/44.
Fifth occurrence this session.

## Scope boundaries

Zero diff: `packages/database/prisma/schema.prisma`,
`packages/database/prisma/migrations/`, `apps/web/`, `packages/queue/`,
`apps/worker/`, `packages/video-providers/`, `packages/storage/`, and all Phase 3
code. No production file beyond the four planned was needed.

## Documentation

This report, `CHANGELOG.md`, `docs/progress.md`.

**Not applicable, with reason:** no schema, migration, or ER change — the 4A-2a
migration is untouched. `docs/architecture.md` needs no edit: a Prisma repository
behind a domain port is the boundary it already documents for four other
repositories, so no module boundary changed. ADR-0016 is unchanged — the
implementation exposed no new architectural fact.

## Known limitations

- **Nothing calls this repository yet.** Its first consumer is Phase 4B's
  `GenerationService`.
- **No listing.** Deliberate; arrives with a real reader.
- **The older repositories still throw plain `Error` for not-found.** Improved
  locally here, not layer-wide — a candidate for a future cleanup, recorded but
  not acted on.
