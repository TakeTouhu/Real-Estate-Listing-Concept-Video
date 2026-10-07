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
- [ ] **Provider-agnostic submission certainty is required before any paid
      submission.** 4C-3B-1 shipped diagnostic sanitization only (ADR-0031).
      The remaining work is a **common contract plus per-adapter evidence**, and
      the split matters — the original 4C-3B-2 design was written when WaveSpeed
      was the only provider, and it put a universal HTTP-status rule in the
      shared layer. That is no longer sound: since ADR-0033 the architecture is
      multi-provider, and a queue-based provider need not express certainty
      through HTTP status at all.

      **There is no ADR-0032 file, and none should be written.** The number
      appears in earlier prose as a placeholder for a decision that was planned
      but never recorded as an ADR — the earlier WaveSpeed-centric design exists
      only as superseded planning and as branch history on
      `claude/real-estate-virtual-tour-phase-4c3b2-hga252`. That branch is
      **read-only reference material**: it is not merged, rebased or
      cherry-picked wholesale, and any idea taken from it must be revalidated
      against the contract below before it counts as a decision. **This entry is
      the active specification.**

      **Common, provider-agnostic:**

      ```text
      ProviderSubmissionOutcome
        ACCEPTED
        DEFINITIVELY_REJECTED
        SUBMISSION_UNKNOWN
      ```

      The common contract carries **no universal HTTP-status allowlist**. Each
      adapter owns the evidence mapping its own provider's response and
      transport behaviour into these three outcomes, because only the adapter
      knows what its provider's responses mean.

      Invariants the common contract must preserve, whichever adapter is in play:

      - exactly one paid submission attempt;
      - no blind automatic POST retry;
      - an ambiguous submission is **never** represented as an ordinary
        retryable rejection;
      - retryability and submission certainty are separate concepts — a thing
        can be safe to retry, unsafe to retry, or unknown, and "unknown" is not
        a kind of "retryable";
      - transport and provider-response interpretation stays **inside** each
        adapter, never in the shared layer.

      **WaveSpeed adapter (approved, subject to re-verification when that work
      is rebuilt):**

      ```text
      400 -> DEFINITIVELY_REJECTED
      401 -> DEFINITIVELY_REJECTED
      403 -> DEFINITIVELY_REJECTED
      everything else after invocation -> SUBMISSION_UNKNOWN
      ```

      **The common contract and the WaveSpeed adapter are done** — Phase
      4C-3B-2C-1, ADR-0035. `createGeneration` returns
      `ProviderSubmissionOutcome`; the union carries no `retryable` and no HTTP
      status, both pinned at compile time; WaveSpeed allowlists 400/401/403
      through a closed switch with no exported backing array; 422 is **not**
      carried forward as definitive; malformed-2xx semantics, manual redirect
      handling, the 60 s submission timeout, exactly-one-POST evidence and
      fake-provider submission outcomes all landed.

      **The fal adapter is done too** — Phase 4C-3B-2C-2, ADR-0035 §7. Its
      classifier was established from fal's own published queue contract rather
      than inferred from WaveSpeed's, and the two deliberately differ: fal
      treats no remote status as definitive. Provider-neutrality is therefore
      demonstrated rather than claimed. The adapter is dormant and
      production-unreachable.

      Still unverified against the live fal API: endpoint, field names, native
      token and the `request_id` envelope all come from documentation, and must
      be re-verified before fal is enabled.

      **Persistence and reconciliation are still required before any provider
      charge is possible.**
- [ ] **`SUBMISSION_UNKNOWN` is representable but not survivable.** ADR-0035
      makes the ambiguous outcome expressible and stops it being silently
      re-POSTed; nothing yet persists it, reconciles it against the provider, or
      holds a credit reservation open while it is unresolved. Today the
      guarantee is that the system cannot silently re-charge — not that it can
      recover. `DEFINITIVELY_REJECTED` may fail an attempt and release its
      reservation; `SUBMISSION_UNKNOWN` must not, because a reservation released
      against work the provider is billing produces an unfunded charge. Required
      alongside submission audit persistence and the paid gate.
- [x] **Phase 4C-3B-2B — the resolution migration.** Done (ADR-0034). Request
      identity is versioned (`sha256:v2:`) over a twelve-element tuple carrying
      both resolutions plus the frozen delivery plan and the model key;
      `SceneGeneration` gained five all-or-none V2 snapshot columns that are
      never backfilled; `VideoProject.targetOutputResolution` is constrained to
      the product vocabulary at the API, UI, service and database boundaries,
      with the migration failing closed rather than rewriting a legacy value;
      `generationRequestFactsFrom` refuses a V1 row, a partial snapshot, a row
      carrying both vocabularies, and a snapshot disagreeing with its own hash
      version; `startScene` takes an optional `modelKey` with no fallback;
      preflight resolves the catalog by the attempt's own frozen key and refuses
      `MODEL_UNAVAILABLE` before signing; and the provider boundary carries
      `nativeGenerationResolution`. Follow-ups it did **not** do are listed
      below.
- [ ] **Nothing normalizes a delivered video to its target yet.** ADR-0034
      records `UPSCALE` / `DOWNSCALE` and performs neither, so an H3 Max 1080p
      deliverable would be a 768P generation at 768P. Phase 5 owns composition,
      and until it lands the product must not describe any `nativeMeetsTarget:
      false` output as native — the flag is persisted and audited so that claim
      is checkable, not so it can be ignored.
- [ ] **No customer-facing surface exposes `nativeMeetsTarget`.** It is on the
      row and in the audit log, but nothing shows a customer that the 1080p they
      asked for will be upscaled on the model they picked. Deciding where that
      disclosure belongs is a product question, and it is a prerequisite for
      offering model selection in the UI (there is no model selector yet — the
      argument exists on the service and has no HTTP or UI caller).
- [ ] **A catalog delivery-plan correction silently strands admitted rows.**
      Preflight now refuses them (`MODEL_DELIVERY_PLAN_CHANGED`, terminal), which
      is the safe outcome — but nothing tells an operator *before* they edit the
      catalog how many admitted attempts the edit would strand, and nothing
      reports them afterwards. A read-only reconciliation query over
      `scene_generations` against the current catalog is worth having before
      paid execution, and is a prerequisite for any routine catalog correction.
- [ ] **Verify MiniMax H3 and Veo 3.1 before either can be selected.** Both are
      in the catalog as `UNVERIFIED` with their missing items listed. H3 in
      particular is the model the product would want when native 1080p detail
      matters, and its documented native output ("2K") has no single reading in
      lines.
- [ ] **The paid gate may not be enabled until the WaveSpeedAI pricing contract
      is resolution-aware and verified.** Official pricing (2026-08-29) is
      resolution-dependent — 480p $0.02/s, 720p $0.04/s, 1080p $0.06/s, billed to
      a maximum of 20 seconds. The current `costPerSecondMinor` placeholder is
      one-dimensional and cannot represent it, so every reserved credit amount
      derived from `estimateCost` is wrong for 480p and 1080p. No `verified`
      boolean was added: a flag does not make the contract correct.
      **Required before gate enablement.**
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
      safe) with a real adapter behind the same `ObjectStorage` port before
      production launch (ADR-0008). Still required — the guard blocks production
      use, it does not provide durable storage.
      **Target settled (ADR-0054 Decision 1): a Google Cloud Storage adapter**,
      not S3 or Azure. The port is unchanged and the domain must not depend on
      Google Cloud SDK types. Note the carried-over work: Phase 5B solved
      absence-versus-permission semantics for S3 (`NoSuchKey` vs `AccessDenied`,
      and the `s3:ListBucket` prerequisite); the equivalent must be established
      against GCS's own error model before the composition probe can be trusted
      in production.
