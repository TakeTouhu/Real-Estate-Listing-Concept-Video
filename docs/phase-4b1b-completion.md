# Phase 4B-1b completion report — single-scene generation admission

Merged as PR #32.

## Scope

One operation: `GenerationService.startScene`. It safely admits a single
storyboard scene for generation exactly once — deduplicating against an active
or already-succeeded attempt, refusing a stale storyboard or an unsupported
request before anything billable, and recording the attempt as a durable
`QUEUED` row that is enqueued and then audited. No batch method, no per-scene
outcome array, no partial-batch semantics, no explicit regeneration path. No
provider call and no storage write. Authoritative decisions are in ADR-0017.

## Final API

```ts
class GenerationService {
  startScene(
    actorUserId: string,
    organizationId: string,
    videoProjectId: string,
    storyboardSceneId: string,
  ): Promise<SceneGeneration>;
}
```

Every refusal throws an `AppError`; every success — new, reused-active,
reused-succeeded, or race-winner — returns a `SceneGeneration`. The returned
value is a domain entity, not an HTTP DTO (it carries `providerName`,
`providerModelId`, `providerPredictionId`); a transport layer must project it.

## Exact execution ordering

```
authorize property:write
→ storyboard.assertFresh                     (distinct NEVER_COMPOSED / STALE messages)
→ storyboard.getStoryboard                   (scoped project + scenes)
→ reject if view.fresh === false             (no new I/O; the value getStoryboard returned)
→ resolve scene ONLY inside view.scenes      (else NOT_FOUND)
→ reject if scene.compiledPrompt === null    (VALIDATION_FAILED)
→ capability = capabilities.current()        (exactly once)
→ assertSettingsSupported(settings, capability)
→ requestHash = computeGenerationRequestHash(facts)
→ findActiveByRequestIdentity → return if found
→ findLatestSucceededByRequestIdentity → return if found
→ create (at most once)
    catch ActiveGenerationConflictError → re-read active, then succeeded, else INTERNAL_ERROR
→ enqueue({ generationId })
→ audit generation.requested
→ return
```

## Evidence (60 service tests, all green)

- **Authorization.** OWNER/ADMIN/CREATOR admitted; REVIEWER and non-member →
  `FORBIDDEN`. A non-member request performs zero storyboard reads, zero
  capability lookups, zero enqueues, zero audits, and writes no row — proving
  authorization is strictly first.
- **Nested tenant/project/scene integrity.** A valid scene in the scoped project
  succeeds. An unknown scene id and a scene from another project both yield
  `NOT_FOUND` with an identical message (a foreign scene is simply absent from
  `view.scenes`). A request naming another organization is refused at
  authorization, disclosing nothing.
- **Freshness.** Fresh proceeds. `STALE` and `NEVER_COMPOSED` each propagate the
  precise message and create/enqueue/audit nothing. `assertFresh` passing while
  the returned `view.fresh === false` is refused with `VALIDATION_FAILED`, with
  `storyboard.calls === ["assertFresh", "getStoryboard"]`.
- **Prompt readiness.** `compiledPrompt === null` → `VALIDATION_FAILED`, zero
  row/enqueue/audit. The compiled prompt is never parsed, rendered, logged, or
  placed in an error or audit entry.
- **Capability.** Supported settings proceed. Unsupported duration, resolution,
  aspect ratio, non-empty negative prompt, and camera motion are each refused
  before any admission. A blank/whitespace negative prompt does **not** require
  support (merged 4B-1a semantics). The capability snapshot is read exactly once.
- **Request identity.** The persisted `requestHash` equals an independently
  computed `computeGenerationRequestHash` over the authoritative facts. Identity
  is unchanged by scene position, `sourceAnalysisRevision`, and storyboard scene
  id; it changes when `providerName` or `providerModelId` changes.
- **Active reuse — all five states.** Parameterized over
  `ACTIVE_SCENE_GENERATION_STATES` (`QUEUED`, `SUBMITTING`, `PROCESSING`,
  `FAILED_RETRYABLE`, `SUBMISSION_UNKNOWN`): the existing row is returned;
  nothing is created, enqueued, or audited. `SUBMISSION_UNKNOWN` is additionally
  pinned to never produce a replacement.
- **SUCCEEDED reuse.** The latest succeeded attempt is returned; nothing is
  created, enqueued, or audited. `FAILED_TERMINAL` and `CANCELLED` do not block a
  new attempt.
- **Precedence.** With both an active and an older succeeded attempt present, the
  active one wins.
- **Race recovery.** A create conflict re-reads active → returns the winner;
  else re-reads succeeded → returns that winner; else raises a neutral
  `INTERNAL_ERROR` whose message names no id/hash/tenant/provider/database
  detail. `create` is called exactly once (asserted). The race winner is neither
  enqueued nor audited by the loser. An unrelated repository error
  (`SceneGenerationNotFoundError`) propagates unchanged.
- **Initialization.** Every field of a new attempt is pinned: `gen`-prefixed id,
  authoritative `videoProjectId` from `view.project`, provenance from the scene,
  frozen provider/model from the one snapshot, `state === "QUEUED"`, and all six
  execution fields null.
