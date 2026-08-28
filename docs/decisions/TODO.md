# Open decisions and unresolved items

Per `CLAUDE.md`: do not invent missing business rules — record them here.

## WaveSpeedAI

- [x] Verify the current WaveSpeedAI public API contract (submit path, result
      path, response envelope, status vocabulary, polling guidance). Done
      2026-07-27 — matches `docs/WaveSpeedAIIntegration.md`; see ADR-0005.
      `docs/WaveSpeedAIIntegration.md` left unchanged.
- [ ] Confirm the webhook authentication/signature mechanism WaveSpeedAI
      currently supports (for `POST /internal/webhooks/wavespeed`). The docs
      page was not machine-fetchable during Phase 0 verification.
- [ ] Confirm whether WaveSpeedAI supports cancellation, and the endpoint.
- [ ] Obtain real model capabilities, supported durations/resolutions/aspect
      ratios, concurrency limits, and **pricing** (placeholder pricing to be
      wired when `WaveSpeedVideoProvider` is implemented in Phase 1).
- [ ] Review WaveSpeedAI commercial-use terms, data handling, retention, and
      model policy before production launch.
- [x] Implement `WaveSpeedVideoProvider` submission/status/cancel/estimate +
      error normalization behind the adapter boundary (Phase 1, injected HTTP
      client, offline tests). Webhook handler + polling worker remain Phase 4.

## Phase 1 follow-ups

- [ ] Reconcile the `Credential` table (added in ADR-0006 for email/password
      auth) with `docs/DataModel.md`, or update the data model.
- [ ] Add a live-PostgreSQL CI job (`services: postgres` + `prisma migrate
      deploy`) running the Prisma-adapter integration tests. Tenant-isolation
      and audit behaviour are currently proven with in-memory adapters.
- [ ] Add OAuth (Entra ID / Google) and optional MFA for privileged roles.

## Phase 2 follow-ups

- [x] Guard against accidentally shipping the non-production adapters: both
      `LocalObjectStorage` and `PassthroughMalwareScanner` now throw
      `NonProductionAdapterError` when constructed under `NODE_ENV=production`.
      The message names the adapter and required action and contains no secrets;
      development/test are unaffected. Covered by
      `packages/storage/src/production-guard.test.ts`. **This mitigates the risk
      of an accidental production deployment but does not remove the underlying
      work below.**
- [ ] Replace `LocalObjectStorage` (in-process, not durable or multi-instance
      safe) with a real S3/Azure adapter behind the same `ObjectStorage` port
      before production launch (ADR-0008). Still required — the guard blocks
      production use, it does not provide durable storage.
- [ ] Replace `PassthroughMalwareScanner` with a real scanning engine (ClamAV or
      a vendor API) behind the `MalwareScanner` port. Still required — the guard
      blocks production use, it does not provide real scanning.
- [ ] Extend the production-safety guard to boot-time validation of the whole
      adapter set, so a misconfigured production deployment fails before serving
      any traffic rather than on first use (Phase 7 hardening).
- [ ] Move image processing off the upload-completion request path into the
      async worker once the queue lands in Phase 4.
- [ ] **Publish the `phase-*-complete` annotated tags to the remote.** Still
      blocked as of 2026-07-28: `phase-0-complete`, `phase-1-complete`,
      `phase-2-complete`, `phase-3a1-complete`, and `phase-3a2a-complete` exist
      only in the local clone and
      `git ls-remote --tags origin` is empty. Tag-ref pushes fail with
      `HTTP 403` (retried with explicit refspecs, `--tags`, and a single tag);
      branch pushes to the same remote succeed, so the proxy rejects tag refs
      specifically, and the GitHub tooling has no create-ref API. Needs a
      maintainer push:
      `git push origin refs/tags/phase-0-complete refs/tags/phase-1-complete refs/tags/phase-2-complete refs/tags/phase-3a1-complete refs/tags/phase-3a2a-complete`
- [ ] Decide the near-duplicate UX (block vs warn) during Phase 3 analysis
      review; Phase 2 only reports `duplicateOf`.
- [ ] Consider a DCT-based pHash if aHash proves too permissive on real photos.
- [ ] Extend the live-PostgreSQL integration suite (added in Phase 3A-2a) to the
      identity and property repositories; it currently covers the analysis
      repository only.