- [ ] Replace `PassthroughMalwareScanner` with a real scanning engine (ClamAV or
      an approved vendor) behind the `MalwareScanner` port. Still required — the
      guard blocks production use, it does not provide real scanning.
      **Decision recorded (ADR-0054 Decision 5): production malware scanning is
      mandatory and `PassthroughMalwareScanner` is not permitted in production.**
      Uploads stay quarantined until validation and scanning succeed, and failed
      or unscanned prohibited input is never sent to the AI Provider.
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
- [x] **Decide the near-duplicate UX (block vs warn).** **Settled by ADR-0052
      Decision 14: neither.** No customer-facing near-duplicate warning, no
      generation block, no Unit consequence. Visual similarity between photos is
      intentionally the customer's responsibility. Perceptual-hash and
      `duplicateOf` data may remain for internal engineering/quality analysis
      only, and no new near-duplicate UX may be added.
- [ ] **Remove the shipped near-duplicate UX that now contradicts ADR-0052
      Decision 14.** Implementation work, not a documentation fix. The Phase
      3B-3a/3b analysis-review surface clusters near-duplicates and permits only
      one member of a group to be approved, and the request carries a
      `primaryAssetId`. That is customer-facing near-duplicate behaviour and must
      be removed or neutralized before Commercial Launch. The Phase 3B records
      stay as historical evidence of what shipped.
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
      limited today. **Shape settled (ADR-0054 Decision 5):** defense in depth
      across account / organization / IP / endpoint, covering login, password
      reset, MFA recovery, uploads, generation, downloads and billing;
      progressive cooldown on login failure; a rate-limited request must not
      consume a Unit or cause a Provider POST; plan generation concurrency is a
      **separate** control from abuse limiting. The working value *5 failures /
      15 minutes* is a configurable starting point, **not** a commercial
      contract, and the production constants still need measured evidence. and Phase 3A-3 deliberately did not add it for the analysis
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
- [ ] **Unreferenced derivatives still need storage-side reconciliation.**
      **Partly closed in Phase 4C-3A-1** (ADR-0028 §8): when the final
      `PROCESSING -> READY` write loses **and the authoritative re-read shows
      durable deletion intent**, `completeUpload` deletes the normalized image
      and thumbnail it wrote, skipping any key that row references, and raises a
      sanitized `INTERNAL_ERROR` if a required delete fails.
      Two cases remain open. **A final-write loss without deletion intent
      deliberately deletes nothing** — ADR-0028 §8 has the reasoning: a one-time
      re-read cannot order a delete against a *future* owner of a deterministic
      key, and only monotonic deletion intent closes that. The second is a delete
      that throws on the deletion path.
      In both, the object is unreferenced **and the asset row does not name it**
      — the write that would have named it is the one that lost — so
      **row-walking retention cannot discover it**, and an earlier version of
      this entry was wrong to say the future retention worker would find it.
      Recovery requires storage-side reconciliation: a deterministic
      asset-prefix enumeration (`buildAssetStorageKey` makes the candidate keys
      derivable from the row even though the row does not carry them), or
      another durable cleanup mechanism. Not urgent — the objects are
      tenant-scoped and unreachable through any signed URL — but do not assume
      the retention worker covers it, and do not close this by making inline
      cleanup unconditional again.
- [ ] **A future in-place reprocessing feature invalidates the A-2 byte-stability proof.**
      ADR-0029 §6 proves that a `READY` asset's normalized object cannot be
      rewritten or removed by any currently implemented production path: the
      object is written by one statement inside `completeUpload`, both entry
      points accept only `PENDING_UPLOAD` and `FAILED`, the only exits from
      `READY` are `REJECTED` and `DELETION_PENDING`, upload credentials target
      the `original` variant, and the sole `deleteObject` caller is unreachable
      from `READY`. That is a statement about **today's code**, not a schema
      theorem, and only the two entry guards are pinned by a test.
      Any future feature that, for the **same** `MediaAsset` identity, permits
      `READY -> upload/retry/reprocess`, replaces normalized content in place,
      overwrites the deterministic normalized key, or physically deletes source
      content while a generation may still need it **must re-review paid
      submission safety before shipping**. Possible remedies at that point:
      versioned or content-addressed normalized keys, stronger retention
      ownership, or an explicit source lease. Do not implement any of them
      speculatively — the digest detects a changed source, it does not prevent
      one.
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

> This section predates the initial-release contract. Twenty-four further business
> rules — contract term, billing cadence, annual prepayment, cancellation/refund,
> upgrade/downgrade, permanent-failure settlement, operator recovery, support
> hours and targets, the role matrix, the recovery-budget denominator, grant
> ceilings and self-escalation, Normal/HQ Unit eligibility, `disclosure.none`
> grant authority, in-flight Mode C, commercial-mutation authority, the Clean
> Master, additional-seat cancellation, mid-period purchases, downgrade fit and
> charged-recomposition quality, logo-only recomposition, storage blocks, storage
> blocks on downgrade and Scope semantics — were settled later and are recorded under *Decision gates — CLOSED*
> below; still-open gates are under *Decision gates — OPEN*, just above it. Read all
> three places; none is the complete ledger on its own.

- [ ] **Unit pricing model and platform margin.** Selling prices are **settled
      by ADR-0053** (plans, per-Unit package multipliers ×1.20 / ×1.50, rounding
      to the nearest ¥100 but never into a loss). What remains open is the
      **margin control**: ADR-0054 Decision 3 deliberately does **not** fix a
      minimum gross-margin percentage, because no measured business decision has
      set one. Until it does, the Safety Guard can be built with its inputs and
      its decision point but not its threshold. Requires measured provider cost,
      Google Cloud variable cost, payment-processing cost and FX buffer.
- [x] **Plan definitions: users, storage, monthly Units, concurrency, retention,
      branding, support tiers.** **Settled by ADR-0053** (plans, Unit packages,
      storage quotas, payment channels, SLA, support tiers) and **ADR-0052**
      (concurrency 1/3/5, retention lifecycle, logo on all plans). One figure is
      explicitly provisional: additional storage at ¥1,500 / +50 GB must be
      validated against measured production cost and egress before Commercial
      Launch.
- [x] **Asset/output retention windows and deletion recovery period.**
      **Settled by ADR-0052 Decision 17:** source and normalized images while the
      property/project exists; scene videos 30 days after final completion;
      composition temp immediately; current final video until the customer
      deletes it; old final versions 30 days; customer-deleted content 30-day
      trash then physical deletion; Audit/Billing/Consent on the separate legal
      lifecycle of ADR-0053 Decision 7 (10/10/7 years).
- [x] **Exact AI-generated disclosure text and placement rules.** **Settled by
      ADR-0052 Decision 8.** Text: `本コンテンツは生成AIを使用して作成しています。`
      Mode A (default) whole video, bottom-right, white, no background box,
      subtle/low-opacity, ≈1.25% of video height, ≈3% right/bottom margin,
      scaling for landscape and portrait; Mode B first and last 2 seconds; Mode C
      omitted, gated by organization enablement + `disclosure.none` + per-video
      consent. The earlier `AI生成イメージ` label is superseded.
- [x] **Supported authentication providers.** **Settled by ADR-0052 Decision
      18:** the initial release is email/password with mandatory email
      verification, TOTP MFA and recovery codes, with MFA mandatory for `OWNER`,
      `ADMIN`, `permission.manage` and `billing.manage`. **Microsoft Entra ID SSO
      and Google SSO are post-release and explicitly retained on the roadmap**,
      together with organization-level SSO-required mode and possible
      password-login disablement for SSO-enforced organizations.

