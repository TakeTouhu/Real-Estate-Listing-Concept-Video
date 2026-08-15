# ADR-0017: Single-scene generation admission, reuse, and side-effect ordering

Status: Accepted (Phase 4B-1b)
Date: 2026-08-14

## Context

Phase 4A built the vocabulary, persistence, and capability contract for scene
generation. Nothing yet *admits* a scene: no code turns "the reviewer wants this
scene generated" into a durable, enqueued, audited attempt. Phase 4B-1b adds
exactly that one operation — `GenerationService.startScene` — and stops there.

The operation is deliberately single-scene. The commercial objective is narrow
and load-bearing: **safely admit one scene for generation exactly once**, never
paying the provider twice for the same request and never admitting a storyboard
the customer has already invalidated. Whole-video and project-batch
orchestration is later work and is explicitly out of scope; there is no batch
method, no per-scene outcome array, and no partial-batch semantics. An earlier
draft of this milestone expanded into project-wide batch admission and was
rejected before implementation.

Three merged facts frame the decisions:

- `StoryboardService` already owns freshness. `assertFresh` throws
  `VALIDATION_FAILED` with distinct `NEVER_COMPOSED` and `STALE` messages, and
  `getStoryboard` returns the scoped project, its scenes, and a re-derived
  `fresh` flag. Re-deriving a fingerprint inside generation code would duplicate
  that authority (ADR-0012).
- The Phase 4A-2 partial unique index on `(videoProjectId, requestHash)` over
  the active state set is the concurrency authority. A service-level lookup is a
  convenience, never the guarantee (ADR-0016 §5–§6).
- The queue is abstract. `SceneGenerationJob` carries a `generationId` and
  nothing else, and no worker exists yet (Phase 4C).

## Decision

### 1. `property:write` is the authorization boundary

Admission is gated by `property:write` (OWNER / ADMIN / CREATOR), the same
permission that composes a storyboard. A REVIEWER approves output; they do not
commission paid work, so `video:review` is not reused. No new
`generation:request` permission is introduced and `roles.ts` is unchanged — a
dedicated spend permission can be reconsidered later, but it is not required to
complete the product path. Authorization is the first operation: no storyboard
read, repository access, capability lookup, enqueue, or audit occurs before it
succeeds.

### 2. Freshness is a hard pre-spend gate

`assertFresh` is called before capability validation, create, enqueue, and
audit, keeping its distinct `NEVER_COMPOSED` / `STALE` messages. A stale or
absent storyboard creates nothing, enqueues nothing, and audits nothing.

Because the mandated flow also calls `getStoryboard` (for the scoped project and
scenes), and `getStoryboard` re-derives freshness and returns it as
`view.fresh`, the service additionally refuses when `view.fresh === false`. This
is not new I/O — it reads a value already computed — and it does not attempt to
close the race between the two derivations, which would require a transaction
spanning both. It enforces one literal invariant: the later, more current
observation wins, so a storyboard already known to be stale is never admitted.
No fingerprint logic is duplicated in generation code.

### 3. The scene is resolved only inside the scoped view

`storyboardSceneId` is never trusted independently of `videoProjectId`. The
scene is located solely within `view.scenes`, which `getStoryboard` produced
under organization *and* project scope. A scene belonging to another project is
therefore simply absent from that list — indistinguishable from an id that never
existed — and both yield the same neutral `NOT_FOUND`, disclosing nothing about
the other project or scene. No new storyboard repository method is added, and no
application-level ownership comparison replaces query-level scoping.

### 4. A scene with no compiled prompt is refused

`compiledPrompt === null` is refused with `VALIDATION_FAILED` before any write,
enqueue, audit, or provider interaction, with a message that instructs
recomposition. The compiled prompt is treated as an opaque persisted string: it
is never parsed, flattened, rendered, logged, placed in an error message, or
placed in audit metadata. It is used only as a fact for the request hash.

### 5. One capability snapshot freezes provider and model

`capabilities.current()` is called exactly once per request. That single
snapshot supplies the provider/model pair to three places at once — capability
validation, the request hash, and the persisted row — so a configuration change
mid-request cannot produce a stored provider/model pair different from the pair
the request was hashed under. Capability rules themselves are not restated in
`GenerationService`; it assembles `GenerationRequestSettings`
(`durationSeconds`, `cameraMotion` from the scene; `resolution`, `aspectRatio`,
`negativePrompt` from the project) and delegates to the merged
`assertSettingsSupported`, preserving the Phase 4B-1a semantics (blank negative
prompt is absent; camera motion keeps its plain-null check; aspect ratio is
never silently dropped). No real WaveSpeed values are introduced — Phase 4B-2
owns them.

### 6. Reuse precedence is active, then latest succeeded, then create

The lookup order is fixed and each early exit is side-effect-free:

1. `findActiveByRequestIdentity` — if an attempt is in flight in **any** active
   state (`QUEUED`, `SUBMITTING`, `PROCESSING`, `FAILED_RETRYABLE`,
   `SUBMISSION_UNKNOWN`), return it. Create nothing, enqueue nothing, audit
   nothing. In particular `SUBMISSION_UNKNOWN` never produces a replacement
   attempt, and a stranded `QUEUED` row is **not** re-enqueued here.
2. `findLatestSucceededByRequestIdentity` — only when nothing is active. If a
   succeeded attempt holds this identity, return it. Create nothing, enqueue
   nothing, audit nothing.
3. Otherwise create a new attempt.

If both an active and an older succeeded attempt exist, the active one wins
because it is the current execution.