- [ ] **Make analysis persistence and audit persistence atomic.** Since Phase
      3A-2b the analysis row is written before its audit event, so an audit-sink
      failure returns an error while the analysis row remains `SUCCEEDED`. That
      boundary is deliberate — the alternative loses a completed analysis when
      only its audit write failed — but it means the two writes are not atomic.
      Closing the gap requires either a shared database transaction spanning the
      analysis row and the audit row, or a transactional outbox (append the audit
      event to an outbox table inside the same transaction as the analysis row,
      then publish it asynchronously with at-least-once delivery and dedupe on
      the event id). The outbox generalizes to credit settlement and provider
      webhooks in Phases 4–6, so decide it once, at the persistence layer, rather
      than per service.
- [ ] **Add rate limiting as one cross-cutting milestone.** `CLAUDE.md` requires
      rate-limiting login, uploads, generation and billing; none of them is
      limited today, and Phase 3A-3 deliberately did not add it for the analysis
      endpoints alone, because protecting one of four surfaces reads as
      protection without being it. Needs a shared limiter (per organization and
      per IP, with a store that survives multiple instances) applied to
      `/api/auth/*`, the upload routes, the analysis `POST` routes, and
      generation when it lands in Phase 4.
- [ ] **Decide whether analysis should run in the request or on the queue.**
      Phase 3A-3 runs it synchronously, which is fine for the offline
      deterministic adapter but not for a real vision vendor. Settle this before
      any vendor integration; it pairs with the Phase 4 job queue.
- [ ] Deduplicate concurrent analysis work. Since Phase 3A-2b the unique index
      on `asset_analyses.assetId` guarantees a single row and convergent
      results, but two concurrent requests for the same asset each perform their
      own provider call. A lease or conditional status update (`PENDING` claimed
      by exactly one worker) belongs with the job queue in Phase 4.

## Phase 3B follow-ups

- [ ] **Expose a machine-readable refusal reason on review errors.** Every
      domain refusal from `approve` / `reject` — duplicate conflict, already
      reviewed, blocking finding, missing primary, blank reason — is
      `VALIDATION_FAILED` / `422` today, so the only thing distinguishing them is
      the human-readable `error.message`. The review UI therefore renders that
      message as-is and never parses it (Phase 3B-3b), because matching on the
      text would turn a display string into an implicit API contract. Adding a
      stable `reason` code to the error envelope is the prerequisite for
      case-specific reviewer messaging, a `409` for duplicate conflicts, or any
      UI behaviour that branches on *which* rule refused.
- [ ] **`loading.tsx` changes the unauthenticated redirect shape.** With a
      loading boundary on `/properties/{id}/review`, Next flushes the shell
      before `redirect("/login")` resolves, so an unauthenticated request gets
      `200` plus a client-side redirect instead of `307`. No data is exposed —
      the body is only the skeleton — but the redirect is a visible extra step.
      Fixing it means dropping the loading state or moving the auth check into
      middleware.
- [ ] **Integration-test guard inconsistency.** Only
      `review-duplicate-conflict.db.test.ts` skips cleanly when `DATABASE_URL`
      is unset; `analysis-repository.db.test.ts` and `review-transaction.db.test.ts`
      still fail inside `beforeAll` (they merely *report* their tests as
      skipped). The same four-line guard fixes both. CI always sets
      `DATABASE_URL`, so this only affects local runs.

## Phase 3C follow-ups

- [ ] **Align the older repository update contracts, or accept the divergence.**
      `VideoProjectRepository.update(organizationId, id, changes)` takes only
      genuinely mutable fields, so `propertyId`, `organizationId`, `createdAt`
      and `updatedAt` cannot be supplied at all — an attempted property move is a
      type error rather than a silently ignored field. The older ports
      (`AssetAnalysisRepository`, `PropertyRepository`, `MediaAssetRepository`,
      `InvitationRepository`) still take a whole entity and rely on their
      adapters enumerating the mutable columns. The divergence is deliberate and
      currently harmless — the new port has no other callers — but the two styles
      should not coexist indefinitely. Converging them is a cross-repository
      refactor and needs its own approval.
- [ ] **`StoryboardScene` generation status vocabulary.** `docs/DataModel.md`
      lists a `status` column but documents no values, and every plausible one
      (`GENERATING`, `READY`, `FAILED`) describes Phase 4 generation. The column
      is deliberately omitted until Phase 4 defines it.

## Phase 3C-3 follow-ups