## Phase 0 interim choices to revisit

- [ ] Replace the interim operator-token auth (ADR-0004) with real identity,
      RBAC, and organization scoping (Phase 1).
- [ ] Introduce OpenTelemetry exporters; the Phase 0 logger is a local
      structured logger with redaction only.

## Phase 4C-3B-2G-1 — production stale-`SUBMITTING` threshold

`staleSubmittingAfterMs` — how long an attempt may sit at the provider boundary
before it is presumed lost — is **unresolved**. No default ships, deliberately:
the value depends on real provider latency distributions nobody has measured, and
a plausible-looking constant is how a guess becomes policy.

Too short and an ordinary slow provider response is mistaken for a dead worker,
converting a live paid submission into permanent uncertainty. Too long and a
genuinely crashed submission holds its reservation hostage.

Resolving it needs: observed p99 submission latency per provider and model, and a
decision about how much uncertainty the Safety Guard should carry while waiting.
A production caller must supply a validated `ReconciliationPolicy`; the domain
refuses to invent one. Tests use fixtures.

The reconciliation window itself is settled: configurable, at most 24 hours, and
the stale threshold must be **strictly** less than it.

## Phase 4C-3B-2G-2 — who supplies reconciliation evidence, and who runs the batch

Two unresolved items, both deliberately left open rather than guessed at.

**No producer exists for `ReconciliationResolutionObservation`.** The resolution
service consumes conclusive evidence; nothing yet obtains it. **The mechanism is
now DECIDED by ADR-0054 Decision 4** — authenticated webhook as the primary
low-latency path, **mandatory polling fallback** even when webhooks work, and
operator determination as break-glass evidence only; a webhook whose authenticity
cannot be verified is not authoritative and polling becomes the normal
authoritative path. **The producer itself is unbuilt**, and the polling cadence
and the provider's webhook authentication contract remain live-evidence gates.
What was already fixed, and is unchanged, is the *shape* it must normalize into:
two closed arms carrying a provider
reference or a retryability flag and a closed diagnostic code, with no HTTP
status, provider body, vendor enum, URL, credential or free text. A producer that
cannot express its finding in that shape has not established enough to resolve
anything, and should not call.

**Nothing schedules `runOnce`.** The batch runner exists and is deliberately not
a daemon: it does not loop, sleep, schedule itself or own a timer. Deciding what
does call it — cadence, concurrency across replicas, and what happens when a
batch overruns its interval — is an operational decision with its own failure
modes, and needs the stale-`SUBMITTING` threshold above resolved first, since the
same batch sweeps on it.

**Related and separate:** an exhausted attempt's provider cost stays `UNCERTAIN`
permanently, and no path converts it. None honestly can without provider-side
actual-cost ingestion. A cost-accounting pass over the audit record is the right
owner; the lifecycle deliberately does not guess.

## Phase 5A — what the deliverable composition plan deliberately leaves open

Four items, each deferred with a reason rather than omitted.

**The composition profile is not frozen.** No codec, bitrate, frame rate,
transition, audio mix, crop, padding, letterbox, watermark or interpolation
algorithm is decided, and `UPSCALE`/`DOWNSCALE` are not implemented. The *inputs*
to that decision exist — the job records `targetOutputResolution` and each
attempt records its native-generation normalization facts — but the decision
itself is a product commitment nobody has made. Recording a guess would store a
policy nobody chose, as if someone had. **Phase 5B owns it, and must freeze it
before any byte is produced.**

**Nothing executes a plan.** `COMPOSITION_PENDING -> COMPOSING` and
`COMPOSING -> DELIVERABLE_VALIDATING` are legal in the state machine, reserved
from the generic repository, and have no actor. There is deliberately no
candidate-discovery query either: a queue with nothing draining it suggests work
is happening that is not. Phase 5B supplies both, together with the `ffmpeg`
adapter behind a port.

**No unit is consumed, and `GenerationJob.currentDeliverableVersionId` is never
moved by planning.** Both belong to Transaction G at
`DELIVERABLE_VALIDATING -> DELIVERABLE_READY`. **Implemented by Phase 5C
(ADR-0051)**, and still dormant: the transaction exists, nothing calls it, and
the rule it was deferred for is the rule it now enforces — a unit is consumed
only in the commit that makes a validated deliverable the customer's, and a
recomposition consumes none at all. Until then the customer keeps the video they
already have.

**A deliverable version carries no metadata beyond its fingerprint.** Anything
else — encoder settings, output dimensions, the final object's digest — is not
authoritative at composition-admission time, and a column populated later with a
value invented now is worse than an absent column. Phase 5B/5C adds what it can
actually prove.

**Deliverable-level media validation does not exist.** ~~Scene-level validity
(ADR-0044/0045) says nothing about whether the composed video is playable.
`ManagedOutputMediaValidation` is bound one-to-one to a `SceneGeneration`, so a
final deliverable needs its own record or a widened binding; which of the two is
a Phase 5C schema decision and is not pre-empted here.~~ **Resolved by Phase 5C
(ADR-0051):** its own record, `GenerationDeliverableValidation`, one per
deliverable *version*. The binding was not widened — that would have made every
existing row's `sceneGenerationId` optional and every existing query ambiguous.
The media vocabulary is shared verbatim; only the table is new.

## Phase 5A follow-up — two unlocked reservation reads under a Job lock

`lockJobAndSceneForTenant` and `lockRevisionRollbackChain` in
`packages/database/src/orchestration-repositories.ts` read
`generation_reservations.state` through a `LEFT JOIN` while holding
`FOR UPDATE OF j, s` / `j, s, r`. Those are plain MVCC reads, not row locks, so
they cannot participate in a lock cycle and are **not** a deadlock concern.

They are recorded because they are the same *class* of hole Phase 5A closed in
Transaction I: an authority value read without the lock that makes it
authoritative. Revision start requires `reservationState === "CONSUMED"` and the
rollback requires it too, so in both cases a concurrent release between the read
and the commit would be acted on stale.

Not fixed here, deliberately — changing either one alters revision-start and
rollback behaviour, which belongs to the phase that owns them and needs its own
mutation evidence. Whoever picks it up should also decide whether the reservation
belongs in those statements' `FOR UPDATE OF` list, which would be the smallest
correct fix given the system-wide Reservation → Job order.

## Phase 5B follow-up — the questions `BLOCKED` deliberately leaves open

Phase 5B introduced a terminal-for-this-phase state and, deliberately, no way
out of it. Three decisions were owed. **Two are now answered** — the operator
path by ADR-0052 Decision 20 and settlement by ADR-0052 Decision 19 — and are
kept below as answered records. The third entry, retry-reason history, is an
engineering note about an audited table nobody has needed yet rather than an
owed product decision.

**~~There is no operator path out of `BLOCKED`~~ — ANSWERED by ADR-0052 Decision
20.** The question of who may unblock, and whether unblocking is per-row or
per-cause, is decided: recovery is an **internal operator privilege** no customer
role reaches, the terminal row and its `blockCode` / `blockedAt` stay immutable,
recovery creates a **new** cycle rather than re-queuing the old row, the
**authoritative mutation unit is the individual row**, and a global
"unblock this cause and revert all rows" operation is forbidden. The audit fields
are enumerated there. **The tooling is unbuilt** and tracked as implementation
work below.