### 7. Succeeded reuse is duplicate-spend prevention, not output reuse

Returning a succeeded attempt exists for one reason: on a paid provider, an
identical request that already succeeded must not silently become a second
charge. It makes **no** claim that the succeeded attempt's output is currently
retrievable or reusable — `outputStorageKey` is null until Phase 4D, which owns
that question. Deliberate regeneration after success is **not** exposed in this
milestone; Phase 5's scene-level regeneration owns any explicit-intent path.

### 8. The database index is the concurrency authority; races converge by re-reading

`create` is attempted at most once, never in a loop. Two callers can both reach
step 3 having found nothing, so `create` may still collide — the partial unique
index, not the lookups, is what prevents a second active attempt. On
`ActiveGenerationConflictError` the service re-reads active, then succeeded, and
returns whichever winner it finds; that winner is enqueued and audited by the
request that created it, never by the loser.

### 9. Unreconcilable convergence is a neutral INTERNAL_ERROR

If neither an active nor a succeeded winner is found after a conflict, the
winner reached a terminal-but-not-succeeded state in the gap, or a genuine
infrastructure inconsistency occurred. This is **not** an invalid request, so it
is `INTERNAL_ERROR`, never `VALIDATION_FAILED`. The message is generic and names
no id, request hash, tenant, provider, or database detail. Any repository error
other than `ActiveGenerationConflictError` — a non-active `P2002`, a `P2003`, a
`SceneGenerationNotFoundError`, a transport failure — propagates unchanged; the
service does not reclassify it.

### 10. Side-effect ordering is create → enqueue → audit

The order is fixed and the reasoning is financial: **audit is emitted only after
the queue has accepted the job.** A record of "requested for execution" that
outran a successful enqueue would assert work that a worker will never see.

> **Amended 2026-08-15 by ADR-0018 (Phase 4B-1c).** The `create` step now
> durably persists the immutable request snapshot as well — the compiled prompt,
> duration, camera motion, aspect ratio and resolution the request was admitted
> under — taken from the same resolved scene, project and capability that
> produced `requestHash`, with nothing re-read in between. The ordering itself is
> unchanged; what changes is that the row written before the enqueue is now
> sufficient to reconstruct the request without the storyboard scene or the
> project's current settings. See ADR-0018.

- **Enqueue failure** leaves the durable `QUEUED` row exactly as it is — not
  deleted, not marked `FAILED_RETRYABLE` or `FAILED_TERMINAL`, its active
  identity intact — audits nothing, and propagates the queue error. A later
  `startScene` for the same request finds that row via the active lookup and
  returns it **without enqueuing again**. `startScene` is not the recovery
  mechanism; Phase 4C's `QUEUED` sweep is.
- **Audit failure** (after a successful enqueue) propagates under the existing
  audit convention (matching `AnalysisService`). The row is not deleted, the
  enqueue is not rolled back or pretended-rolled-back, and nothing is enqueued
  twice. A generation can therefore exist, be enqueued, and lack its audit
  entry — a documented consistency window, not a new one.

### 11. Audit metadata is an explicit allowlist

Exactly one audit action is added, `generation.requested`, with
`resourceType: "scene_generation"` and `resourceId` the generation id. It is
emitted once per newly created attempt, and never for a reused active or
succeeded attempt or a race-winner. Metadata is built field by field, never by
spreading an entity, and contains exactly: `videoProjectId`,
`sourceStoryboardSceneId`, `assetId`, `sourceAnalysisRevision`,
`durationSeconds`, `requestHash`, `providerName`, `providerModelId`, `state`. It
excludes the compiled prompt, any prompt or negative-prompt text, the prediction
id, any API key, any temporary URL, raw provider errors, the storage key, and a
duplicated organization id (the entry already carries `organizationId` as its
own column). The `requestHash` is a non-invertible digest and is included
because duplicate-spend investigation needs it, matching `storyboard.composed`
recording its `compositionFingerprint`.

### 12. No transaction and no transactional outbox

No transaction port is introduced. A database transaction cannot atomically
include the abstract queue, so wrapping the writes would look atomic without
being atomic. Safety comes from the durable `QUEUED` row, the active-request
identity, the partial unique index, service-level reuse, race convergence, and
the mandatory Phase 4C recovery sweep. No transactional outbox is introduced in
this milestone.

### 13. Phase 4C must recover stranded rows and resolve the worker lookup

Two consequences are deferred to Phase 4C as mandatory requirements:

- Recover stranded `QUEUED` generations that were persisted but not durably
  enqueued (enqueue or audit failure).
- Provide a trusted, **system-scoped** lookup so a worker holding only a
  `generationId` can load the generation, **without** weakening the
  organization-scoped tenant-facing repository methods and without widening the
  queue payload.

### 14. The returned SceneGeneration is not an HTTP DTO

`startScene` returns the domain `SceneGeneration`, which carries `providerName`,
`providerModelId`, and `providerPredictionId` — internal facts. Any transport
layer must project it; the entity must not be serialized to a customer response
as-is (ADR-0016 §9).

## Consequences

- One scene can be admitted, deduplicated, and enqueued without a second provider
  charge for an identical request, and without admitting a known-stale storyboard.
- A single network failure at enqueue time strands a `QUEUED` row that only Phase
  4C can recover; `startScene` will keep returning it, correctly, in the meantime.
- No provider is called and no storage is written in this milestone; generation
  *execution* is Phase 4C.
- The abandoned project-batch design — outcome arrays, partial-batch semantics,
  batch conflict aggregation — is explicitly not part of this decision.