- [ ] **Replace the offline prompt moderator with a real moderation vendor.**
      `createOfflinePromptModerator` is a deterministic explicit-violation
      detector over the documented product rules, not semantic moderation:
      paraphrase passes it, and a test records that. A vendor adapter behind the
      same `PromptModerator` port, normalizing into the existing
      `ModerationCode` vocabulary, is the fix. Until then, prompt integrity rests
      on structural separation (ADR-0014), not on this matcher.
- [ ] **Unstated moderation rules.** Profanity, competitor names, and
      advertising-law constraints are not in any product document, so the offline
      moderator enforces none of them. If they are required, they need stating
      before implementation — the matcher must not grow a general blacklist by
      accretion.
- [ ] **Phase 4 must not flatten `CompiledPrompt`.** The five parts stay
      separate precisely so untrusted text cannot displace a preservation rule.
      Rendering to a provider payload has to preserve that; no code enforces it
      yet because no renderer exists.

## Phase 3C-5 follow-ups

- [ ] **Phase 4 must validate generation against real provider capability
      before any provider call.** `createProject` accepts `durationSeconds`,
      `aspectRatio` and `resolution` with structural validation only, and the
      compose endpoint will accept caller-supplied per-scene duration bounds for
      the same reason: no capability source exists in Phase 3C, and inventing a
      provisional table would bake in limits nothing has verified. **These values
      are not authoritative provider capabilities.** Phase 4 owns checking a
      requested duration, ratio and resolution against the configured model
      before spending a provider call.

## Phase 3C-6 follow-ups

- [ ] **Rename, edit settings, and delete a video project — required for
      commercial-launch readiness, deferred from Phase 3C-6a.** These are
      *deferred, not judged unnecessary*. Today a customer who mistypes a target
      length, aspect ratio, resolution, or prompt has no way to correct it: the
      only remedy is creating another project and abandoning the first, which
      also leaves unusable projects accumulating on the property. Closing this
      needs a `PATCH` and a delete endpoint, the matching `StoryboardService`
      methods with `property:write` authorization and tenant scoping, audit
      events, and a rule for what happens to an already-composed storyboard when
      its settings change (almost certainly: invalidate the fingerprint so the
      storyboard reads stale). **Review before commercial launch.**
- [ ] **Composition duration bounds have no product-level source.**
      `minSceneSeconds` and `maxSceneSeconds` will be explicit required inputs in
      the Phase 3C-6b compose UI, with no default, because no provider-derived
      value exists yet and a prefilled number would function as a provisional
      capability assumption however it were labelled. Phase 4 must replace or
      constrain this input from the configured provider's real capabilities
      before generation.

## Phase 4A-1 follow-ups

- [ ] **An ambiguous provider submission needs an operator reconciliation path.**
      `SUBMISSION_UNKNOWN` has no automatic exit and still holds the local
      generation identity (ADR-0016), so one dropped connection during
      submission blocks that scene from being generated again until a human
      intervenes. That is the correct trade — a stalled scene beats a duplicate
      charge — but it is not free, and nothing resolves it today. Closing this
      needs a way to establish what the provider actually did (querying it for
      the prediction, or explicit operator judgement), an explicit
      operator-driven transition that is **not** a re-POST, and an audit event
      recording who decided what. Deliberately not implemented in Phase 4A-1: it
      is a real operational feature, not a state-machine edge, and inventing an
      automatic version of it would defeat the protection. **Revisit once Phase
      4C shows how often ambiguity actually occurs.**

## Phase 4A-2a follow-ups

- [ ] **Define retention/archive behaviour for scene-generation history before
      any physical deletion path ships.** `scene_generations.videoProjectId` uses
      `ON DELETE RESTRICT`, deliberately unlike every other child in this schema,
      because a generation row can record a paid provider attempt and must not be
      erased by a cascade nobody reasoned about. Today this changes nothing:
      property removal is a **soft** delete and no code physically deletes a
      property or a video project. But the moment a real deletion path is built —
      the Phase 7 retention job, a project-delete endpoint, a tenant offboarding
      flow — it will hit that `RESTRICT` and **must not** be "fixed" by switching
      to `CASCADE`. The product has to decide first: how long paid-attempt
      history is kept, whether it is archived or summarized before deletion, and
      what a billing dispute needs to be able to reconstruct. That is a
      product/finance decision, not a schema tweak. **Revisit before Phase 7, and
      before any project-deletion feature.**

## Phase 4C-3A-1 follow-ups