**~~No settlement policy exists for a permanently uncomposable deliverable~~ —
ANSWERED by ADR-0052 Decision 19.** If no technically valid Deliverable was
delivered, the reservation is **RELEASED**, never `CONSUMED`, and must not sit
pending indefinitely; VTaVision bears the cost already incurred. A blocked
recomposition preserves the customer's previous video and releases the reserved
unit, and `BLOCKED` must not bill differently from `INVALID_MEDIA` or
`INTEGRITY_MISMATCH`. **The terminal settlement path is unbuilt** and tracked
below. No new state name is chosen here — that is state-machine design.

**Retry-reason history is not recorded.** `lastRetryCode` means exactly one
thing — why this work is currently deferred — so it is cleared on claim and on
block, and `attemptCount` is the only surviving evidence that earlier attempts
happened. If an operator ever needs to see *what* an attempt failed on three
tries ago, that is a separate audited table, not an overload of this column.

**A raised source-byte budget does not unblock what the old one refused.**
`MAX_DELIVERABLE_COMPOSITION_SOURCE_BYTES` is a deployment constant; a row
blocked with `SOURCE_BYTES_LIMIT_EXCEEDED` under the old value stays blocked
after it is raised, because nothing re-evaluates a blocked row. Whoever raises it
needs the operator path above first.

## Phase 5B follow-up — `s3:ListBucket` is a production-activation prerequisite

**Recorded, not wired. Blocks nothing until AWS storage is activated.**

The deliverable canonical probe distinguishes "nothing published here yet" from
"could not read" by normalizing AWS `NoSuchKey` into the object-store seam's
absence shape. That normalization only works if AWS actually returns `NoSuchKey`.

Without `s3:ListBucket` on the managed bucket and prefix, AWS returns
`AccessDenied` (403) for a key that simply does not exist. The application cannot
tell that apart from a genuine permission fault, so it stays `RETRYABLE_FAILURE` —
correct, but it means a fresh deliverable would defer forever and composition
would never start.

So whoever wires production AWS storage must grant the production S3 principal the
minimum `s3:ListBucket` permission for the managed bucket and prefix, and confirm
that a missing managed-output key returns `NoSuchKey` rather than `AccessDenied`
before enabling the composition runner.

Nothing in this phase creates a credential, an IAM resource, a bucket or a
scheduler, and `createS3MultipartClient` is still constructed nowhere in
production. This note exists so the requirement cannot be lost between here and
Phase 9.

## Phase 5C follow-up — what a terminal verdict deliberately leaves open

Phase 5C makes a deliverable's usability durable and publishes only on `VALID`.
Four decisions were owed. **None is still owed by this section.** Three have
been answered and are kept below as records rather than deleted: human review
before publication by **removal** (ADR-0052 Decision 2), settlement of an
unusable deliverable (ADR-0052 Decision 19), and the operator path out of a
terminal verdict (ADR-0052 Decision 20). The fourth,
`RECONCILIATION_HOLD -> CONSUMED`, is an **admitted policy** carrying a revisit
condition, not an open decision. Open product gates are listed in one place
only, under *Decision gates — OPEN*.

**~~Human review before publication is still missing~~ — SUPERSEDED by ADR-0052
Decision 2.** This item was written when `CLAUDE.md` required that AI output is
never published automatically and that human review and approval are mandatory.
That rule is no longer the product contract: there is **no final-video approval
workflow** in the initial release, because Transaction G delivers into the
customer's own private workspace and VTaVision performs no external publication.
Transaction G therefore needs **no approval gate**, and the absence of one is not
a defect to repair before activation.

The obligation this item was really protecting has not disappeared — it has
changed owner. What must stand between a validated deliverable and the customer
is the **AI-generated disclosure** (ADR-0052 Decision 8), which is unbuilt and is
tracked as implementation work below. Do not re-derive an approval gate from this
paragraph; it is kept as the record of a superseded decision, not as live work.

Still live from the original concern: **a deliverable that nobody ever looks at
is now a normal outcome, not an error state.** A delivered video the customer
never previews or downloads has still consumed its Unit (ADR-0052 Decision 4),
and no state machine should wait for a human that the contract no longer
requires.

**~~No settlement policy exists for a permanently *unusable* deliverable~~ —
ANSWERED by ADR-0052 Decision 19**, identically to its Phase 5B sibling. An
`INVALID_MEDIA` or `INTEGRITY_MISMATCH` verdict must **terminally settle and
RELEASE** the reserved unit; the customer consumes no Unit, keeps any previously
delivered valid video, and the internal failure class does not change the bill.
VTaVision bears the cost already incurred. **Unbuilt**, tracked below.

**~~There is no operator path out of a terminal verdict~~ — ANSWERED by ADR-0052
Decision 20**, on the same terms as `BLOCKED`. The instinct recorded here was
right and is now the rule: re-validating immutable bytes against a frozen receipt
would reach the identical answer, so **the only recovery is a new composition
cycle**, initiated by an authorized internal operator, audited, per row, leaving
the original verdict untouched. **Unbuilt**, tracked below.

**`RECONCILIATION_HOLD -> CONSUMED` is admitted, and the alternative should be
revisited if reconciliation policy changes.** A validated deliverable the customer
is about to receive is treated as sufficient evidence to settle a hold, because
deferring instead risks a deliverable that can never be published if the hold
later resolves to `RELEASED`. If reconciliation ever gains a resolution that
*should* override a completed delivery, this branch is where that decision lands.

## Phase 5C follow-up — the AI-generated disclosure is still unrendered

**Recorded, not wired.** `CLAUDE.md` requires generated videos to display an
AI-generated disclosure by default. Composition profile v1 renders no overlay,
no watermark and no end card, and deliverable validation does not check for one —
it measures container, duration, dimensions and stream counts, and asserts
nothing about what the frames contain.

So the disclosure is unimplemented at every layer that could carry it: the
encoder does not draw it, the verdict does not require it, and publication does
not gate on it. Whoever activates publication owns closing that gap.

**The placement rules are no longer open.** ADR-0052 Decision 8 fixes the exact
text, the three modes and Mode A's geometry, so this is implementation work
against a settled specification — not a decision still to be made. The earlier
cross-reference to *Business rules to confirm* is stale; that item is closed.

## Initial-release contract — implementation and evidence gates (ADR-0052/0053/0054)

The product, commercial and production decisions are **settled**. Almost none of
them is **built**. Each item below records the settled decision and what remains.

### Implementation work — decision settled, nothing built

- [ ] **Render the AI-generated disclosure.** Settled: ADR-0052 Decision 8 fixes
      the text, the three modes and Mode A's geometry (bottom-right, white, no
      box, subtle, ≈1.25% of height, ≈3% margin, scaling for both orientations).
      Unbuilt at every layer: composition profile v1 draws no overlay, the
      deliverable verdict does not require one, and publication does not gate on
      one. This is a required initial-release feature, not a nicety.
- [ ] **Build Mode C gating and consent.** Organization-level enablement,
      `disclosure.none`, per-video consent with two affirmative checkboxes, and
      the consent evidence record (`organizationId`, `userId`, target,
      `disclosureMode = NONE`, `consentTextVersion`, `consentedAt`,
      organization-level enablement state) retained 10 years. Organization
      enablement must **not** be treated as authorizing any user on its own.
- [ ] **Treat `disclosure.none` as `OWNER`-only protected authority.** ADR-0052
      Decision 10. Reject every grant or revoke attempt by `ADMIN` or any lower
      role — including an `ADMIN` acting on itself — as a refused, audited
      authorization change rather than a silent no-op.
- [ ] **Make `disclosure.none` individual-only in representation and
      enforcement.** No group permission, group inheritance, role template or
      Scope expansion may carry it, and the model should make that impossible
      rather than merely unused, so no indirect path — group membership, group
      edit, role change or Scope change — can confer it.