- **Queue.** The payload key set is exactly `["generationId"]`. A new attempt is
  enqueued exactly once; a reused attempt is not enqueued.
- **Enqueue failure.** The error propagates; the row remains, `QUEUED`, not
  deleted, not failed; nothing is audited. A later `startScene` returns the
  stranded row via the active lookup and does **not** re-enqueue it.
- **Audit.** Emitted only after a successful enqueue; action
  `generation.requested`, `resourceType` `scene_generation`, `resourceId` the
  generation id, `organizationId`/`actorUserId` correct. Metadata key set is
  exactly the nine allowlisted fields, with the compiled prompt, prompt/negative
  text, prediction id, storage key, api key, and a duplicated organization id all
  absent. Active reuse, succeeded reuse, and race-winner convergence audit
  nothing. An audit-sink failure propagates while leaving the row persisted and
  the job enqueued exactly once (no rollback, no second enqueue).
- **Non-interference.** The wired dependency set is exactly
  `capabilities, generations, identity, ids, queue, storyboard` — no
  `VideoGenerationProvider`, provider factory, or storage port. `generation-service.ts`
  imports neither `@app/video-providers` nor `@app/storage`.

### Test non-vacuity

Two targeted mutations confirmed the safety tests fail when the behavior
regresses (each reverted immediately):

- Neutering the `view.fresh` guard fails the "assertFresh passes but view not
  fresh" test.
- Reordering to `create → audit → enqueue` fails the two enqueue-failure tests
  (an audit entry appears where the contract forbids one).

## Files

New:
- `packages/domain/src/generation/generation-service.ts` (328)
- `packages/domain/src/generation/generation-service.test.ts` (863, 60 tests)
- `packages/domain/src/generation/queue.ts` (42)
- `packages/domain/src/generation/audit.ts` (25)
- `packages/domain/src/testing/in-memory-queue.ts` (41)
- `docs/decisions/0017-generation-request-admission-and-reuse.md` (212)
- `docs/phase-4b1b-completion.md` (this file)

Modified:
- `packages/domain/src/generation/index.ts` (+3 exports)
- `packages/domain/src/generation/ports.ts` (+43, `StoryboardReader`)
- `packages/domain/src/testing/index.ts` (+1 export)
- `CHANGELOG.md`, `docs/progress.md`, `docs/decisions/TODO.md`

LOC: production ~441 (service 328, ports +43, queue 42, audit 25, index +3),
test ~905 (service test 863, queue double 41, testing index +1), docs ~212 for
the ADR plus this report and the changelog/TODO/progress deltas.

## Prohibited-area zero diff

No change to `prisma/`, migrations, `packages/database`, `packages/queue`,
`packages/video-providers`, `packages/storage`, `apps/web`, `apps/worker`, or
`roles.ts`. No schema or migration change (ER/migration docs not applicable).

## Local verification

- `pnpm typecheck` — clean, all packages.
- `pnpm lint` — clean.
- `pnpm test` — **922 passed** across 51 files (+60 from this milestone; the
  prior merged-main baseline was 862).
- `pnpm build` — clean production build.
- `pnpm test:db` — **118 passed** across 6 files (pure regression; no schema
  change).

## Infrastructure events (not code defects)

Both occurred during `pnpm test:db` and were resolved without modifying any
repository file; the diff scope was re-verified afterward.

1. **PostgreSQL cluster was down.** `pg_lsclusters` showed `16/main` down;
   `pg_isready` reported no response. Restarted with `pg_ctlcluster 16 main
   start` (a stale pid file was removed) and the `revt` role password was
   restored with `ALTER ROLE revt WITH PASSWORD 'revt'`.
2. **`DATABASE_URL` was unset in the shell.** The two legacy DB suites connect in
   `beforeAll` and failed initialization; the generation suites merely skip when
   the variable is absent. Supplied inline —
   `postgresql://revt:revt@127.0.0.1:5432/revt_verify?schema=public` — matching
   the existing `revt_verify` database. Re-run: 118/118.

## Defects discovered during implementation

None that survived. One self-caught wiring error before any test run: the audit
actor was initially set from `project.createdBy` rather than the requesting
`actorUserId`; corrected before the first test pass so the audit records who
made the request.

## Remaining Phase 4B-2 / 4C requirements

- **4C (mandatory).** Recover stranded `QUEUED` rows left by an enqueue or audit
  failure. Define a trusted, system-scoped worker lookup that resolves a
  generation from a `generationId`-only job without weakening the
  organization-scoped tenant-facing repository methods and without widening the
  queue payload. Both recorded in `docs/decisions/TODO.md`.
- **4B-2 (blocked).** Verified WaveSpeed model capabilities, pricing/commercial
  verification, and the aspect-ratio product contract; the adapter still sends
  fields the candidate model may not document. No real capability values are
  introduced here.
- **4D.** Whether a succeeded attempt's `outputStorageKey` makes its output
  actually reusable — reuse here is duplicate-spend prevention only.