- [ ] **A physical deletion worker must not remove a source object a provider may
      still depend on.** None exists today: `ObjectStorage.deleteObject` has zero
      production callers, nothing writes `status = DELETED`, and
      `retentionExpiresAt` is only ever set to null — so `DELETION_PENDING` is a
      marker with no storage effect, and Phase 4C-3's "a deletion requested after
      a successful claim does not revoke the licence" is safe as things stand.
      When such a worker is built it must protect assets referenced by a
      generation in **`SUBMITTING`, `PROCESSING` or `SUBMISSION_UNKNOWN`**. The
      third is the one that is easy to miss and most expensive to get wrong:
      `SUBMISSION_UNKNOWN` may represent a request the provider accepted and
      billed even though acceptance cannot be proven locally, so deleting its
      source destroys the recovery path. `MediaAsset` has no relation to
      `SceneGeneration` — `assetId` is deliberately un-foreign-keyed — so the
      worker must check generation state explicitly; the database will not stop
      it. **Required before any physical deletion ships.**
- [ ] **A failed derivative cleanup still needs storage-side reconciliation.**
      **Mostly closed in Phase 4C-3A-1** (ADR-0028 §8): when the final
      `PROCESSING -> READY` write loses, `completeUpload` now deletes the
      normalized image and thumbnail it wrote, skipping any key the
      authoritative row now references, and raises a sanitized `INTERNAL_ERROR`
      if a required delete fails.
      What remains is that failure case. The object is unreferenced **and the
      asset row does not name it** — the write that would have named it is the
      one that lost — so **row-walking retention cannot discover it**, and an
      earlier version of this entry was wrong to say the future retention worker
      would find it. Recovery requires storage-side reconciliation: a
      deterministic asset-prefix enumeration (`buildAssetStorageKey` makes the
      candidate keys derivable from the row even though the row does not carry
      them), or another durable cleanup mechanism. Not urgent — the objects are
      tenant-scoped and unreachable through any signed URL — but do not assume
      the retention worker covers it.
- [ ] **Phase 4C-3A-2 source identity must include `sha256`.**
      `buildAssetStorageKey` is deterministic from organization, property, asset,
      variant and extension, so a re-processed normalized JPEG for the **same**
      asset reuses the **same** `normalized.jpg` key with different bytes. Key +
      MIME equality would pass over a genuinely different source. Compare
      `storageKey`, `mimeType` **and** `sha256` against the locked observation,
      and fail closed in preflight when a supposedly executable `READY` source
      carries no usable content hash. **Required before the locked claim ships.**

## Phase 4B follow-ups

- [x] **Phase 4C MUST recover `QUEUED` generations that were never durably
      enqueued.** **Closed in Phase 4C-1a by removing the condition rather than
      recovering from it** (ADR-0024). There is no enqueue: `state = 'QUEUED'` is
      itself the acceptance condition, discovered by scan over the `(state)`
      index Phase 4A-2a added for exactly this. A row cannot be durable and
      undiscoverable, so no sweep is owed and no stranded state exists. What
      survives is narrower and is recorded in ADR-0024 §4: an audit-sink failure
      still leaves an executable row with no `generation.requested` entry. That
      is **not** mitigated today — see the next item, which is where the
      mitigation is owed.
- [x] **The canonical guidance specified the queue transport ADR-0024 removed.**
      **Closed in Phase 4C-1a**, by CTO authorization on PR #38, after automated
      review found that a later milestone following the guidance faithfully would
      rebuild the transport this one deleted. All four sources now agree:
      - `CLAUDE.md` — the stack line reads **"State-driven workers"**: the
        `SceneGeneration` row *is* the durable work item, there is no current
        broker, and introducing one later must supersede ADR-0024 rather than
        fall back to it as a default. The generation workflow now reads
        `Create idempotent generation attempt → Persist the SceneGeneration row
        as durable executable work → Worker discovers and claims an eligible
        SceneGeneration row → Generate scenes through WaveSpeedAI`, so it names
        both the durable artifact and how work is picked up, without implying a
        separate job record.
      - `docs/SystemArchitecture.md` — the queue technology line is a dated
        supersession recording that Redis/BullMQ, SQS and Azure Service Bus were
        each evaluated and rejected, so adding one later must supersede ADR-0024
        rather than fall back to a default; the asynchronous-generation section
        no longer describes an enqueue step.
      - `docs/architecture.md` and `apps/worker/src/bootstrap.ts` — corrected in
        the same milestone.
      Raised as a governance question rather than actioned unilaterally: an agent
      editing the constraints it is judged against, so they match what it has just
      built, is the wrong direction of authority. The CTO authorized it
      explicitly, which is what made the edit legitimate.