- [ ] **Audit every `disclosure.none` grant and revocation** with the
      organization, affected user, acting `OWNER`, action and timestamp.
- [ ] **Enforce prospective revocation for new Mode C requests.** A revoked user
      cannot initiate a new Mode C generation or recomposition; revocation
      deletes no consent evidence, modifies no completed deliverable, and removes
      no audit history.
- [ ] **Persist and freeze the admitted generation's disclosure contract.**
      ADR-0052 Decision 10: disclosure mode, Mode C consent, and the
      `disclosure.none` and organization-level eligibility used at admission are
      captured immutably with the job. Reject mutation of an in-flight job's
      disclosure/logo output settings; apply later permission and organization
      changes only to newly admitted generations. No pre-delivery re-check and no
      automatic C → A fallback.
- [ ] **Build disclosure-mode change accounting.** Recomposition, not
      regeneration. Three free changes per content video, then 1 Unit per further
      block of three; the initial selection is not a change; the count increments
      only on a successfully produced new deliverable; `A → B → A` is two.
- [ ] **Build the company logo pipeline.** One organization-level logo,
      OWNER/ADMIN managed, PNG/WebP with transparency, per-video ON/OFF default
      ON, placed clear of the disclosure, scaled to output dimensions, applied by
      recomposition. No forced VTaVision watermark.
- [ ] **Build the authorization model.** Groups, Scope
      (`ORGANIZATION`/`GROUP`/`OWN`), optional individual permissions, additive
      group permissions, no DENY, the six role templates and the full permission
      list. `video.share` is reserved and must not be exposed. At least one
      `OWNER` must always exist and the last `OWNER` cannot be deleted. **No
      longer blocked on the matrix:** the per-template permissions and default
      Scopes, the grant ceilings and the `disclosure.none` rules are all
      approved in ADR-0052 Decision 10, as are the Scope predicates. Changing a
      Property's responsible user or group remains blocked on the open gate
      above. What remains is implementation, itemized below — the grant
      matrix, ceiling enforcement on every grant path, self-escalation
      prevention, authorization-change audit, and the `disclosure.none` items.
- [ ] **Build user and group deletion.** `active`/`deleted` only — no suspension
      state, no restore. On user deletion: immediate access stop; 30 days of
      admin-only inspection of that user's videos; then physical deletion of all
      of them including old versions; other users' videos for the same property
      survive; legally retained evidence survives. On group deletion: users
      become ungrouped, lose only group-granted permissions, content returns to
      organization root.
- [ ] **Build the 30-day trash lifecycle** for properties, projects, images and
      videos, with the in-trash restrictions (no generate/regenerate, no
      disclosure change, no upload, no edit; preview/download still allowed when
      authorized) and no counter resets on restore.
- [ ] **Build storage quota accounting and thresholds** (80% / 90% / 100%), with
      the correct inclusion rules: count retained source images, normalized
      images and the current final video; exclude internal scene media,
      the internal Clean Master, composition temp, 30-day retained old versions
      and Audit/Billing records. No automatic deletion, no automatic overage
      charge.
- [ ] **Produce and store a durable overlay-free Clean Master** at final
      composition (ADR-0052 Decision 17) and produce every customer deliverable
      from it by applying the disclosure/logo layer. Retain and delete it with
      its content's lifecycle, including trash/recovery and legal hold; never
      expose or allow download of it; and support disclosure/logo recomposition
      after scene-video deletion with **no provider call**.
- [ ] **Build the internal service-recovery budget.** `base-plan included-user
      slots × 1` → **3 / 10 / 30** per organization per renewal period, from base
      plan slots — **not** active users and **not** purchased additional seats —
      shared organization-wide, never exposed. On exhaustion: stop automatic
      recovery, charge no further Unit, release the reserved Unit, escalate
      internally, allow one operator-granted manual free recovery.
- [ ] **Build Unit accounting per ADR-0053.** Added packages as non-carrying
      blocks; the eligibility-first consumption order (see the two items below);
      renewal-period binding to the reservation; no automatic overage;
      customer-approved
      purchase; no cancellation after a paid Provider submission.
- [ ] **Build a quality-tagged additional-Unit ledger.** ADR-0053 Decision 2.
      Each add-on block carries the quality it was bought at, and the ledger must
      be able to **refuse** an ineligible block rather than treat added Units as
      one pool. No conversion, exchange, refund or substitution path may exist.
- [ ] **Build eligibility-first reservation and consumption.** ADR-0053
      Decision 3: eligible Base Unit → oldest eligible add-on → newest eligible
      add-on, FIFO *within* the eligible quality class, with the included HQ
      ceiling (1 / 5 / 10) enforced as a counter **inside** the Base pool. An HQ
      request with no eligible entitlement must fail cleanly and legibly —
      reserving nothing, consuming nothing, and never falling back to a Normal
      block.
- [ ] **Build project rename, settings change and deletion**, with changed
      settings treated as new generation conditions and existing outputs retained
      as historical versions.
- [ ] **Build the Google Cloud Storage adapter** behind the existing
      `ObjectStorage` port, without the domain depending on Google Cloud SDK
      types, and establish GCS's absence-versus-permission semantics as the S3
      equivalent was established in Phase 5B.
- [ ] **Remove `REVIEWER` from the role vocabulary** where it survives in code
      or schema, and confirm nothing gates final-video delivery on an approval.
      Source-photo review becomes `analysis.review`.
- [ ] **Build the approved role-template grant matrix.** ADR-0052 Decision 10 now
      fixes every template's grants and default Scope. Decide whether defaults are
      stored as rows or derived from the matrix, and make a stored copy
      reproducible from it. `disclosure.none` and `video.share` must be
      unreachable by role assignment alone, and MFA enforcement must stay
      capability-based so `BILLING` is covered through `billing.manage`.
- [ ] **Enforce the role grant ceilings and protected authority.** ADR-0052
      Decision 10. Every authorization mutation must answer "may *this actor*
      grant *this*?", not merely "does the actor hold `permission.manage`?":
      `OWNER` assigns any role, `ADMIN` only `MANAGER`/`CREATOR`/`VIEWER`, and
      `permission.manage` / `billing.manage` / the `OWNER`,`ADMIN`,`BILLING` role
      assignments / ownership-equivalent changes / anything touching the last
      `OWNER` are `OWNER`-only.
- [ ] **Prevent self-escalation across every grant path.** Direct role change,
      individual grant, group membership, group permission and Scope
      manipulation must each be ceiling-checked — the additive group model is the
      obvious loophole and must not be one. A refused escalation attempt is an
      audited event, not a silent no-op.
- [ ] **Audit every role, permission, Scope and group authorization change**,
      recording the acting user, so a ceiling violation is both preventable and
      detectable after the fact.
- [ ] **Build permanent technical-failure terminal settlement.** ADR-0052
      Decision 19. A failed initial generation, paid regeneration or
      disclosure/logo recomposition must terminally settle and **RELEASE** the
      reservation, never `CONSUMED` and never left pending; a failed regeneration
      or recomposition must preserve the previous valid deliverable as current; a
      failed recomposition must not increment the disclosure-change count; and
      `BLOCKED` / `INVALID_MEDIA` / `INTEGRITY_MISMATCH` must settle identically
      for billing. Includes choosing whether an existing domain state represents
      this or a new one is required — **the ADR deliberately does not pick one.**
- [ ] **Build operator recovery tooling.** ADR-0052 Decision 20 plus ADR-0054
      Decision 6: an internal-only privilege reachable by no customer role, the
      original `BLOCKED` row and terminal verdict left immutable, a **new**
      recovery cycle rather than a re-queue, the enumerated audit fields, and
      per-row transactional/CAS-safe action with per-row eligibility
      re-evaluation. **No global per-cause revert.**
- [ ] **Build subscription billing, cancellation and plan changes.** ADR-0053
      Decisions 1A, 3A and 3B: monthly Stripe recurring billing with automatic
      renewal; cancellation effective at period end with no proration; the refund
      exceptions that remain owed; immediate upgrade charging the full unprorated
      difference with the base-Unit ceiling **replaced minus Base Units consumed**;
      downgrade at renewal, schedulable only once membership fits, with no
      deletion of content or users and no automatic seat purchase; and
      sales-assisted Enterprise transitions represented without
      a Stripe subscription object.
- [ ] **Enforce `billing.manage` on every commercial mutation** (ADR-0053
      Decision 5A): Unit packages, seats, storage add-on, upgrade, downgrade,
      cancellation, and any other charge-changing action. `ADMIN`'s
      `billing.view` must not authorize any of them, and any existing storage
      add-on authorization built on the superseded "OWNER/ADMIN" rule must be
      reconciled.
- [ ] **Separate member management from seat purchase, and forbid implicit
      charges.** Adding a member when no seat remains must fail and require an
      explicit seat purchase by a `billing.manage` holder; reaching the storage
      limit must never auto-purchase storage; no member-management or upload
      action may create a charge implicitly. Explicit commercial actions remain
      available to any `billing.manage` holder, including an `ADMIN` an `OWNER`
      has explicitly granted it.
- [ ] **Build mid-period add-on purchase** (ADR-0053 Decision 5A): immediate
      seat and storage entitlement activation, first-period proration, renewal
      transition to the full monthly amount, and purchase audit/evidence.
- [ ] **Build downgrade scheduling with the membership-fit rule** (ADR-0053
      Decision 3B): validate membership against the next-period entitlement
      before scheduling, warn the administrator how many users must be removed,
      block member growth past the pending entitlement, recalculate when the
      downgrade is cancelled or changed, and never select, delete or deactivate
      users or buy seats.
- [ ] **Distinguish free from charged recomposition** (ADR-0052 Decisions 9
      and 13): no Unit reservation or consumption for logo-only changes or
      disclosure changes 1–3; a combined disclosure + logo change counted once;
      validation must never turn a free recomposition into a charge.
- [ ] **Build Property-rooted Scope enforcement** (ADR-0052 Decision 10):
      durable Property → responsible user and Property → zero-or-one group
      relationships and user → group memberships; the `GROUP` union predicate
      and the `OWN` assignment predicate; child-resource reachability inherited
      from the Property; reassignment and membership-change effects; no
      authorship-based row authorization; no implicit scope widening through
      individual grants; tenant-safe row-level checks throughout.
- [ ] **Validate storage blocks on downgrade** (ADR-0053 Decision 3B): refuse
      to schedule a downgrade while next-period blocks exceed the target cap;
      require explicit scheduled cancellation of the excess; while the downgrade
      is pending, reject any block purchase or cancellation reversal that would
      push next-period blocks over the target cap; never cancel blocks or the
      downgrade automatically; compute next-period entitlement; apply the existing
      over-quota rule to actual bytes after renewal.
- [ ] **Build repeatable storage blocks** (ADR-0053 Decision 4): block-count
      representation; recurring charge = active blocks × price; immediate
      prorated block purchase; per-plan cap enforced at purchase (Standard 2 /
      150 GB, Premium 5 / 450 GB; Enterprise contract-governed, no guessed
      constant); per-block renewal cancellation; quota re-evaluation after any
      block or plan change; over-quota data retained, never auto-deleted.
- [ ] **Build quality-aware charged disclosure recomposition** (ADR-0052
      Decision 9): preserve the original video's quality, apply the
      eligibility-first order for it, count Base Units used for HQ against the
      HQ ceiling, and refuse the charged change when no eligible Unit exists.
- [ ] **Build scheduled additional-seat reductions** (ADR-0053 Decision 5A):
      validate current membership against the post-cancellation entitlement
      before scheduling; block member additions and invitations past the pending
      next-period entitlement; transition the seat quantity at renewal with no
      proration; audit the commercial mutation; and never silently remove or
      deactivate members or repurchase seats. Enterprise changes route to the sales-assisted path rather than
      changing a contract amount automatically.
- [ ] **Build the authenticated-webhook producer and the mandatory polling
      fallback** for `ReconciliationResolutionObservation` (ADR-0054 Decision 4),
      with verification, replay safety, deduplication, tenant resolution from
      stored prediction records, and normalization into the provider-neutral
      contract before any durable mutation. Polling must run even when webhooks
      work, and must be restart-safe.
- [ ] **Build support tooling for the approved response targets** (ADR-0053
      Decision 11) — enough inquiry tracking to measure an initial response
      against staffed hours and business days, without attaching the uptime SLA
      credit schedule to it.

### Decision gates — OPEN

One gate, exposed while recording the Scope predicates. **It must not be
guessed.**

- [ ] **Decide who may set a Property's responsible user and group, and what
      they are at creation.** ADR-0052 Decision 10 settles what `OWN` and `GROUP`
      select, but names no permission or scope that authorizes changing a
      Property's responsible user or group assignment (Decision 11 only lets
      `OWNER`/`ADMIN` reassign Properties left ungrouped by a group deletion),
      and does not fix the assignments at creation. An `OWN`-scoped `CREATOR` or
      `GROUP`-scoped `MANAGER` could otherwise lose reach to a Property they just
      created, and a `CREATOR` able to set a group could share a Property with a
      whole group. Recorded at ADR-0052 Decision 10.

### Decision gates — CLOSED

Twenty-four decisions: the two gates from the first PR review, eight recorded
with them, the two raised by the exact-head review of those closures, the
`disclosure.none` grant authority that synchronizing the grant ceiling exposed,
in-flight Mode C, commercial-mutation authority, the Clean Master,
additional-seat cancellation, mid-period purchases, downgrade fit,
charged-recomposition quality, logo-only recomposition, repeatable storage
blocks, and the two closed last — storage blocks on downgrade and Scope
semantics. **Each is settled as policy and unbuilt as code**; the
implementation work each one creates is listed in the section above.

- [x] **Scope semantics — CLOSED.** The **Property is the authorization root**;
      children inherit its reachability, with no authorship-based ownership.
      `ORGANIZATION` = every Property in the organization (never cross-tenant);
      `GROUP` = Properties assigned to **any** of the actor's groups (union; a
      Property has zero or one group; ungrouped Properties are not reachable
      through `GROUP`); `OWN` = Properties **explicitly assigned** to the actor
      as responsible user — not created/uploaded/requested-by. Reassignment and
      membership changes take effect through the Property; audit history is not
      rewritten. Individual grants never widen scope. ADR-0052 Decision 10.
- [x] **Storage blocks on downgrade — CLOSED.** Premium → Standard cannot be
      scheduled while next-period blocks exceed 2; a `billing.manage` holder
      must explicitly schedule cancellation of the excess. Nothing is cancelled
      automatically. Only the block count must fit — stored bytes over quota
      after renewal keep the existing no-delete rule. Downgrade and block
      cancellation are separate mutations. ADR-0053 Decision 3B.
- [x] **Logo-only recomposition — CLOSED.** **Free**: no Unit reserved or
      consumed, no disclosure-change count increment; still validated before
      delivery, and a failure keeps the previous deliverable. A disclosure +
      logo change in one operation is **one** disclosure change; logo never adds
      a Unit. ADR-0052 Decisions 9 and 13.