- [ ] **The milestone that adds provider submission MUST audit the paid call
      itself.** Phase 4C-1a made admission `create → audit` and accepted a
      consistency window: if the audit sink fails, the row stays durable,
      `QUEUED`, and therefore executable, with no `generation.requested` entry
      (ADR-0024 §4). Eligibility is state, never audit existence, and that is
      deliberate — gating execution on an audit row would let a failing sink
      silently cancel durable customer work.
      **The window is currently inert only because nothing submits**, which is a
      property of the system's incompleteness, not a safeguard, and it expires
      the moment execution lands. The submitting milestone must therefore emit
      its own audit entry for the provider call, so that **no provider charge is
      unaudited** regardless of what happened at admission. Until it does, an
      unaudited generation is a paid call waiting to be untraceable.
      **Required before any provider submission ships.**
- [x] **Phase 4C-1b MUST define a separate, trusted, system-scoped execution
      persistence boundary.** **Closed in Phase 4C-1b** (ADR-0025).
      `SceneGenerationExecutionRepository` discovers eligible `QUEUED` rows
      directly from persistence, resolves `organizationId` through
      `VideoProject`, never accepts a tenant from any caller, adds no column, and
      leaves the tenant-facing `SceneGenerationRepository` untouched and
      organization-addressed. Discovery is read-only; the claim is a
      compare-and-swap proven against live PostgreSQL at two and eight
      concurrent callers.
- [ ] **The milestone that adds submission MUST recover abandoned `SUBMITTING`
      rows.** Phase 4C-1b's claim moves a row `QUEUED → SUBMITTING` immediately
      before the provider call, and deliberately adds no lease, heartbeat, or
      sweep (ADR-0025 §5). A worker that dies after claiming therefore leaves the
      row in `SUBMITTING` with nothing to move it: durable and visible, but
      stalled, and holding its request identity so the customer cannot re-admit
      the same request.
      The shape of the fix is already decided by the state machine rather than
      open: an abandoned `SUBMITTING` becomes **`SUBMISSION_UNKNOWN`**, because a
      crashed worker leaves genuine doubt about whether the POST reached the
      provider, and re-submitting on doubt risks paying twice. What the
      submitting milestone must add is the staleness detection — `updatedAt`
      already advances on claim, and nothing else writes a `SUBMITTING` row — and
      a threshold comfortably above the provider HTTP timeout.
      **Required before any provider submission ships.**
- [ ] **Every future transition that can compete with the claim MUST carry an
      expected-state predicate.** Phase 4C-1b's claim is a compare-and-swap:
      `UPDATE ... WHERE id = $1 AND state = 'QUEUED'`. Nothing else in the system
      writes `state` that way. The tenant-facing
      `SceneGenerationRepository.update` deliberately carries **no** state
      predicate — it persists what it is asked to persist, leaving legality to
      `assertTransition` — which is correct for a caller that has already read
      and reasoned about the row, and unsafe for a caller competing with a
      worker.
      Concretely: a cancellation implemented as
      `update(org, id, { state: "CANCELLED" })` will overwrite a row a worker has
      already claimed and may already have submitted, producing a `CANCELLED` row
      the provider is still billing for and a state the machine says is
      unreachable from `SUBMITTING`. The claim's transaction does **not** prevent
      this: it only guarantees the claim never returns a row it did not itself
      move, and a writer that starts after that transaction commits is entirely
      unaffected by it.
      So any milestone adding cancellation, abandonment recovery, retry
      scheduling, or completion writes must express the move as a conditional
      update naming the state it expects to replace, and treat a zero-row result
      as "someone else moved it" rather than as success. A method that cannot
      state which state it is replacing does not belong on that path.
      **HARD PREREQUISITE — required before any competing transition ships,
      cancellation first.**
- [x] **Phase 4B-1c (immutable generation request snapshot) must be merged
      before Phase 4C implementation begins.** Landed as the follow-up to the
      PR #32 review finding; ADR-0018 records the contract. Phase 4C is a
      **hard blocked** milestone until it is merged and verified on `main`.