- [x] **Storage add-on quantity — CLOSED.** A **repeatable +50 GB block**,
      charged at active blocks × ¥1,500/month. Caps keep each plan below the
      next plan's base: **Standard max 2 blocks / 150 GB**, **Premium max 5 /
      450 GB**, enforced by rejecting the purchase. Enterprise has no
      tier-derived cap and no invented maximum — its ceiling is contractual and
      Safety-Guard governed, not "unlimited". Cancellation is per block at
      renewal, no refund, no deletion. ADR-0053 Decision 4.
- [x] **Mid-period seat / storage add-on purchase — CLOSED.** Usable
      **immediately**, first charge **prorated** for the rest of the period,
      full monthly price from the next renewal; requires `billing.manage`;
      nothing auto-purchased. Cancellation unchanged (renewal-effective, no
      prorated refund). The storage add-on **is initial-release scope**; only its
      price is provisional. ADR-0053 Decision 5A.
- [x] **Downgrade over capacity — CLOSED.** A downgrade never takes effect in
      the current period and is **schedulable only once current membership fits**
      the next-period entitlement (target plan's included users plus remaining
      additional seats). Otherwise the administrator is warned how many users
      must be removed; nothing is selected, deleted or deactivated and no seat
      is bought. While pending, member growth past that entitlement is blocked,
      so renewal cannot arrive over capacity. ADR-0053 Decision 3B.
- [x] **Charged disclosure-recomposition Unit quality — CLOSED.** Uses the
      **original video's quality**, through the same eligibility-first order;
      a Base Unit used for HQ counts against the HQ ceiling; with no eligible
      Unit the charged change is **not performed** — no cross-quality use, no
      conversion, no free change. Failure settlement unchanged. ADR-0052
      Decision 9.
- [x] **Additional-seat cancellation — CLOSED.** Effective at the **next
      renewal**, never immediately; **no proration**; current-period seats stay
      usable. A reduction may be scheduled **only if current membership already
      fits** the post-cancellation entitlement; while it is pending, member
      growth past the next-period entitlement is blocked; at renewal the seat
      quantity drops and billing follows. No member is ever silently removed or
      deactivated and no seat is repurchased automatically. Enterprise follows
      its contract. ADR-0053 Decision 5A.
- [x] **Mode C in-flight behaviour — CLOSED.** Mode C conditions are **frozen at
      generation admission**. The admitted job's disclosure mode, Mode C consent,
      and the `disclosure.none` and organization-level eligibility used to admit
      it are immutable through delivery. Revoking `disclosure.none` or disabling
      organization-level Mode C while it runs affects **only generations admitted
      afterwards**: no pre-delivery re-check, no automatic C → A fallback, no
      Unit release for a later authorization change. ADR-0052 Decision 10.
- [x] **Commercial-mutation authority — CLOSED.** Any customer action that
      changes what the organization is charged requires **`billing.manage`** —
      `OWNER`/`BILLING` by default; `ADMIN` only via an explicit `OWNER` grant, never
      by role. Covers Unit packages, seats,
      the storage add-on (superseding "OWNER/ADMIN purchase and cancel"),
      Standard/Premium upgrade, downgrade and cancellation. Member management is
      separate from seat purchase and never creates a charge; nothing is
      auto-purchased; Enterprise stays sales-assisted; organization deletion is
      not a billing action. ADR-0053 Decision 5A.
- [x] **Recomposition after scene-video deletion — CLOSED.** One overlay-free
      **Clean Master** per deliverable — no burned-in disclosure or logo — is
      retained with its content's lifecycle (trash/recovery included, deleted at
      final physical deletion, subject to legal hold). Scene videos still delete
      after 30 days. The Clean Master is internal, excluded from customer quota,
      not customer-downloadable, consumes no Unit and is not billed. Later
      disclosure/logo changes recompose from it with **no provider call**.
      ADR-0052 Decision 17.

- [x] **`disclosure.none` grant authority — CLOSED.** A **protected permission**
      with **`OWNER`-only** grant and revoke authority. `ADMIN` may not grant,
      revoke, self-grant, or obtain it indirectly through its own
      authorization-management actions, and no lower role may grant or revoke
      it. It is **individual-only**: never via group permission, group
      inheritance, a role template or implicit Scope expansion, so group-based
      authorization is never a route to it. An `OWNER` may grant it to
      themselves, another `OWNER`, an `ADMIN` or another eligible individual
      user; holding it is a **use** privilege, not a delegation privilege. Mode C
      stays three-gate, organization enablement stays `OWNER`/`ADMIN` and
      authorizes no one by itself, and **no dual control** is required. Grant and
      revoke are audited (organization, affected user, acting `OWNER`, action,
      timestamp). **Revocation is prospective**: new Mode C initiations blocked;
      consent evidence, completed videos and audit history untouched. Always
      exercised by a mandatory-MFA actor; no step-up mechanism invented. ADR-0052
      Decisions 8 and 10.
- [x] **Grant authority and privilege self-escalation — CLOSED.**
      `permission.manage` is authority **within a grant ceiling**, not unlimited
      delegation. `OWNER` may assign every role; **`ADMIN` may assign only
      `MANAGER`, `CREATOR`, `VIEWER`** and may not assign or promote to `OWNER`,
      `ADMIN` or `BILLING`; `BILLING`/`MANAGER`/`CREATOR`/`VIEWER` have no
      role-assignment authority by default. **`OWNER`-only protected authority:**
      granting/revoking `permission.manage` and `billing.manage`,
      assigning/removing `OWNER`/`ADMIN`/`BILLING`, ownership-equivalent changes,
      and any operation affecting the last `OWNER`. **No self-escalation past the
      ceiling by any route** — direct role change, individual grant, group
      membership, group permission or Scope manipulation. `ADMIN` specifically
      cannot self-grant `billing.manage`, cannot re-grant `permission.manage`
      across the boundary, and cannot promote itself to `OWNER` or into
      `BILLING`. MFA rules unchanged and still capability-based, so `BILLING`
      stays mandatory-MFA. ADR-0052 Decision 10.
- [x] **Normal/HQ quality eligibility in the consumption order — CLOSED.**
      Add-on Units are **quality-locked**: a Normal add-on is Normal-only, an HQ
      add-on is HQ-only, and **nothing creates fungibility** — not price, not
      expiry pressure, not customer preference, and there is no conversion,
      exchange, refund or substitution. The order is **eligibility-first**:
      eligible Base Unit → oldest eligible add-on → newest eligible add-on, with
      FIFO applying **within** the eligible quality class, so skipping an
      ineligible block is not a FIFO violation. HQ may draw a Base Unit only
      while the plan's included HQ ceiling (**1 / 5 / 10**, *inside* the Base
      pool) remains. Standard cannot buy HQ add-ons, so a Standard organization
      that has spent its one included HQ entitlement has **no further HQ route**
      that period. ADR-0053 Decisions 2 and 3.

- [x] **Role-template permission and default-Scope mapping — CLOSED.** The
      approved matrix and each template's default Scope are ADR-0052 Decision 10.
      Each template's grant list there is exhaustive. `disclosure.none` and
      `video.share` are granted by no template; `permission.manage` is `OWNER` /
      `ADMIN`; `billing.manage` is `OWNER` / `BILLING`; `unit.consume` is
      `OWNER` / `ADMIN` / `MANAGER` / `CREATOR`. `BILLING` is MFA-mandatory as a
      consequence of holding `billing.manage`, not as a separate rule.