- [ ] **Phase 4C worker must fail closed for a legacy generation missing its
      immutable snapshot fields.** `generationRequestFactsFrom` throws
      `INTERNAL_ERROR` for a row admitted before ADR-0018; those rows have no
      recoverable request and must **never** be reconstructed from the current
      storyboard or project. Phase 4C decides the normalized failure state and
      reason code for such a row — this milestone deliberately does not, because
      the state machine's failure vocabulary is the worker's contract.
      **Closed across Phase 4C-2A and 4C-2B**: preflight classifies such a row as
      `LEGACY_SNAPSHOT_MISSING` / `LEGACY_PROMPT_MISSING` and never reconstructs
      from current state (ADR-0026); both are `TERMINAL`, so
      `failQueuedPreflight` parks them durably in `FAILED_TERMINAL` with the
      exact reason as `normalizedErrorCode` (ADR-0027). What remains is only the
      orchestration that calls the two, which is Phase 4C-3.
      **Required before Phase 4C ships.**
- [ ] **Phase 4C worker must derive a fresh signed source-image URL from durable
      asset identity.** `SceneGeneration.assetId` is the reference; no temporary
      URL, signed URL, or storage credential is ever persisted on a generation
      (ADR-0018 §6). The worker resolves `assetId` → `MediaAsset.storageKey` →
      `ObjectStorage.createSignedDownloadUrl` at execution time.
      **Closed in Phase 4C-2A** (ADR-0026 §3): `prepareQueuedGeneration` resolves
      exactly that chain, returns the URL on an ephemeral artifact, and persists
      nothing.
      **Required before Phase 4C ships.**
- [x] **Phase 4C-2B must map preflight refusals to durable parked states.**
      **Closed in Phase 4C-2B** (ADR-0027). `preflightFailureStateFor` derives the
      durable state from `preflightDispositionFor` — `RETRYABLE` parks in
      `FAILED_RETRYABLE`, `TERMINAL` in `FAILED_TERMINAL`, both via
      `failQueuedPreflight`'s expected-state CAS on `state = 'QUEUED'`. **Both are
      parked.** The exact reason is persisted as `normalizedErrorCode` with
      `normalizedErrorMessage` explicitly `null`.
- [ ] **No actor performs `FAILED_RETRYABLE -> QUEUED`, and none may be added
      implicitly.** The edge is legal and deliberately unperformed: there is no
      scheduler, no timer, no retry loop, and Phase 4C-2B added none. A
      `FAILED_RETRYABLE` park records that a later *explicit* policy could
      legitimately re-queue the row once the world has changed — not that
      anything should do so on a timer, and not that the row may be left `QUEUED`.
      Any future retry or requeue implementation must express the move as an
      expected-state CAS naming `FAILED_RETRYABLE` as the state it replaces, and
      treat zero rows updated as "someone else moved it" rather than as success
      (see the hard prerequisite above). Legality is not evidence of an actor.
      **Required before any retry or requeue policy ships.**
- [ ] **Phase 4C-3 must complete this sequence before any paid provider POST.**
      In order: (1) check the prepared source URL is still fresh — Phase 4C-2A
      deliberately does not, because freshness is only meaningful immediately
      before the charge; (2) review the residual deletion race, since preflight
      guarantees only that the source was still the signed one at its final
      observation, and deletion can be requested after `PreparedGeneration`
      returns; (3) the paid-call gate; (4) `QUEUED -> SUBMITTING` CAS; (5) a
      durable `generation.submission_started` audit; (6) the provider POST.
      Phase 4C-2B added no orchestration: it supplies `failQueuedPreflight` for
      the refusal branch, and nothing calls it. Phase 4C-3 also owns submission
      ambiguity (`SUBMISSION_UNKNOWN`), which pre-provider persistence failure is
      explicitly **not** — a failed park leaves the row `QUEUED` to be
      rediscovered, because no request was ever sent (ADR-0027).
      **Required before any provider charge is possible.**
- [ ] **A preflight-failure audit event, if wanted, belongs to orchestration.**
      Phase 4C-2B deliberately emits none: there is no provider POST in it, and
      coupling audit I/O into the persistence CAS would put a second failure mode
      inside the transaction that decides whether work is parked. The paid-call
      invariant is unchanged — a durable `generation.submission_started` audit
      must succeed **before** the provider POST. Decide during Phase 4C-3 whether
      a parked refusal also warrants an audit entry.
- [ ] **The 600-second preflight source URL TTL is provisional.**
      `PREFLIGHT_SOURCE_URL_TTL_SECONDS` was chosen for a pipeline nothing has
      run end to end. It must cover preparation, the claim, the POST and the
      provider's own fetch. Confirm or change it against a real submission during
      the Phase 4C-3 paid-call review. **Required before real provider spending.**
- [ ] **Capability re-validation at execution is identity-only.** Phase 4C-2A
      verifies the deployment still serves the admitted `providerName` and
      `providerModelId`, but cannot re-run `assertSettingsSupported`: that needs
      a discrete `negativePrompt`, and the snapshot stores only the opaque
      compiled prompt. A capability table edited under an **unchanged** model id
      — a resolution withdrawn, a duration range narrowed — would therefore not
      be noticed before submission, and the provider would refuse the request
      after being asked. Closing this needs either a discrete negative-prompt
      snapshot field or a capability-revision fact inside the request identity;
      both change an admitted-request contract, so neither belongs in a
      preflight milestone. Phase 4C-2A compares `providerName` and
      `providerModelId` only, and says so rather than claiming the table was
      revalidated. **Required before real provider spending ships.**
- [ ] **Phase 4C worker must fail closed when the source asset is missing or
      deleted.** `assetId` has no foreign key and assets may be removed under
      retention policy. A generation whose photo is gone is genuinely
      unexecutable and needs a normalized reason rather than a silent failure or
      a substituted image. **Required before Phase 4C ships.**
- [ ] **Phase 4C provider request construction must use the immutable
      `SceneGeneration` snapshot only.** Never the current `StoryboardScene`
      (recomposition deletes it) and never the project's current `aspectRatio`
      or `resolution` (both mutable after admission). Reading either could
      submit — and pay for — a request the customer never approved under the
      stored `requestHash` (ADR-0018 §3). **Required before Phase 4C ships.**
- [x] **Exactly one `CompiledPrompt` → provider prompt renderer may exist.**
      **Closed in Phase 4B-2b**: `renderPrompt` is that single implementation
      (ADR-0020), and Phase 4C-0a froze its output on the row so execution never
      re-renders (ADR-0023). Left unchecked until Phase 4C-1a's documentation
      sweep. The original entry follows.
      None existed at the time; Phase 4B-1c deliberately did not add one, storing
      the compiled prompt opaquely instead. The single implementation belongs at the
      provider boundary and must preserve ADR-0014's structural separation of
      preservation rules, system negatives, and user text. A second renderer
      anywhere is a defect. **Required before Phase 4C ships.**
- [ ] **PHASE 5 HARD PREREQUISITE — normalize the delivered video to the
      admitted `requestAspectRatio`.** The selected OpenVideo model documents no
      `aspect_ratio` parameter, so the capability is declared
      `COMPOSITION_OWNED` (ADR-0019): admission accepts and persists the
      requested ratio, and the provider is never asked for it. **Phase 5 is NOT
      complete while the product can accept a requested aspect ratio and
      silently deliver another one.** This is not an OpenVideo guarantee and must
      never be described as one. The admitted value is on the generation row as
      `requestAspectRatio` and needs no lookup.
- [ ] **Phase 4B-2b must render camera-motion intent into the positive prompt.**
      `cameraMotion` is declared `PROMPT_RENDERED` (ADR-0019 §8) because the
      model's documentation states the prompt controls motion. That declaration
      is a promise the type system cannot enforce; if 4B-2b does not render
      `CompiledPrompt.sceneFacts.cameraMotion`, the descriptor becomes a lie and
      must be changed to `UNSUPPORTED` instead.
- [ ] **WaveSpeedAI `preset` parameter — contract unresolved.** It appears in the
      official Quick Start example (`preset: "tuned"`) but not in the model's
      high-level parameter table, so its required/optional status and allowed
      values are unknown. Phase 4B-2a deliberately does **not** send it. Resolve
      against the authoritative API/schema material before any milestone adds it;
      an example is not a specification.
- [ ] **Earlier duration validation (UX follow-up, deliberately not done).**
      `DurationBounds` comes from the compose request body with no server-side
      clamp, so a caller can compose 1s or 30s scenes that only fail later at
      generation admission against OpenVideo's documented 3–20s range. Coupling
      Phase 3 composition to one provider's limits needs provider-aware
      composition, which the architecture does not have; admission remains the
      provider-specific authority. Revisit if the late failure proves confusing.