- [x] **Recovery-budget denominator — CLOSED.** Purchased additional seats do
      **not** raise it. `base-plan included-user slots × 1` → 3 / 10 / 30 per
      organization per renewal period, invariant to active users, purchased seats,
      purchased Units and temporary membership changes (ADR-0052 Decision 5).
- [x] **Standard/Premium contract term and billing cadence — CLOSED.** One-month
      auto-renewing, monthly Stripe billing, no minimum commitment. Enterprise is
      individually agreed (ADR-0053 Decision 1A).
- [x] **Annual-prepayment policy — CLOSED.** Not offered for Standard/Premium in
      the initial release, and **there is no platform-wide rule granting 5% (or
      any percentage) for annual prepayment.** Enterprise discounts are
      individually approved contract terms.
- [x] **Cancellation and refund baseline — CLOSED.** Standard/Premium
      cancellation is effective at period end, no proration, unused base and
      purchased Units not refunded, customer-choice cancellation is not a refund
      event. **Not a blanket no-refund clause:** duplicate billing, VTaVision
      billing errors, legally required refunds and applicable contractual
      remedies remain owed (ADR-0053 Decision 3A).
- [x] **Self-service plan upgrade/downgrade semantics — CLOSED.** Upgrade
      immediate, full unprorated price difference, base Units **replaced by the
      new ceiling minus Base Units consumed** (never stacked), purchased packages keep their
      original period. Downgrade at next renewal, no refund, no content deletion,
      no silent user deletion and no automatic seat purchase — and, as closed
      later, schedulable only once membership fits (ADR-0053 Decision 3B).
- [x] **Permanent technical-failure settlement — CLOSED.** No technically valid
      Deliverable delivered ⇒ reservation **RELEASED**, never `CONSUMED`, never
      left pending; VTaVision bears the incurred cost; failure class does not
      change the bill (ADR-0052 Decision 19).
- [x] **Operator recovery semantics — CLOSED.** Internal operator privilege only,
      no customer role reaches it, terminal evidence immutable, recovery creates a
      new cycle, per-row mutation with per-row re-evaluation and audit, no global
      per-cause revert (ADR-0052 Decision 20; privilege under ADR-0054
      Decision 6).
- [x] **Support staffed hours and initial-response targets — CLOSED.** Weekdays
      10:00–18:00 JST excluding weekends, Japanese public holidays and the
      year-end/New Year closure; targets 2 business days / 1 business day / 4
      staffed hours / 1 business day. **Support SLOs, not SLA service credits**,
      and Sev1 monitoring outside hours is not 24/7 staffed support (ADR-0053
      Decision 11).
- [x] **Reconciliation evidence-source architecture — CLOSED.** Authenticated
      webhook primary, **mandatory polling fallback**, operator evidence
      break-glass only, all normalized into the provider-neutral contract; an
      unverifiable webhook is not authoritative evidence (ADR-0054 Decision 4).

### Implementation deltas — runtime code disagrees with the approved contract

Not documentation problems, and **not fixed by editing documentation.** Each must
be reconciled in a runtime work package.

- [ ] **The runtime pricing code assumes every plan is a 12-month contract with a
      5% annual-prepayment discount.** `customer-plan-catalog.ts` defines
      `CONTRACT_MONTHS = 12` and `ANNUAL_PREPAYMENT_DISCOUNT_BPS = bps(500)`, and
      `customer-pricing.ts:annualContractRawPricing` computes an annual gross and
      a prepayment price from them. ADR-0053 Decision 1A makes Standard and
      Premium one-month, monthly-billed, with no prepayment discount, and makes
      Enterprise individually agreed. **ADR-0053 is authoritative; the code is the
      delta.** It was deliberately left unchanged by the documentation work
      package and **must be reconciled before commercial billing is activated.**
      No caller may treat those constants as a statement of what a Standard or
      Premium customer agreed to.
- [ ] **`REVIEWER` survives in code or schema** where the role vocabulary is
      represented, and the Phase 3B near-duplicate UX still contradicts ADR-0052
      Decision 14. Both are listed in the implementation section above.

### Live-evidence gates — cannot be closed by documentation

- [ ] **Re-verify the AI provider before activation.** ADR-0054 Decision 2 lists
      the full set: commercial-use rights and terms, current pricing, 720p and
      1080p support, supported durations, the image-to-video contract,
      concurrency and rate limits, provider retention, webhook/auth mechanism,
      cancellation capability, actual output quality, observed failure rate,
      observed latency, Unit economics. **Only verified routes may be enabled.**
- [ ] **Set the minimum margin threshold for the Cost Safety Guard.** ADR-0054
      Decision 3 deliberately fixes no percentage. Needs measured provider cost,
      Google Cloud variable compute/storage/egress cost, payment-processing cost,
      retry/recovery expected cost, FX buffer and composition cost.
- [ ] **Validate the provisional additional-storage price** (¥1,500 / +50 GB)
      against measured production storage and egress economics before Commercial
      Launch. Approved only as a working figure.
- [ ] **Set the production scheduler's timing values from measurement**, not
      guesses: the stale-`SUBMITTING` threshold from observed p99 submission
      latency, the signed source-URL TTL from measured provider fetch behaviour
      with buffer, and cadence, batch size and worker concurrency from load and
      production-readiness testing. Reaffirmed by ADR-0054 Decision 4; the
      existing entries above for `staleSubmittingAfterMs` and the 600-second TTL
      remain the detailed records.
- [ ] **Set the polling interval and timeouts from measurement.** ADR-0054
      Decision 4 makes polling the mandatory authoritative fallback but
      deliberately fixes no cadence or deadline. The `WAVESPEED_POLL_*` values
      are live-evidence values, not constants to guess.
- [ ] **Verify the provider's webhook authentication contract against the live
      provider.** Until verified, that webhook is **not** authoritative
      completion evidence and polling is the normal authoritative path (ADR-0054
      Decision 4). This is part of the Decision 2 re-verification set and is
      called out separately because the whole webhook design depends on it.
- [ ] **Validate Standard/Premium monthly economics against the one-month,
      no-commitment, no-prepayment-discount contract** (ADR-0053 Decision 1A).
      The approved term removes the contracted revenue floor the runtime pricing
      code currently assumes, so churn exposure and per-month unit economics need
      measurement before Commercial Launch.
- [ ] **Counsel review before Commercial Launch** by counsel familiar with
      Japanese IT/SaaS and real-estate advertising: Terms of Service, Privacy
      Policy, Mode C consent wording, the responsibility boundary,
      pricing/Unit/refund rules, SLA, retention and deletion, IP and
      source-material warranties, and the subprocessor list. The purpose is to
      validate the responsibility boundary, **not** to make VTaVision an
      external-publication approver.
- [ ] **Publish and maintain a subprocessor list** (Google Cloud, Stripe, the
      active AI provider(s), email-delivery vendors, other material processors),
      with a formal update mechanism, and version Terms/Privacy/Consent so that
      who accepted which version and when is determinable.
- [ ] **Begin the Enterprise contractual SLA only after production measurement**
      and legal/commercial approval. Closed Beta carries no formal commercial
      SLA, and no AI generation completion-time SLA is offered.
- [ ] **Meet the Closed Beta launch gates** (ADR-0053 Decision 12), including the
      zero-tolerance items: double Unit consumption 0, duplicate Provider
      charging 0, cross-tenant exposure 0, Sev1 0, loss-making Jobs 0.

### Activation gates — BLOCKED pending explicit CTO authorization

- [ ] Paid Provider Activation
- [ ] Production Provider credentials
- [ ] Production AI paid calls
- [ ] Production scheduler activation (Cloud Scheduler)

Documentation approval is **not** activation authorization (ADR-0054 Decision 7).