- [ ] **Replace the single-model environment check with a keyed descriptor
      registry.** Phase 4B-2a made `WAVESPEED_VIDEO_MODEL_ID` fail closed on any
      value other than `WAVESPEED_OPEN_VIDEO_MODEL_ID`, because a model id
      without a verified `VideoModelCapability` is an unvalidated request
      contract pointed at a paid endpoint. That is a **recorded deviation**
      (ADR-0019 §11): the variable is a configuration knob in name that accepts
      exactly one value. The exit path is a map from model id to verified
      descriptor, with the schema validated against the registry's keys instead
      of a single constant — adding a model then means adding a verified
      descriptor, and the check relaxes on its own with no further ADR. Admission
      selects by configured id; a persisted `providerModelId` resolves through
      the same registry, keeping the frozen-model invariant (ADR-0019 §10)
      unchanged. **Not built in 4B-2a**: with one model it would be speculative
      structure around a set of one. Belongs to whichever phase first has a
      second verified model to add.
- [x] **Pin the `PROMPT_RENDERED` camera-motion declaration to real renderer
      behaviour (Phase 4B-2b completion condition).** **Closed in Phase 4B-2b.**
      `renderPrompt` carries the requested motion into the prompt, and
      `capability.test.ts` asserts the descriptor's `cameraMotion` equals
      `PROMPT_RENDERED` *only if* the renderer demonstrably carries it and
      omits it when absent — so a renderer that stopped carrying motion would
      force the declaration to `UNSUPPORTED` rather than allow the test to be
      relaxed. Mutation-verified: removing the rendering fails 5 tests
      (ADR-0020 §3).
- [ ] **Managed-output reuse for an identical succeeded request.** Phase 4B-1a
      added `findLatestSucceededByRequestIdentity`, which prevents *automatic
      repeat spend* — but returning a succeeded attempt is not the same as
      returning a usable video. Reuse must additionally require a valid
      `outputStorageKey`, which nothing populates until Phase 4D. Until then,
      "reuse" means "do not silently pay again", not "here is your video".
      **Revisit in 4D.**
- [x] **The provider adapter sends fields the selected model may not accept.**
      **Closed in Phase 4B-2a** (merged as `be92596`). `mapToWaveSpeedRequest`
      now sends exactly `image`, `prompt`, `duration`, `resolution`, plus `seed`
      when supplied, pinned by an exact key-set assertion. `aspectRatio` was not
      dropped silently: it stays a request-identity and snapshot fact, and
      `AspectRatioSupport.COMPOSITION_OWNED` moves the delivery guarantee to
      Phase 5 composition, which is recorded above as a hard prerequisite.
      Phase 4B-2b then removed `negativePrompt` and `cameraMotion` from
      `ProviderGenerationInput` itself, so no unread field remains on the type
      that describes a paid request.

## Phase 4B-2b follow-ups

- [x] **The rendered prompt is not covered by the request hash (Phase 4C
      prerequisite).** **Closed in Phase 4C-0a**, and closed by pinning rather
      than by hashing. `requestRenderedPrompt` stores the exact provider prompt
      produced at admission; the worker submits it verbatim and never runs the
      renderer for an admitted attempt, so a renderer change applies to new
      admissions only. The 8-fact hash is deliberately unchanged — adding
      rendered bytes would break reuse and duplicate paid work (ADR-0023 §2).
      Nullable, never backfilled: a row predating the contract fails closed via
      `frozenExecutionPromptFrom` rather than being re-rendered with today's
      code. Mutation-verified.
- [ ] **Prompt length is unbounded and unmeasured.** Every generation carries
      roughly 600 characters of preamble before the customer's own words, which
      render last. The vendor publishes no `prompt` length limit, and no paid
      call may be made to discover one. If OpenVideo truncates or weights early
      tokens, the customer's styling request is the part most likely to be lost.
      Measurable in Phase 4C/4D once generations can be produced and compared;
      ADR-0020 records the reversal conditions rather than pre-emptively
      shortening the prompt and trading a product rule for unmeasured adherence.

## Business rules to confirm (later phases)

- [ ] Credit pricing model and platform margin (Phase 6).
- [ ] Plan definitions: users, storage, monthly credits, concurrency,
      retention, branding, support tiers (Phase 6 / SaaSOperations).
- [ ] Asset/output retention windows and deletion recovery period (Phase 2/5).
- [ ] Exact AI-generated disclosure text and placement rules beyond the default
      `AI生成イメージ` (Phase 5).
- [ ] Supported authentication providers (email vs Entra ID / Google) for
      Phase 1.

## Phase 0 interim choices to revisit

- [ ] Replace the interim operator-token auth (ADR-0004) with real identity,
      RBAC, and organization scoping (Phase 1).
- [ ] Introduce OpenTelemetry exporters; the Phase 0 logger is a local
      structured logger with redaction only.
