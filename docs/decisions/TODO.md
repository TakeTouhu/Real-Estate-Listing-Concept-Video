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
      *ADR-0052 Decision 18 superseded the MFA half: authenticator-app MFA is
      mandatory for privileged users. MFA-1 built its foundation, MFA-2
      its screens and two-step sign-in, MFA-3 made it mandatory, and MFA-4
      added an organization's requirement for all members (ADR-0065). Entra ID
      and Google SSO stay post-release.*

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
      *GS-3 (ADR-0085) adds a shared folder for development and CI, refused in
      production; it is not a step towards this adapter.*
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
- [x] **Remove the shipped near-duplicate UX that now contradicts ADR-0052
      Decision 14.** *Done by ADR-0063 (2026-10-15, migration 24):* no clusters,
      no primary choice, no "looks similar" line, no one-approved-per-group
      index, and storyboards admit approved look-alikes. The original item, kept
      as evidence: the Phase 3B-3a/3b analysis-review surface clustered
      near-duplicates and permitted only one member of a group to be approved,
      and the request carried a `primaryAssetId`. The Phase 3B records stay as
      historical evidence of what shipped.
- [ ] **Confirm the near-duplicate removal's choices ADR-0052 does not make**
      (ADR-0063):
      1. `duplicateGroup` and `duplicateOf` leave the API responses, not only
         the screens;
      2. an approve request's `primaryAssetId` is ignored rather than refused;
      3. photos rejected under the old rule are not restored automatically.
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
      Since UP-3 (ADR-0068 Decision 5) the Unit purchase route
      (`POST /api/organizations/{id}/unit-purchases`) is the first billing
      route, and it is not limited either.
- [ ] **Extend the same-origin check to every cookie-based mutation route.**
      `SecurityCompliance.md` asks for CSRF protection where cookie-based
      mutations are used. The session cookie is `SameSite=Lax` (ADR-0006),
      which keeps it off a form posted from another site but not from another
      origin of the same site. UP-3 checks `Origin` on the Unit purchase route
      only (`isSameOriginPost`, ADR-0068 Decisions 4 and 5); every other form
      and JSON mutation route relies on `SameSite=Lax` alone. Applying the check
      across them is one cross-cutting milestone, like rate limiting, and needs
      the deployment's proxy to pass the addressed host.
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
      *Done for orchestrated attempts in GS-7c-1 (ADR-0096 Decision 3): the
      paid-submission gate writes `generation.submission_started` in the commit
      that moves the attempt to `SUBMITTING`, the only state anything is sent
      from, and a failed insert rolls the move back. What remains is the legacy
      executor's claim, which writes no such entry: nothing constructs it, and
      it must not send until it does.*
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
      *For orchestrated attempts, steps 2 to 5 are done at the gate in GS-7c-1
      (ADR-0096): it locks the source asset and its Property after the
      reservation, refuses one deleted, changed or no longer the prepared
      source, or a deleted Property (`SOURCE_INVALID`), moves the attempt and
      writes the audit entry in one commit. What remains of the deletion
      race is the one ADR-0030 accepted: a deletion requested after the
      gate's commit does not stop the send. Steps 1 and 6, the URL's
      freshness and the POST, are GS-7c-2b. GS-7c-2a (ADR-0097) finds the
      attempts to send and ends one whose preparation is refused for good.
      GS-7c-2b (ADR-0098) builds steps 1 and 6 for orchestrated attempts: the
      sender requires 300 seconds left on the URL before the gate, and makes
      one POST after it, through the only production caller of a provider's
      create POST. Nothing outside tests constructs the sender; open until it
      runs, since only then is a paid POST possible.*
- [ ] **A preflight-failure audit event, if wanted, belongs to orchestration.**
      Phase 4C-2B deliberately emits none: there is no provider POST in it, and
      coupling audit I/O into the persistence CAS would put a second failure mode
      inside the transaction that decides whether work is parked. The paid-call
      invariant is unchanged — a durable `generation.submission_started` audit
      must succeed **before** the provider POST. Decide during Phase 4C-3 whether
      a parked refusal also warrants an audit entry.
      *GS-7c-2a (ADR-0097 Decision 3) ends an orchestrated attempt's terminal
      preparation refusal with a transition event and no audit entry, as
      Transactions K and L release the Unit and cancel attempts with none.
      GS-7d-1 (ADR-0099 Decision 3) ends a waiting job that can never launch
      and releases its Units the same way, and GS-7d-2 (ADR-0100 Decision 2)
      a generating job's attempt whose Property was deleted. Still open.*
- [ ] **The 600-second preflight source URL TTL is provisional.**
      `PREFLIGHT_SOURCE_URL_TTL_SECONDS` was chosen for a pipeline nothing has
      run end to end. It must cover preparation, the claim, the POST and the
      provider's own fetch. Confirm or change it against a real submission during
      the Phase 4C-3 paid-call review. **Required before real provider spending.**
      *The sender's margin, `MIN_SOURCE_URL_REMAINING_MS` (300 seconds, half the
      URL's life; ADR-0098 Decision 4), is provisional with it.*
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
      *The paid-submission gate refuses such a source, and one whose
      Property is deleted, with a normalized reason (`SOURCE_INVALID`,
      ADR-0096 Decision 2). Ending the attempt for it is GS-7c-2 and GS-7d.
      GS-7c-2a (ADR-0097) builds the ending: once the sender (GS-7c-2b) calls
      it, a photo preparation finds gone, asked to be deleted, unrecoverable
      or missing from storage ends the attempt with that reason, and
      Transaction K releases the Unit. One deleted after
      preparation and refused by the gate, and a deleted Property's attempt,
      which discovery passes over, are GS-7d. The sender (GS-7c-2b, ADR-0098)
      calls the ending. GS-7d-2 (ADR-0100): a photo deleted after preparation
      is refused by the gate and ended by the next pass's preparation; a
      deleted Property's attempt is ended by the sender with
      `PROPERTY_DELETED`, and Transaction K releases the Unit. Nothing runs
      the sender until the pipeline command (GS-9).*
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

> This section predates the initial-release contract. Twenty-nine further business
> rules — contract term, billing cadence, annual prepayment, cancellation/refund,
> upgrade/downgrade, permanent-failure settlement, operator recovery, support
> hours and targets, the role matrix, the recovery-budget denominator, grant
> ceilings and self-escalation, Normal/HQ Unit eligibility, `disclosure.none`
> grant authority, in-flight Mode C, commercial-mutation authority, the Clean
> Master, additional-seat cancellation, mid-period purchases, downgrade fit and
> charged-recomposition quality, logo-only recomposition, storage blocks, storage
> blocks on downgrade, Scope semantics, Property assignment authority,
> role-fixed Scope, the `property.create` capability ceiling, fixed
> `MANAGER`/`CREATOR` creation-time assignments and protected group deletion —
> were settled later and are recorded under *Decision gates — CLOSED* below;
> *Decision gates — OPEN*, just above it, holds the regeneration-Unit gate. Read all three
> places; none is the complete ledger on its own.

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
      Launch. *The concurrent-job limit is recorded on each plan as
      `concurrentJobs` since GS-7a (ADR-0094).*
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
`INTEGRITY_MISMATCH`. **Built by GS-1 (ADR-0082)**: the block's own commit
fails an initial generation's job and releases its reservation, or returns a
replacement to the video the customer holds. No new state name was needed:
`FAILED_TERMINAL` and `DELIVERABLE_READY` already said it.

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
VTaVision bears the cost already incurred. **Built by GS-1 (ADR-0082)**, for
both verdicts and for an off-plan video, in the verdict's own commit.

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

*Update (DS-5b-2b-1, ADR-0078): composition profile v2 draws Mode A over every
video it makes. The verdict and publication still do not require it (DS-6);
the work is tracked under "Render the AI-generated disclosure".*

*Update (DS-6a, ADR-0080): Transaction G now publishes a version only when its
composition's frozen profile drew the version's mode. The verdict does not
examine the frames for it, by design: the evidence is the profile.*

*Update (DS-6b, ADR-0081): the verdict now requires the video to be its
composition's frozen frame size, the size the disclosure image was made for,
and its job's admitted length within one frame. Mode A is rendered and gated
at every layer; nothing in production runs it.*

**The placement rules are no longer open.** ADR-0052 Decision 8 fixes the exact
text, the three modes and Mode A's geometry, so this is implementation work
against a settled specification — not a decision still to be made. The earlier
cross-reference to *Business rules to confirm* is stale; that item is closed.

## Found in Phase 6F — a provider-output race test asserts too much

- [x] **Make "gives two PROCESSING runners one history and at most one
      transfer" deterministic** (`tests/integration/provider-output-orchestration.db.test.ts`).
      Done after GS-4b, whose CI it failed twice: each runner's poll now waits
      until both have polled, and a runner loads the attempt before it polls,
      so both runners load it as `PROCESSING`. Run alone, it had failed 14 of
      15 runs on main and then passed 30 of 30.
      It races two runners with `Promise.all` and asserts the loser answers
      `INGESTION_ALREADY_CLAIMED` or `ALREADY_VERIFIED`, and that exactly one
      transfer ran. A legal interleaving breaks both: when the second runner
      loads the attempt after the first one's ingestion claim has committed, it
      sees `OUTPUT_INGESTING` and takes the resume path, which transfers
      directly by design (there is no I/O lease). It then finalizes as
      `OUTPUT_VERIFICATION_REPLAYED`. The product behavior is correct: one
      history, one verified output, and a second copy to the same deterministic
      key. Only the test is wrong. Seen once in a full local run during Phase
      6F, which does not touch this code; the re-run passed. The fix is a
      test-only change: hold both runners until each has loaded the attempt, or
      add this interleaving as its own deterministic case.

## Found in GS-3 — a cross-phase lock test waits on a timer

- [x] **Make "serializes against a Phase 2F-1 cost admission holding the same
      locks" deterministic** (`tests/integration/submission-outcome.db.test.ts`).
      Done after GS-4b: the gate's session signals once its facts are loaded,
      and the write starts after that signal instead of after 100 ms.
      It opens the paid-submission gate's transaction, waits 100 ms
      (`breathe(4)`) for it to take its locks, starts an outcome write and
      asserts the write is still blocked. Under load the gate's transaction can
      still be waiting for its first lock after 100 ms, so the write takes the
      locks first and finishes: a legal interleaving, and the product's
      serialization holds either way. Seen once in a full local run during
      GS-3, which does not touch this code; the file then passed three runs
      out of three. The fix is test-only: signal from inside the gate's
      session once its facts are loaded, and start the write after that.
- [ ] **Thirteen more waits of 100 ms for a transaction to take its locks**
      (`breathe(4)` in `generation-concurrency`, `paid-submission-authorization`,
      `reconciliation` and `submission-outcome` `.db.test.ts`). None has been
      seen failing. Each can fail the same way under load, and each has the
      same test-only fix: signal from inside the transaction once it holds its
      locks.

## Found in GS-7d-2 — a Property rename can undo its deletion

- [x] **Make a Property's rename and deletion conditional writes.** Done in
      ADR-0101 (no migration), approved by the product owner on 2026-10-29
      ("直す"): `updateDetails` writes only the fields a rename names and
      `markDeleted` the status alone, each only while the Property is in the
      organization and not deleted; a lost race is answered `NOT_FOUND` with
      no audit entry. `PropertyRepository.update` is gone. No route reached
      either write, so no customer met the bug.
      `PropertyService.update` read the Property, then wrote the whole row
      back, its `status` included, by id alone; `remove` did the same with
      `DELETED`. A rename that read the Property before a deletion saved
      therefore wrote `ACTIVE` back after it: the Property reappeared, while
      its photos stayed asked to be deleted. Found by GS-7d-2's review.
- [ ] **Make a Property's deletion, its photos' deletion requests and its
      audit entry one commit.** `PropertyService.remove` marks the Property
      deleted, then asks for each photo's deletion, then writes its audit
      entry, each its own statement. A failure between them leaves photos not
      asked to be deleted, or no audit entry, under a deleted Property, and a
      retry is answered `NOT_FOUND`, so nothing finishes it. Found while
      writing ADR-0101; a product change, to propose before a route deletes a
      Property.

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
      *In progress (approved 2026-10-20, `/mnt/project-files/cto/disclosure-proposal.md`).
      DS-1 (ADR-0071) built layer v1: six committed images, one per composable
      size, with the product owner's faint shadow and 12-pixel minimum, pinned
      in `@app/domain`. Nothing draws them into a video yet; DS-2 to DS-6 add
      FFmpeg to CI, the frozen mode, the Clean Master, the overlay and the
      publication gate. DS-2 (ADR-0072) added FFmpeg to CI: the composer and
      inspector pass on real FFmpeg, and each image survives a real encode.
      DS-3 (ADR-0073, migration 29) froze the mode on each job and deliverable
      version, Mode A only. DS-4 (ADR-0074, migration 30) added the Clean
      Master's record and its internal location, which no signed URL reaches.
      DS-5a (ADR-0075) let the composer encode the master and lay the
      disclosure over it. DS-5b-1 (ADR-0076) added the master's store and the
      inspector that checks its size and rate. DS-5b-2a (ADR-0077, migration
      31) gave the composition claim the version's mode and the master's key,
      and Transaction J2 the master's record. DS-5b-2b-1 (ADR-0078) switched
      the runner to profile v2: it makes the master first and the customer's
      video from the stored master with the version's disclosure. DS-5b-2b-2
      (ADR-0079) had J2 refuse a finalize that names no master, removed the
      one-pass encode, and ran the runner end to end on real FFmpeg. DS-6a
      (ADR-0080) has Transaction G publish a version only when its
      composition's frozen profile drew the version's mode and its master is
      recorded. DS-6b (ADR-0081) has the verdict require the composition's
      frozen frame size and the job's admitted length within one frame, and
      `finalizeValid`, Transaction G and discovery refuse a `VALID` verdict
      off that plan. The plan's six milestones are built, for Mode A; Modes B
      and C are not (see "Build Mode C gating and consent"). Nothing in
      production runs any of it.*
- [ ] **Choose the worker image's FFmpeg before composition is activated.**
      The media suites (ADR-0072) were measured on Ubuntu 24.04's FFmpeg 6.1.1
      in CI; no deployment carries FFmpeg yet. Whichever build the worker image
      ships, run `pnpm test:media` against it before it composes anything. The
      same image must carry `assets/disclosure/`'s six images and pass their
      directory, as an absolute path, as the composer's
      `disclosureLayerDirectory` (ADR-0075 Decision 3); without them the
      composer refuses to make a video. *Since DS-6b (ADR-0081) this run
      must include the runner suite's on-plan assertion: a build whose
      container duration differs from the frames by more than one frame
      would have every video refused as `DURATION_INVALID`, each holding its
      reservation.*
- [ ] **Re-measure the Clean Master's quality on the provider's real output.**
      `CLEAN_MASTER_CRF` 16 (ADR-0075 Decision 1) was chosen on three synthetic
      clips, the hardest an 8 Mbps encode of grainy footage: a loss of 0.25 dB
      and a master 1.5 times the video, within the approved plan's estimate.
      Before composition is activated, repeat ADR-0075's procedure on the
      verified route's own clips; a different answer is a new composition
      profile, not an edit of the constant. The same measurement checks
      `MAX_CLEAN_MASTER_BYTES` (ADR-0076 Decision 1): 1 GiB assumes no master
      is more than twice its video, and one that is would be stopped with a
      video that would have fitted.
- [ ] **Build Mode C gating and consent.** Organization-level enablement,
      `disclosure.none`, per-video consent with two affirmative checkboxes, and
      the consent evidence record (`organizationId`, `userId`, target,
      `disclosureMode = NONE`, `consentTextVersion`, `consentedAt`,
      organization-level enablement state) retained 10 years. Organization
      enablement must **not** be treated as authorizing any user on its own.
- [x] **Treat `disclosure.none` as `OWNER`-only protected authority.** ADR-0052
      Decision 10. Reject every grant or revoke attempt by `ADMIN` or any lower
      role — including an `ADMIN` acting on itself — as a refused, audited
      authorization change rather than a silent no-op. *Done in Phase 6D
      (ADR-0058).*
- [x] **Make `disclosure.none` individual-only in representation and
      enforcement.** No group permission, group inheritance, role template or
      Scope expansion may carry it, and the model should make that impossible
      rather than merely unused, so no indirect path — group membership, group
      edit or role change — can confer it. *Done in Phase 6G (ADR-0061): the
      `group_permissions` CHECK refuses it, the service refuses it to every
      group as `not_grantable`, and effective permissions drop it from any
      group source; no template carries it (Phase 6C). Scope, still unbuilt, is
      row reach and confers no permission.*
- [x] **Audit every `disclosure.none` grant and revocation** with the
      organization, affected user, acting `OWNER`, action and timestamp. *Done
      in Phase 6D (ADR-0058): `permission.granted` / `permission.revoked`, as for
      every grant.*
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
      *In part (DS-3, ADR-0073): the mode is stored on the job at admission and
      never updated, and each deliverable version records its own, bound into
      its input fingerprint. Only Mode A can be stored. Mode C's consent and the
      two eligibility snapshots arrive with Mode C, and the logo setting with the
      logo.*
- [ ] **Decide which disclosure mode a later version carries.** Today every
      deliverable version copies its job's mode, because nothing changes a mode
      (ADR-0073 Decision 3). Once a disclosure change plans a version in another
      mode, a later content regeneration of the same job plans a new version
      too. Whether that version keeps the mode of the customer's current
      deliverable, takes the job's admitted mode, or is chosen again at the
      regeneration's own admission (ADR-0052 Decision 10 makes a disclosure
      change "its own admission") is a product rule not yet stated. Decide it
      before disclosure changes are built.
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
      approved in ADR-0052 Decision 10, as are the Scope predicates, role-fixed
      Scope and Property assignment authority. What remains is implementation, itemized below — the grant
      matrix, ceiling enforcement on every grant path, self-escalation
      prevention, authorization-change audit, and the `disclosure.none` items.
      *Groups and group membership built in Phase 6F (ADR-0060). **Still
      unbuilt:** group permissions and Scope.* *Additive group permissions
      built in Phase 6G (ADR-0061). **Still unbuilt:** Scope.* *Property
      assignment, the data Scope needs, built in Phase 6H (ADR-0062). **Still
      unbuilt:** enforcing Scope on the content paths (6I).* *Reach enforced
      on the Property and photo paths in Phase 6I-1, and on analyses, video
      projects, storyboards and generation admission in Phase 6I-2
      (ADR-0064).*
- [ ] **Build user and group deletion.** `active`/`deleted` only — no suspension
      state, no restore. On user deletion: immediate access stop; 30 days of
      admin-only inspection of that user's videos; then physical deletion of all
      of them including old versions; other users' videos for the same property
      survive; legally retained evidence survives. Group deletion is
      **`OWNER`/`ADMIN`-only** (ADR-0052 Decision 11): a protected check that a
      granted `group.manage` cannot satisfy for any other role. On group
      deletion: users become ungrouped, lose only group-granted permissions,
      Properties become ungrouped and content returns to organization root with
      no content or child resource deleted; record organization, group, acting
      user and role, affected Property count or identifiers, and timestamp.
      *Group deletion built in Phase 6F (ADR-0060): `OWNER`/`ADMIN`-only even
      with a granted `group.manage`; members stay in the organization; the
      deletion is audited with the actor's role and the number of members
      removed. **Still unbuilt:** user deletion; ungrouping Properties and
      recording how many (no Property has a group until Scope); losing
      group-granted permissions (no group carries one until group permissions).*
      *Losing group-granted permissions built in Phase 6G (ADR-0061): a deleted
      group's permissions go with it, and an `ADMIN` may not delete a group
      whose deletion would take away a permission it could not revoke directly.*
      *Ungrouping Properties built in Phase 6H (ADR-0062): a deleted group's
      Properties become ungrouped, and `group.deleted` records how many.
      **Still unbuilt:** user deletion, which must also release the user's
      responsible-user assignments, as a member's removal does.*
- [ ] **Build the 30-day trash lifecycle** for properties, projects, images and
      videos, with the in-trash restrictions (no generate/regenerate, no
      disclosure change, no upload, no edit; preview/download still allowed when
      authorized) and no counter resets on restore.
      *A deleted Property's waiting videos end at once and their Units are
      released (the product owner's decision of 2026-10-29, ADR-0099), not
      held for the trash period, and a generating video whose attempt still
      waits before submission ends so its Unit is released too (ADR-0100),
      as does one launched and not yet being assembled (ADR-0102); one being
      assembled is not ended yet (*End a deleted Property's video already at
      the provider or being assembled*, below). A restored Property's videos would be started
      again by the customer.*
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
      *In progress. DS-4 (ADR-0074, migration 30) built its record, one receipt
      per composed version, and its location,
      `org/{organizationId}/internal/clean-masters/{version}`, refused by every
      signed URL. DS-5b-2a (ADR-0077) made Transaction J2 its writer, in the
      commit that records the video's receipt; it records the receipt it is
      given and does not yet check it against the frozen profile. DS-5b-2b-1
      (ADR-0078) has the runner make a master and hand its receipt to every
      finalize; a stored video found without its master is a defect that
      holds that deliverable until an operator acts (ADR-0052 Decision 20's
      recovery, unbuilt). DS-5b-2b-2 (ADR-0079) has J2 refuse a finalize that
      names no master. DS-6a (ADR-0080) has Transaction G refuse to publish a
      version without it. Still unbuilt: a
      recomposed version naming another version's master (which then decides
      what its own Transaction J2 records, ADR-0077 Decision 3); when it is
      built, ADR-0080 Decision 2 must be revisited, because Transaction G and
      validation discovery require a master at the version's own key, and the
      table's CHECK ties the key to the row's version. And its deletion with
      its content: when physical deletion of
      videos ships, delete the master's object, then its row, then the version
      (RESTRICT holds that order), subject to legal hold, under the job and
      version locks Transaction G takes, because G reads the master's row
      without locking it (ADR-0080 Decision 2).*
- [ ] **Decide which Clean Masters outlive their purpose.** ADR-0052 Decision 17
      retains a master "with the associated retained video/property content"
      but does not say whether that covers (a) the master of a version that is
      never published, because its validation fails or a newer version
      supersedes it first, or (b) the master of content replaced by a paid
      regeneration, once that content's old final video passes its 30 days.
      Decide before any deletion of masters is built; it does not change how
      DS-5 makes one.
- [ ] **Decide whether scene outputs move under the internal namespace** before
      any route lets a customer download a deliverable. ADR-0052 Decision 17
      makes scene media internal; their keys,
      `org/{organizationId}/generations/{attemptId}/output`, are outside
      `org/{organizationId}/internal/`, so the signers' refusal (ADR-0074) does
      not cover them. Nothing signs them today.
- [ ] **Build the internal service-recovery budget.** `base-plan included-user
      slots × 1` → **3 / 10 / 30** per organization per renewal period, from base
      plan slots — **not** active users and **not** purchased additional seats —
      shared organization-wide, never exposed. On exhaustion: stop automatic
      recovery, charge no further Unit, release the reserved Unit, escalate
      internally, allow one operator-granted manual free recovery. *Until it
      exists, nothing retries a provider-side failure, so Transaction K
      settles a `FAILED_RETRYABLE` attempt like a terminal one (ADR-0083
      Decision 2). When it is built, it decides first whether a failed attempt
      gets another, and Transaction K's candidates must then exclude a request
      the budget will still retry.*
- [ ] **Bound how long an attempt may run before it is treated as failed.** An
      attempt left `PROCESSING` by a provider that never answers, or
      `OUTPUT_INGESTING` by an output copy that keeps failing (that state is
      resumable on purpose, so a storage fault is never recorded as the
      provider's), never ends, so Transaction K never settles its request
      and the customer's Unit stays held (ADR-0083, *Not decided here*).
      Whether such an attempt ends, after how long, and as which state, is not
      decided. Must be settled before generation is activated.
      *Now that the sender prepares attempts (GS-7c-2b, ADR-0098), the same
      holds for an attempt waiting `QUEUED` whose preparation is refused, on
      every pass, for a reason that may pass (ADR-0097 Decision 2), such as a
      model not restored or storage that does not answer: it is prepared again
      each time and holds its Unit. So does one whose signed URL storage keeps
      issuing with less than 300 seconds left (`SOURCE_URL_STALE`), and one
      admitted for a provider no sender is built for (`OTHER_PROVIDER`): both
      write nothing and wait.*
- [x] **Stop the legacy executor's discovery from offering orchestrated
      attempts (GS-7).** `findNextQueuedForPreparation` and its claim read the
      legacy `state` column, which no orchestration writer moves: every
      orchestrated attempt stays legacy `QUEUED` from admission, including one
      Transaction L cancelled before submission (ADR-0084, *Not decided
      here*). Were that executor run, it would claim such a row and send it
      outside the paid-submission gate. Nothing in production constructs it.
      Before any executor runs orchestrated attempts, its discovery must
      exclude them or read the orchestration state. *Planned for GS-7c, the
      pull request that sends orchestrated attempts (ADR-0094). Done in
      GS-7c-1 (ADR-0096 Decision 1, no migration): discovery, the claim
      (before the asset lock, after it, and at its compare-and-swap) and the
      park act only on a `QUEUED` row with no orchestration state.*
- [x] **Start each scene in the commit that admits its first attempt
      (GS-7).** Admission (`admitAttemptWithin`) does not move the scene, and
      Transaction K settles an initial request only under a `GENERATING`
      scene, refusing one under a `PENDING` scene as `SHAPE_CONFLICT`
      (ADR-0083 Decision 3). A step that admitted attempts without
      starting their scenes would leave such a failure unsettled and its
      Unit held. Transaction L closes that shape either way (ADR-0084
      Decision 2). *GS-4's start step admits no attempt: it leaves the job
      `RESERVED` until the concurrent-job limit lets it run (ADR-0052
      Decision 7), so the first admissions belong to GS-7's launch step,
      planned for GS-7b. GS-7a (ADR-0094) builds what that commit admits: one
      route for the job, and each scene's prompt and price. Done in GS-7b
      (ADR-0095 Decision 5, no migration): the launch commit moves the job and
      every scene to `GENERATING` and admits each scene's first attempt in the
      same transaction, or writes nothing.*
- [x] **Make the test provider's clips at its route's sizes (GS-6).** The
      test route's catalog entry records Normal as generated at 720p and HQ at
      1080p, with no upscale (ADR-0090 Decision 4), but the fake provider makes
      no clip yet: it answers with a made-up address and no bytes. GS-6's clip
      must be made at the attempt's native size, or the entry claims a size
      nothing was generated at. *Done in GS-6 (ADR-0092, no migration): the
      test provider's studio makes each clip at the request's aspect ratio and
      native size, from the composition profile's raster table.*
- [ ] **Release a started job that can never launch (GS-7).** A job waiting
      for the concurrent-job limit holds its Units `RESERVED` (the approved
      plan's Design 6). One that can never run, for instance because no route
      serves its quality any more, must not hold them indefinitely (ADR-0052
      Decision 19). Nothing launches a job yet, and nothing constructs the start
      step outside tests until GS-10. *Planned for GS-7d. The launch planner
      (GS-7a, ADR-0094) names why a job cannot be planned with a fixed code;
      some pass, such as a rate that cannot be read now, and some never will,
      such as a scene with no prompt. GS-7d decides which release the Units.
      Since GS-7b (ADR-0095 Decision 3) a waiting job whose Property was
      deleted is never launched and is passed over in the order, so it no
      longer holds back its organization's other jobs, but it still holds its
      Units until GS-7d. Any other job that cannot launch does hold them back,
      since the launch is strict oldest-first, and the candidate query offers
      organizations by their oldest waiting job, so once a pass's window is
      filled by organizations whose oldest job cannot launch, no other
      organization's job is offered (ADR-0095 Decision 7). GS-7d must remove a
      job that can never launch from the head of its queue, and GS-9's pass
      must keep refused jobs from using up its window.*
      *Done for a job's own rows in GS-7d-1 (ADR-0099, no migration): a
      waiting job whose Property is deleted (the product owner's decision of
      2026-10-29: at once), whose frozen facts the planner refuses before any
      catalog, or whose rows are not as the start wrote them, fails and its
      Units are released in one commit. The launch runner ends a deleted
      Property's waiting jobs, found by a query of their own, and any launch
      candidate that can never launch, which frees the head of its queue. A
      job refused for a frozen fact or its shape is found only as a launch
      candidate, so it is ended only when its organization has a place and a
      subscription; until then it holds its Units. Still open: a job refused
      for a route, a price or a rate keeps waiting with its Units held, and
      holds back its organization's queue (the next item); a waiting job whose
      hold is not `RESERVED` or one of whose requests has an attempt, which
      only a writer other than the start and the launch can make, is neither
      launched nor ended and holds back its queue too; and GS-9's pass must
      keep such jobs from using up its window.*
- [ ] **Bound how long a waiting job refused for configuration may hold its
      Units.** A waiting job the planner refuses for VTaVision's own
      configuration or for timing (`NO_ROUTE`, `AMBIGUOUS_ROUTE`,
      `NO_CURRENT_PRICING`, `AMBIGUOUS_CURRENT_PRICING`, `NO_FX_RATE`) is not
      ended (ADR-0099 Decision 1): it can launch once the configuration is
      fixed. Until then it holds its Units, and, the launch being oldest first,
      its organization's later jobs. Whether it ends after some time, and
      whether a fault of ours that never clears is then a failure the customer
      is not charged for, is not decided. Must be decided before generation is
      activated.
- [ ] **Release a change to the prompt's fixed rules only when no job
      waits.** Editing `PRESERVATION_RULES` or `SYSTEM_NEGATIVE_CONSTRAINTS`
      makes every admitted, unexecuted generation's frozen prompt fail to
      render (ADR-0020: a re-admission event, failed closed). For a job still
      waiting, that is `SCENE_PROMPT_UNRENDERABLE`, and the next launch pass
      ends it and releases its Units (ADR-0099 Decision 1): no one is charged,
      but every waiting video of every customer must be started again because
      of a change of ours. How such a change is released (drained first, or
      announced) is not decided; it must be before generation is activated.
- [ ] **End an orchestrated attempt the gate will never authorize (GS-7d).**
      A gate refusal writes nothing, so an attempt refused for good, such as
      one whose Property was deleted or whose photo was deleted or is
      unrecoverable (`SOURCE_INVALID`, ADR-0096), or a price no contract will
      cover again, stays `QUEUED` under a `GENERATING` job, and Transaction K
      never settles its request: the customer's Unit stays held (ADR-0052
      Decision 19). A photo changed but still usable is prepared again and
      passes, so it is not such a case. Which refusals end the attempt, as
      which state, and under which lock, is not decided. *Planned for GS-7d;
      GS-7c-2a (ADR-0097) builds the ending of preparation's terminal
      refusals, which the sender calls from GS-7c-2b. Its discovery passes
      over a deleted Property's attempts, so they no longer
      fill a pass ahead of attempts that can be sent, but they would hold
      their Units, even once their photos are asked to be deleted, until
      GS-7d.* *Done for a deleted Property in GS-7d-2 (ADR-0100, no
      migration): the sender ends such an attempt before its window, and one
      the gate refuses as deleted since discovery at once,
      `CANCELLED_PRE_SUBMISSION` with `PROPERTY_DELETED`, behind the
      cost-admission lock with the Property held; K then releases the Unit.
      A photo gone or unrecoverable is ended by preparation (GS-7c-2a), on
      the next pass when the gate refused it first. Still open: the gate's
      other refusals for good, a price no contract will cover again
      (`PRICING_INELIGIBLE`) or an attempt not in a shape to cross the
      boundary (`ATTEMPT_NOT_ARMABLE`), which still write nothing; and how
      long an attempt refused for configuration (no authorized route, the
      Safety Guard's pause, no revenue figure) may hold its Unit, which must
      be decided before generation is activated.*
- [ ] **End a deleted Property's video already at the provider or being
      assembled.** The product owner decided on 2026-10-29 ("すぐ戻す") that
      a deleted Property's unfinished videos end at once and return their
      Units. GS-7d-1 (ADR-0099) ends a waiting job, and GS-7d-2 (ADR-0100) a
      generating job while one of its attempts still waits before
      submission. A `GENERATING` job whose attempts are all at the provider,
      or a job in `SCENES_READY`, `COMPOSITION_PENDING`, `COMPOSING` or
      `DELIVERABLE_VALIDATING`, is not ended: nothing downstream reads the
      Property, so it still delivers and its Unit is consumed. Planned as a
      follow-up, GS-7d-3, to be proposed; the provider cost of an attempt
      already sent would be VTaVision's (ADR-0083 Decision 1).
      *GS-7d-3 approved by the product owner on 2026-10-29 ("承認"). GS-7d-3a
      (ADR-0102) ends a launched job in `GENERATING`, `SCENES_READY` or
      `COMPOSITION_PENDING` whose Property was deleted, its Unit released in
      the same commit; the launch runner ends them before its launches.
      **Still open:** a job in `COMPOSING` or `DELIVERABLE_VALIDATING`, which
      GS-7d-3b will stop at publication (Transaction G refuses to publish,
      fails the job and releases its Unit), and a job whose hold is on
      reconciliation and is then released rather than restored.*
- [ ] **Decide whether a regeneration counts against the concurrent-job
      limit, and whether it waits for a place.** ADR-0052 Decision 7 limits
      concurrent customer video Jobs; nothing decides whether regenerating a
      video already delivered is one, though the customer already has a video
      then. Revision start moves a delivered job to `GENERATING` in one commit
      without consulting the limit. A job in `REVISING`, or in `GENERATING`
      after a revision, is counted today because its state cannot be told
      apart from a first generation's; that counting is provisional (ADR-0094
      Decision 2). Nothing runs revision start today; decide before paid
      regeneration is wired. Revision start neither checks the limit nor takes
      the launch lock (ADR-0095 Decision 1), so every revision started while
      its organization is at the limit holds a place beyond it; if a
      regeneration counts, revision start must check the limit under the
      launch lock.
- [ ] **Decide whether a duplicate job blocks its organization's queue.** One
      project may not have two identical requests at work at once (the
      active-request index), so a job of the same storyboard as one still
      generating is refused at launch (`SAME_REQUEST_RUNNING`, ADR-0095
      Decision 6) and waits for the first to end. The launch is strict
      oldest-first, so the organization's later jobs wait behind it. Decide
      whether such a job is passed over, or whether the start refuses a second
      start of a storyboard already generating, before the launch runs for
      customers.
- [ ] **Reserve the launch's generic edges.** The generic job and scene
      transitions still allow `RESERVED → GENERATING` and `PENDING → GENERATING`,
      which the launch commit owns since GS-7b (ADR-0095 Decision 8): a generic
      caller could start a job with no attempt, or a scene whose request never
      started. Nothing in production constructs those repositories, but
      integration tests build fixtures with the two edges. Move those fixtures
      to the launch commit or direct seeding, then add both edges to the
      reserved lists.
- [ ] **Decide which route a job takes when more than one could serve it.**
      The launch planner sends a whole job by one route and plans nothing
      (`AMBIGUOUS_ROUTE`) when several qualify (ADR-0094 Decision 3). With
      production's tables this happens only for Normal at 1080p, a pairing the
      start never makes (H3 Max and OpenVideo both serve it); the test route
      has one route per quality. ADR-0033's default model is one candidate
      answer, but being the default was not decided as being the preference
      between two executable routes. Decide before a second route serves a
      pairing the start makes.
- [ ] **Measure the start commit on the production database before
      activation.** The start copies a storyboard in one transaction under
      Prisma's default 5-second limit, at about six statements per scene; a
      90-scene storyboard starts in well under a second on the local test
      database (ADR-0087 Decision 6). A start that overran because of its own
      size would overrun again on every retry, so the time of the longest
      storyboard must be measured where the database is reached over a
      network, and the copies batched if it comes near the limit.
- [ ] **Decide what closes a cancelled job's open scenes.** Transaction L
      closes only a `FAILED_TERMINAL` job's (ADR-0084, *Not decided here*). A
      job `CANCELLED` before it generated may leave `PENDING` scenes; nothing
      cancels a job today.
- [ ] **Serve the customer's video from storage (GS-12).** The download route
      reads a whole object into memory and names its content type from the
      key's extension; a deliverable's key has none, and a video may be
      hundreds of megabytes (ADR-0085, *Not decided here*). Preview and
      download need a streamed response with the video's own content type,
      over the shared folder now and over Google Cloud Storage in production.
- [ ] **Remove what a killed process leaves in the shared folder.** An upload
      a crashed worker never completed or aborted, a staged file a killed
      process never moved, and the empty folders a deleted key leaves stay in
      the folder (ADR-0085, *Not decided here*). Deleting the folder starts
      over; nothing in production uses it.
- [x] **Move the execution preflight's failures onto the orchestration
      state.** `failQueuedPreflight` (Phase 4C-2B, ADR-0027) records a refused
      attempt in the legacy `state` column and leaves its orchestration state
      `QUEUED`, so an orchestrated attempt that fails preflight has not ended
      in the vocabulary Transaction K reads, its request is never settled, and
      the customer's Unit stays held (ADR-0083, *Not decided here*). The state
      machine already has `QUEUED -> FAILED_*` and
      `QUEUED -> CANCELLED_PRE_SUBMISSION`. Must be built before generation is
      activated. *Since GS-7c-1 (ADR-0096 Decision 1) `failQueuedPreflight`
      leaves an orchestrated attempt alone: it writes nothing and answers
      `null`. Ending an orchestrated attempt's terminal preparation refusal in
      its orchestration state is planned for GS-7c-2. Built in GS-7c-2a
      (ADR-0097, no migration), and called by the sender from GS-7c-2b: a
      `TERMINAL` refusal, by the canonical disposition, ends the attempt
      `QUEUED → CANCELLED_PRE_SUBMISSION` with the reason as its code, behind
      the cost-admission lock, and K settles it. `QUEUED → FAILED_*` is refused by the schema without a boundary
      instant. A `RETRYABLE` refusal leaves the attempt `QUEUED` to be
      prepared again, which the item on bounding how long an attempt may run
      now covers.*
- [ ] **Decide whether a photo changed while its URL is signed ends an
      orchestrated attempt.** Preparation's `ASSET_SOURCE_CHANGED` is
      `TERMINAL` in the canonical table (ADR-0027), so once the sender calls
      the GS-7c-2a ending, such an attempt ends and its Unit is released
      (ADR-0097 Decision 2). The gate's
      `ASSET_SOURCE_CHANGED`, the same change found after preparation, leaves
      the attempt `QUEUED` to be prepared again (ADR-0096). A `READY` photo
      has no production route into re-processing (ADR-0029), so neither is
      expected; if one appears, the two should agree. Changing the table also
      changes the legacy park.
- [ ] **Keep attempts that cannot be sent from filling the submission
      window (GS-7c-2b, GS-9).** Discovery is one window over every
      organization, oldest first (ADR-0097 Decision 1). An attempt left
      `QUEUED` by a preparation refusal that may pass, or by a gate refusal
      that writes nothing (a hard pause, an ineligible price, a route not
      authorized), is offered again on every pass; once a window's worth of
      them are the oldest, no newer attempt in any organization is found, so
      one organization's incident would stop every other's. The pass must
      move past them, as the launch must past jobs that cannot launch
      (ADR-0095 Decision 7). Must be settled before generation is activated.
      *GS-7c-2b (ADR-0098 Decision 6) builds the means:* discovery reads after
      a `{ createdAt, id }` cursor and each pass returns `next`. Still open:
      the pipeline command (GS-9) must pass each `next` to the following pass,
      and stop only after a whole cycle, from the oldest until a pass returns
      `next: null`, in which nothing was sent or ended, since a full window of
      waiting attempts sends and ends nothing while newer ones wait behind it;
      and at once on a pass that reports `stopped`.
- [ ] **Decide whether a refusal the deployment causes ends a customer's
      attempt.** `PROVIDER_IDENTITY_MISMATCH` and
      `MODEL_DELIVERY_PLAN_CHANGED` are `TERMINAL` (ADR-0027) but come from
      the deployment's model catalog, not the customer's photo or request.
      Once the sender calls the ending (GS-7c-2b), a worker with a
      misconfigured catalog, or an older worker during a rollout, would end
      every attempt it prepares, and Transaction K would fail those jobs,
      releasing their Units; only an operator could recover them (ADR-0052
      Decision 20). Whether such a refusal ends the attempt or leaves it for a
      correctly configured worker is not decided (ADR-0097 Decision 2). Must
      be settled before generation is activated.
      *GS-7c-2b (ADR-0098):* the runner now calls the ending for both. An
      attempt admitted for another provider is passed over before it is
      prepared (`OTHER_PROVIDER`, nothing written), so a worker for another
      provider never ends one; a misconfigured catalog, or an older catalog
      during a rollout, still would.
- [ ] **Build Unit accounting per ADR-0053.** *Ledger foundation built in
      Phase 6A (ADR-0055):* non-carrying period-bound blocks, the
      eligibility-first order (see the two items below) and renewal-period
      binding frozen on the reservation. *UP-1 (ADR-0066) shows what is left on
      the Units page. UP-2 (ADR-0067) records a customer-approved purchase and
      grants its block in one transaction. UP-3 (ADR-0068) lets a `billing.manage`
      holder buy a package from the purchase screen. UP-4 (ADR-0069) lists the
      period's purchases on the Units page and exports invoice-paid purchases
      for invoicing. UP-5 (ADR-0070) lets an operator cancel a mistaken
      purchase, withdrawing its unused Units.* **Still unbuilt:** renewal scheduling that opens periods,
      no automatic overage at the purchase boundary, and no cancellation after a
      paid Provider submission.
- [ ] **Check the approved package prices against the provider cost floor**
      once a provider route is verified (ADR-0067 Decision 1). The package
      price formula takes a profitability floor derived from provider cost;
      the catalog carries the approved ADR-0053 Decision 2 prices with no floor
      applied, because no route is verified and paid activation is BLOCKED. If a
      verified route's cost puts any approved price below its floor, the price
      goes back to the product owner rather than being raised in code.
- [x] **Decide how a purchase made in error is corrected** — **DECIDED and
      built (UP-5, ADR-0070).** The product owner decided on 2026-10-19 and
      revised it the same day: only VTaVision's own mistake is free. A
      purchase VTaVision made by mistake is cancelled whenever it is found:
      its unused Units are withdrawn, its used Units stay used, and it is not
      invoiced, used Units included. A purchase the customer made by mistake
      is charged, unless it is cancelled within 10 hours of its approval with
      none of its Units used. An operator judges whose mistake it was and
      runs `cancel-unit-purchase --fault`, which records the cancellation,
      audited, under the period's lock; a withdrawn block funds no new
      reservation; the export marks the purchase cancelled with nothing to
      invoice; the Units page says so. A purchase already invoiced is
      refunded or offset by hand. *Before: ADR-0067 Decision 2 kept a
      purchase and its block as permanent evidence, and UP-4 (ADR-0069
      Decision 7) listed a credited purchase again; the recommendation put to
      the product owner, an audited credit with the Units left in place, was
      not the one chosen.*
- [x] **Build a quality-tagged additional-Unit ledger.** *Built in Phase 6A
      (ADR-0055): `unit_add_on_blocks`, quality-locked at the schema level by a
      composite foreign key; an HQ block on a plan that sells none is refused.*
      ADR-0053 Decision 2.
      Each add-on block carries the quality it was bought at, and the ledger must
      be able to **refuse** an ineligible block rather than treat added Units as
      one pool. No conversion, exchange, refund or substitution path may exist.
- [x] **Build eligibility-first reservation and consumption.** *Built in Phase
      6A (ADR-0055): multi-source allocation per the CTO's Option A, frozen at
      reservation, all-or-nothing, settled with the reservation by Transaction G
      and every release path.* ADR-0053
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
- [x] **Remove `REVIEWER` from the role vocabulary** where it survives in code
      or schema, and confirm nothing gates final-video delivery on an approval.
      Source-photo review becomes `analysis.review`. *Done in Phase 6C
      (ADR-0057): migration 19 recreated `Role` and mapped `REVIEWER` to
      `VIEWER`; source-photo review checks `analysis.review`; a shape test keeps
      `REVIEWER` out of every production source file.*
- [ ] **Build the approved role-template grant matrix.** ADR-0052 Decision 10 now
      fixes every template's grants and its role-fixed Scope. Decide whether defaults are
      stored as rows or derived from the matrix, and make a stored copy
      reproducible from it. `disclosure.none` and `video.share` must be
      unreachable by role assignment alone, and MFA enforcement must stay
      capability-based so `BILLING` is covered through `billing.manage`.
      *Built in Phase 6C (ADR-0057): the matrix is derived from code, not stored
      as rows, and pinned cell for cell against the ADR table; no template grants
      `disclosure.none` or `video.share`. **Still unbuilt:** MFA enforcement for
      `billing.manage` holders.* *MFA-1 (ADR-0065) works out who must use MFA,
      `billing.manage` included, and MFA-3 enforces it (Decision 15).*
- [ ] **Enforce the role grant ceilings and protected authority.** ADR-0052
      Decision 10. Every authorization mutation must answer "may *this actor*
      grant *this*?", not merely "does the actor hold `permission.manage`?":
      `OWNER` assigns any role, `ADMIN` only `MANAGER`/`CREATOR`/`VIEWER`, and
      `permission.manage` / `billing.manage` / the `OWNER`,`ADMIN`,`BILLING` role
      assignments / ownership-equivalent changes / anything touching the last
      `OWNER` are `OWNER`-only. *Role-assignment ceiling built in Phase 6C
      (ADR-0057) on invitation, acceptance, role change and removal. **Still
      unbuilt:** the `OWNER`-only grant of `permission.manage` and
      `billing.manage`, which needs individual grants.* *Individual-grant
      ceiling built in Phase 6D (ADR-0058): `permission.manage`, `billing.manage`
      and `disclosure.none` are `OWNER`-only to grant and revoke; an `ADMIN`
      grants only to `MANAGER`/`CREATOR`/`VIEWER` members and only what it holds.*
- [ ] **Prevent self-escalation across every grant path.** Direct role change,
      individual grant, group membership, group permission and Scope
      manipulation must each be ceiling-checked — the additive group model is the
      obvious loophole and must not be one. A refused escalation attempt is an
      audited event, not a silent no-op. *Direct role change, invitation and its
      acceptance built in Phase 6C (ADR-0057), each refusal audited as
      `member.role_change_refused`. **Still unbuilt:** the individual-grant,
      group and group-permission paths.* *Individual-grant path built in Phase
      6D (ADR-0058), each refusal audited as `permission.grant_refused`. **Still
      unbuilt:** the group and group-permission paths.* *Group-membership path
      built in Phase 6F (ADR-0060): adding or removing a member asks the
      role-assignment ceiling of the member's role, each refusal audited as
      `group.change_refused`. **Still unbuilt:** the group-permission path.*
      *Group-permission path built in Phase 6G (ADR-0061): giving or taking a
      group permission, adding or removing a member of a group that carries
      any, and deleting such a group are each checked as a direct grant or
      revocation to every member reached, under a lock on the group row, each
      refusal audited as `group.change_refused`. **Still unbuilt:** Scope
      manipulation (Property assignment).*
- [ ] **Confirm the Phase 6C choices ADR-0052 did not make** (ADR-0057). None
      changes any member's access today; each matters once individual grants
      exist. (1) Existing `REVIEWER` members and invitations became `VIEWER`, the
      least-privileged template. (2) Creating a video project and composing its
      storyboard check `video.generate`; starting or refreshing a source-photo
      analysis checks `asset.upload` — the ADR names no permission for these.
      (3) Starting a scene checks `video.generate` **and** `unit.consume`.
- [ ] **Confirm the Phase 6D choices ADR-0052 did not make** (ADR-0058).
      (1) A non-`OWNER` grants or revokes only a permission it effectively holds.
      (2) Individual grants survive a role change; effective permissions
      recompute from the new role with the `property.create` ceiling applied.
      (3) Granting `property.create` to a `VIEWER` or `BILLING` member is refused
      rather than stored as an ineffective row. (4) A repeated grant is a no-op;
      revoking an absent grant is `NOT_FOUND`.
- [ ] **Confirm the Phase 6F choices ADR-0052 did not make** (ADR-0060).
      (1) Adding or removing a group member follows the role-assignment
      ceiling: an `ADMIN` changes only `MANAGER`, `CREATOR` and `VIEWER`
      members, never itself, and no role below `ADMIN` changes anyone, even
      with `group.manage`. (2) A group name is required, trimmed, at most 100
      characters and unique within its organization by exact match; renaming
      to the current name changes nothing. (3) Group memberships survive a
      role change. (4) A repeated addition changes nothing; removing a member
      who is not in the group is `NOT_FOUND`. (5) Leaving the organization ends
      a member's group memberships with no `group.*` audit entry; its
      `member.removed` entry records the removal.
- [ ] **Confirm the Phase 6G choices ADR-0052 did not make** (ADR-0061).
      (1) `permission.manage` and `billing.manage` may be carried by a group,
      but only an `OWNER` can give them, take them away, or change the
      membership of a group that carries them; the narrower alternative would
      forbid both on groups. (2) Changing a group's permissions needs
      `permission.manage`, not `group.manage`. (3) An `ADMIN` cannot delete a
      group whose deletion would take away a permission it could not revoke
      directly. (4) Group permissions survive a member's role change; the
      `property.create` ceiling keeps applying. (5) Leaving the organization
      ends group-derived permissions with no `group.*` entry; its
      `member.removed` entry records it. (6) A repeated grant to a group
      changes nothing; taking away a permission the group does not carry is
      `NOT_FOUND`.
- [ ] **Confirm the Phase 6H choices ADR-0052 did not make** (ADR-0062).
      (1) When a responsible user leaves the organization, its Properties
      become unassigned; the removal is not blocked, and `member.removed`
      records how many. (2) Any member but `BILLING` may be chosen as a
      responsible user; a later role change keeps an existing assignment.
      (3) An `OWNER` or `ADMIN` who chooses nothing leaves both assignments
      unset, with no default to the creator. (4) A `MANAGER` in no group cannot
      create a Property; one in several groups must name one. (5) Reassignment
      needs the `OWNER` or `ADMIN` role, not a permission. (6) An assignment
      that changes nothing writes nothing.
- [ ] **Confirm the Phase 6I choices ADR-0052 did not make** (ADR-0064).
      (1) A Property out of reach, and anything under it, is answered exactly
      as one that does not exist (`404`, or an empty list), never `403`.
      (2) An out-of-reach answer is not audited, as a cross-tenant `404` is
      not. (3) Reach is read when the member is authorized: an action already
      authorized completes, and a signed URL already issued stays valid until
      it expires (10 minutes for an upload, 5 for a download). (4) A `MANAGER`
      is judged by its groups only, even for a Property it is the responsible
      user of.
- [ ] **Decide what a deleted Property's existing video projects allow**
      (found in Phase 6I-2, ADR-0064 Decisions 5 and 9). Since 6I-2 a deleted
      Property takes no new video project and lists none. A project created
      before the deletion can still be read and composed through the
      storyboard paths, and generation admission accepts its storyboard if it
      is fresh; the worker then treats its photos, awaiting deletion, as
      unrecoverable sources (`execution-source.ts`). The pages under
      `/properties/{id}` show a deleted Property as not found. ADR-0052 does not say whether those projects should be
      refused too, or stay reachable until retention removes them. *Since
      GS-4c the whole-video start answers such a project as not found
      (ADR-0088 Decision 1): its photos could not be generated from, so a
      start would only reserve Units for a job certain to fail; the start
      commit checks it again under its lock, so a deletion saving at the same
      moment is not missed. Reading, composing and single-scene admission are
      unchanged.*
- [x] **Build authenticator-app MFA and recovery codes** (ADR-0052 Decision 18,
      ADR-0065), in four pull requests approved on 2026-10-15. *MFA-1 built the
      foundation: migration 25, TOTP, the sealed secret, recovery codes, who
      must use MFA, and `MfaService` with audit. MFA-2 added the security page
      (set up, move to a new device, new recovery codes, turn off when
      optional) and the code step at sign-in. MFA-3 made it mandatory: someone
      who must use MFA and has not set it up reaches only set-up and sign-out
      (Decisions 15 to 17). MFA-4 added an organization's requirement for all
      members, changed by an `OWNER` or `ADMIN` (Decisions 18 and 19).*
- [ ] **Confirm the MFA choices ADR-0052 did not make** (ADR-0065 Decision 11).
      (1) MFA is checked once per sign-in. (2) No grace period once it is
      mandatory. (3) A grant to someone without MFA is allowed; MFA is required
      from their next request. (4) Mandatory in any organization means MFA for
      every sign-in. (5) Five wrong codes end a sign-in; ten recovery codes of 16
      characters. (6) An `OWNER` or `ADMIN` changes the organization-wide
      requirement. (7) A session that passed MFA may move it to a new
      authenticator, which issues new recovery codes. (8) MFA is turned off with
      a current authenticator code, not a recovery code. Choices 1 to 6 were
      approved with the plan on 2026-10-15; 7 and 8 were added in MFA-1.
- [ ] **Decide what MFA leaves open** (ADR-0065). (1) Operator-assisted
      recovery for someone who has lost both their device and their recovery
      codes; since MFA-3 this can lock any `OWNER` out of their organization. (2) Re-sealing every secret under a new `MFA_SECRET_KEY`; today a
      changed key makes existing set-ups unusable. (3) Whether turning MFA on,
      moving it or turning it off should end the user's other sessions. Since
      MFA-2, turning it on asks the other sign-ins for a code; moving it or
      turning it off leaves them signed in. (4) The
      five-wrong-codes guard is per sign-in, so until rate limiting exists
      (ADR-0054 Decision 5) a person with the password can sign in again and try
      more codes; rate limiting should ship before MFA is relied on in
      production. (5) Turning MFA on asks for the signed-in session only, not
      the password again (ADR-0052 Decision 10 adds no step-up), so someone
      holding another person's session, on an account without MFA, could turn
      it on and lock them out. (6) Without `MFA_SECRET_KEY`
      someone with MFA on cannot finish signing in, and since MFA-3 no one who
      must use MFA can sign in (ADR-0065 Decision 14). The readiness probe
      reports the missing key since MFA-3 (Decision 17); what remains is
      deciding whether the web app should refuse to start without it. (7)
      Whether members should be told, other than at their next request, when an
      organization turns on its MFA requirement; there is no email-sending
      service (MFA-4).
- [x] **Commit each membership change together with its audit entry.** Done
      in Phase 6E (ADR-0059): invitation, acceptance, role change and removal
      each write their rows and audit entry in one transaction, in the
      repository.
- [x] **Make the last-`OWNER` check race-free.** Done in Phase 6E (ADR-0059):
      demoting or removing an `OWNER` locks the organization's `OWNER`
      memberships (`FOR UPDATE`, in `userId` order), counts them and writes in
      one transaction. A role change or removal also applies only while the
      member still holds the role its ceiling was checked against, and an
      invitation leaves `PENDING` exactly once.
- [ ] **Refuse a second pending invitation of the same email atomically.** The
      pending-invitation check (Phase 6C) is a read, so two concurrent
      invitations of one email to one organization can both be created. Each
      acceptance is still checked, so this creates no access. Closing it needs a
      partial unique index on (`organizationId`, `email`) where `PENDING`, that
      is, a migration.
- [ ] **Create an organization in one transaction.** Organization creation
      (`POST /api/organizations`, reachable today) writes the organization, the
      founding `OWNER` membership and `organization.created` in separate steps.
      A crash between them leaves an organization no one belongs to (which no
      one can reach) or one created unaudited. The same repository pattern as
      ADR-0059 closes it.
- [x] **Audit every role, permission, group and Property-assignment change**,
      recording the acting user, so a ceiling violation is both preventable and
      detectable after the fact. *Role, individual-permission and group changes
      audited (Phases 6C, 6D, 6F), each committed with its change (ADR-0058,
      ADR-0059, ADR-0060). **Still unbuilt:** group-permission and
      Property-assignment changes.* *Group-permission changes audited in Phase
      6G (ADR-0061), each committed with its change. **Still unbuilt:**
      Property-assignment changes.* *Done in Phase 6H (ADR-0062): a Property's
      creation with its initial assignments, every assignment change and every
      refused assignment are audited, each change committed with its entry.*
- [ ] **Build permanent technical-failure terminal settlement.** ADR-0052
      Decision 19. *Built for the deliverable failure points in GS-1
      (ADR-0082): a `BLOCKED` composition and an `INVALID_MEDIA` (on-plan or
      off-plan) or `INTEGRITY_MISMATCH` verdict fail an initial generation's
      job and release its reservation, or return a replacement to the
      customer's video, in their own commit, identically.* *Built for the
      provider-side failure points in GS-2a (ADR-0083): a sweep, Transaction
      K, settles a scene request whose attempts all ended, the newest without
      a video (a refusal, a provider failure, an unresolved submission),
      failing an initial
      generation and releasing its Unit or rolling a regeneration back to the
      customer's video, identically whichever way the attempt ended.*
      *Built for the failed job's other scenes in GS-2b (ADR-0084): a sweep,
      Transaction L, closes each open scene of a failed job once nothing of it
      is at the provider, cancelling an attempt still waiting to be sent, for
      Transactions H and K alike.*
      ***Still unbuilt:*** *an attempt that never ends, which keeps its
      request out of Transaction K and its scene open, and an attempt that
      fails preflight (items below); the release of a paid regeneration's or a charged disclosure change's
      own reservation, and the disclosure-change count, built with them;
      Transaction G's defects and a claim refused as `UNSUPPORTED_TARGET`,
      which write no terminal row (ADR-0082, "Not decided here"). And a
      replacement that fails after a scene regeneration was delivered leaves
      that scene's delivered pointer on the new rendition and its
      regeneration right counted, while the customer keeps the earlier video:
      an open decision gate below.* The
      original item: A failed initial generation, paid regeneration or
      disclosure/logo recomposition must terminally settle and **RELEASE** the
      reservation, never `CONSUMED` and never left pending; a failed regeneration
      or recomposition must preserve the previous valid deliverable as current; a
      failed recomposition must not increment the disclosure-change count; and
      `BLOCKED` / `INVALID_MEDIA` / `INTEGRITY_MISMATCH` must settle identically
      for billing. Includes choosing whether an existing domain state represents
      this or a new one is required — **the ADR deliberately does not pick one.**
      It must also reach a version Transaction G refuses with
      `DISCLOSURE_NOT_DRAWN` or `CLEAN_MASTER_NOT_RECORDED` (ADR-0080
      Decision 4): its job stays `DELIVERABLE_VALIDATING` and an initial
      generation's reservation stays `RESERVED`, as for Transaction G's other
      defects, until this or operator recovery exists. Only development data
      or a row altered by hand can be in that state today. Since DS-6b
      (ADR-0081 Decision 4) a composer mistake would reach it too: a video
      that is not its planned size or length is an `INVALID_MEDIA` verdict,
      whose reservation stays `RESERVED` until this is built.
- [ ] **Build operator recovery tooling.** ADR-0052 Decision 20 plus ADR-0054
      Decision 6: an internal-only privilege reachable by no customer role, the
      original `BLOCKED` row and terminal verdict left immutable, a **new**
      recovery cycle rather than a re-queue, the enumerated audit fields, and
      per-row transactional/CAS-safe action with per-row eligibility
      re-evaluation. **No global per-cause revert.** It must also reach
      composition work left `PENDING` or `RUNNING` under a profile the running
      build does not carry, and a version planned under a disclosure mode it
      does not draw: discovery no longer offers either and the claim refuses
      both (ADR-0077 Decision 4), so without this tooling the job stays
      `COMPOSING` or `COMPOSITION_PENDING`. Only development data can be in
      that state today. It must also reach composition work held by a defect,
      such as a stored video found without its Clean Master
      (`CLEAN_MASTER_MISSING`, ADR-0078 Decision 4), which is re-claimed and
      fails again every lease period. And it must reach a version validation
      discovery no longer offers and Transaction G refuses, one whose
      composition drew no disclosure or whose Clean Master is not recorded
      (ADR-0080 Decisions 4 and 5): its job stays `DELIVERABLE_VALIDATING`
      and its reservation `RESERVED`. The same holds for a `VALID` verdict
      whose stored facts are off its plan, which discovery no longer offers
      and Transaction G refuses (ADR-0081 Decision 3); only a row altered by
      hand, or one written by a fake validator before DS-6b, can be one. And
      it must reach work whose failure cannot settle because its reservation
      contradicts its job (`RESERVATION_NOT_SETTLEABLE`, ADR-0082 Decision 2):
      the block or verdict rolls back, and the work is re-offered and repeated
      every lease period, re-encoding or re-probing each time. And it must
      reach a scene request Transaction K refuses for its shape or its
      reservation (`SHAPE_CONFLICT`, `RESERVATION_NOT_SETTLEABLE`, ADR-0083
      Decision 3): the candidate query never offers it again, so its job stays
      `GENERATING` and an initial generation's Unit held until an operator
      acts. Nothing in production can produce one today.
- [ ] **Make a composition defect findable before composition is activated.**
      The runner isolates a defect per candidate and reports only a `failed`
      count (ADR-0050); nothing durable names the row or the defect's code, so
      an operator cannot tell which deliverable is held, or why. Record the
      composition's id and the code where an operator can read them, without
      a storage key, signed URL or provider payload. *The same holds for the
      validation sweep, which isolates its candidates since DS-6a (ADR-0080)
      and reports a defect's code in that pass's report only: a version
      Transaction G refuses is held, unnamed, until an operator acts.* *Since
      GS-1 the same holds for a settlement defect (ADR-0082): the validation
      sweep reports its code, the composition sweep only counts it.*
- [x] **Record which plan an organization is on, and renew its periods.**
      *Built in Phase 6B (ADR-0056): one `organization_subscriptions` row per
      organization (plan, channel, anchor, commercial reference; Enterprise
      sales-assisted only), monthly periods derived from the anchor, and
      on-demand idempotent renewal through the Phase 6A ledger with no scheduler.*
      *Since UP-1 (ADR-0066) an operator command provisions a sales-assisted
      subscription and the Units page reads it.* No application code renews a
      period yet.
- [ ] **Replace the plan-provisioning command with an operator console** that
      has its own sign-in. The command of ADR-0066 records the operator's name as
      declared, not authenticated: anyone with the database credentials can
      write any name. ADR-0054 Decision 6.
- [ ] **Build subscription billing, cancellation and plan changes.** ADR-0053
      Decisions 1A, 3A and 3B: monthly Stripe recurring billing with automatic
      renewal; cancellation effective at period end with no proration; the refund
      exceptions that remain owed; immediate upgrade charging the full unprorated
      difference (*since 2026-10-28 the upgraded plan is charged pro-rata for
      the month and the old plan's unused days are not credited, ADR-0093*)
      with the base-Unit ceiling **replaced minus Base Units consumed** (*for
      the month of the switch, since 2026-10-28, the old plan's plus the new
      plan's for the days charged, rounded down, ADR-0093*);
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
- [x] **Build Property-rooted Scope enforcement** (ADR-0052 Decision 10):
      durable Property → responsible user and Property → zero-or-one group
      relationships and user → group memberships (*user → group memberships
      built in Phase 6F, ADR-0060*); the `GROUP` union predicate
      and the `OWN` assignment predicate; child-resource reachability inherited
      from the Property; reassignment and membership-change effects; no
      authorship-based row authorization; no implicit scope widening through
      individual grants; tenant-safe row-level checks throughout. *Property →
      responsible user and Property → group built in Phase 6H (ADR-0062).
      **Still unbuilt:** the predicates and their enforcement on every content
      path (6I).* *The `GROUP` and `OWN` predicates, reassignment and membership
      changes taking effect on the next request, no authorship-based
      authorization and no widening by grants, built in Phase 6I-1 (ADR-0064)
      on the Property and photo paths.* *Done in Phase 6I-2 (ADR-0064):
      analyses and their review, video projects, storyboards and generation
      admission inherit their Property's reach.*
- [x] **Build Property assignment and role-fixed Scope** (ADR-0052 Decision
      10): `OWNER`/`ADMIN`-only Property reassignment; creation-time assignment
      rules by creator role — `MANAGER` responsible user fixed to the creator
      and group validated as exactly one of the creator's current groups (never
      ungrouped), `CREATOR` responsible user fixed to the creator and group
      fixed to unset, `OWNER`/`ADMIN` same-organization validation; the fixed
      role → Scope mapping with no standalone Scope mutation; Scope derived on
      role change without rewriting assignments; grants never widening Scope;
      and audit evidence for every Property creation (organization, Property,
      creating user and role, initial responsible user and group, timestamp),
      assignment change and role change. *Built in Phase 6H (ADR-0062): the
      creation-time rules, `OWNER`/`ADMIN`-only reassignment and the audit
      evidence. Role changes already rewrite no assignment and grants never
      touch them. **Still unbuilt:** applying the role → Scope mapping when
      authorizing content (6I).* *Applied on the Property and photo paths in
      Phase 6I-1 and on every other content path in Phase 6I-2 (ADR-0064).*
- [x] **Enforce the `property.create` capability ceiling** (ADR-0052 Decision
      10): effective-permission calculation that combines template, direct and
      group grants and then applies the role ceiling, so `property.create` is
      never effective for `VIEWER` or `BILLING` from any source; grant
      validation that does not present a direct `property.create` for those
      roles as a supported configuration; and tests covering direct and
      group-derived grants for both roles. *Direct grants built in Phase 6D
      (ADR-0058): refused at grant time and filtered from the effective set.
      **Still unbuilt:** group-derived grants.* *Done in Phase 6G (ADR-0061
      Decision 2): a group's `property.create` is never effective for a
      `VIEWER` or `BILLING` member.*
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
- [x] **Build the billing-cycle revenue reader for the Cost Safety Guard**
      (decided 2026-10-27, *Decision gates — CLOSED*): the plan's monthly price
      plus the period's uncancelled Unit purchases, tax-exclusive; Enterprise
      unknown until its contracted price is recorded. *Done in GS-5b
      (ADR-0091, no migration): `billingCycleRevenueYen` is the rule, and the
      gate's session reads it from the cycle's entitlement period on the
      gate's own transaction (`readBillingCycleRevenueWithin`). Plan prices are not versioned, so a price change would change
      an open period's revenue (ADR-0091 Decision 4). Where an Enterprise
      contracted price comes from was decided on 2026-10-28 (ADR-0093) and is
      listed next.*
- [ ] **Record an Enterprise organization's contracted monthly amount, and
      count it as its cycle's revenue** (ADR-0093 Decision 2). The
      plan-provisioning command (ADR-0066) takes the agreed monthly amount for
      an Enterprise plan and records it with the subscription, audited; the
      revenue reader counts it as the cycle's plan revenue. The amount is
      entered tax-exclusive (decided 2026-10-28, *Decision gates — CLOSED*).
      Needs a migration. Planned as a small PR after the generation-to-preview
      plan.

### Decision gates — OPEN

Five gates: one found by the Phase 6A gap analysis
(`docs/phase-6a-gap-analysis.md`), one by Phase 6B (ADR-0056), two by GS-1
(ADR-0082), one by GS-5b (ADR-0091). **None may be guessed.** Every other gate is closed and recorded
below.

- [ ] **Decide whether a failed replacement gives back the scene regeneration
      right that started it** — does not block GS-1, whose rollback changes no
      regeneration right. Transaction F counts the customer's right and moves
      the scene's delivered pointer to the new rendition when the regenerated
      scene is delivered. If the replacement video made from it then fails
      composition or validation, GS-1 returns the customer to the earlier
      video and leaves both: the right stays counted and the pointer stays on
      the new rendition. When the failure came from that rendition's own bytes
      (`SOURCE_INTEGRITY_MISMATCH`, `SOURCE_BYTES_LIMIT_EXCEEDED`), every later
      revision plans it again and fails the same way, until the scene is
      regenerated once more. A regeneration that fails before its scene is
      delivered spends no right (its request ends `FAILED_TERMINAL`; "a right
      is spent when a usable rendition reaches the customer",
      `generation-regeneration-entitlement.db.test.ts`), so today whether the
      right comes back depends on which stage failed, which ADR-0052 Decision
      19 may forbid. Whether the right comes back and the
      pointer returns must be settled before scene regeneration is offered to
      customers, together with the regeneration price gate below.

- [ ] **Decide whether a video delivered by operator recovery consumes a Unit**
      — does not block GS-1, which builds no recovery. ADR-0052 Decision 19
      releases a failed initial generation's Unit, and Decision 20 lets an
      internal operator recover it as a new cycle. Since GS-1 the failed job is
      `FAILED_TERMINAL`, which has no outgoing edge, so a recovery is a new job,
      and a new job reserves a Unit. Whether the recovered video, once
      delivered, consumes the customer's Unit (they asked for it and receive
      it) or is free (VTaVision's failure, already released) is not decided.
      Must be settled before operator recovery is built.

- [ ] **Decide what a customer regeneration costs in Units** — does not block
      Phase 6A, which builds no regeneration pricing and does not treat today's
      free regeneration as commercial policy. Today one job entitlement covers an initial generation and up to
      two per-scene user regenerations, and a replacement publication consumes
      nothing; ADR-0052 Decision 4 says customer-requested content regeneration
      consumes additional Unit(s). Whether a per-scene regeneration costs the
      scene's Units, the whole video's, or one Unit is undecided, and must be
      settled before paid regeneration is built.
- [ ] **Decide what happens to a self-service renewal whose payment fails** —
      does not block Phase 6B, which provisions no self-service subscription from
      a payment and wires no caller. Renewal today opens the period containing an
      instant for any provisioned subscription, which is right for sales-assisted
      contracts. No approved decision covers dunning: whether a failed monthly
      charge withholds the new period's Units, grants them during a grace window,
      or suspends generation, and when the subscription ends. Must be settled
      before self-service Stripe billing is built.
- [ ] **Decide whether plan prices are versioned** — from GS-5b (ADR-0091);
      does not block the test route. The reader prices a period's plan at the
      catalog's current price, so a future change to a plan's list price would
      change the revenue of a period already open. Must be settled before a
      plan price changes. *Where an Enterprise organization's contracted price
      comes from, the other half of this gate, was decided on 2026-10-28
      (ADR-0093 Decision 2, CLOSED below).*

### Decision gates — CLOSED

Thirty-seven decisions: the two gates from the first PR review, eight recorded
with them, the two raised by the exact-head review of those closures, the
`disclosure.none` grant authority that synchronizing the grant ceiling exposed,
in-flight Mode C, commercial-mutation authority, the Clean Master,
additional-seat cancellation, mid-period purchases, downgrade fit,
charged-recomposition quality, logo-only recomposition, repeatable storage
blocks, storage blocks on downgrade, Scope semantics, Property assignment
authority, role-fixed Scope, and the three closed last — the `property.create`
capability ceiling, fixed `MANAGER`/`CREATOR` creation-time assignments and
protected group deletion — from the Phase 6A gap analysis, multi-Unit
reservation funding, from the Unit purchase proposal, when an
invoice-paid organization can use purchased Units, from GS-5, what a
billing cycle's revenue is, and, on 2026-10-28, how a mid-month upgrade is
charged, that it credits nothing, that its Base-Unit ceiling is pro-rated,
where an Enterprise organization's revenue comes from and that its amount is
entered tax-exclusive (ADR-0093).
**Each is settled as policy**; the implementation work each
one creates is listed in the section above.

- [x] **How a mid-month plan upgrade is charged — CLOSED (the upgraded plan
      by the day, for that month).** Decided by the product owner on
      2026-10-28 in the CTO thread:
      「月の途中で切り替えた場合は、その月はアップデートしたプランを日割りで請求。」
      From the day of the switch to the end of that billing month the
      upgraded plan is charged by the day. This replaces ADR-0053 Decision
      3B's "full difference … do not prorate" for upgrades (ADR-0093
      Decision 1); the rest of Decision 3B, downgrade included, stands.
      The old plan's unused days are not credited, and the Base-Unit ceiling
      is pro-rated alike (the next two entries). Nothing builds plan upgrade
      yet.

- [x] **Whether an upgrade credits the old plan's unused days — CLOSED (it
      does not).** Decided by the product owner on 2026-10-28 in the CTO
      thread: 「アップグレードした月は前のプランの残り日数は差し引きません。」
      The old plan's price for the month, already billed, stands in full; the
      upgraded plan's pro-rated days are charged on top (ADR-0093 Decision 1).

- [x] **Whether an upgrade's Base-Unit ceiling is pro-rated — CLOSED (it is,
      added to the old plan's).** Chosen by the product owner on 2026-10-28
      (decision card, option 「日割り」, which read: 「前のプランの Unit はそのまま、
      新プランの Unit を残り日数で日割りして足します(端数は切り捨て、HQ 上限も
      同じ)。」). For the month of the switch the ceiling is the old plan's Base
      Units plus the new plan's for the days charged, rounded down, less the
      Base Units consumed this period; the included HQ ceiling alike; from the
      next renewal the new plan's ceiling applies whole. This replaces ADR-0053
      Decision 3B's "replaced, not stacked" for that month (ADR-0093 Decision
      1). How a day is counted is to be proposed when plan upgrade is built.

- [x] **Where an Enterprise organization's revenue comes from, for the Cost
      Safety Guard — CLOSED (the contracted amount the operator records).**
      Decided by the product owner on 2026-10-28 (typed 「１、２はそれで決定。」,
      answering two questions in the CTO thread; the second's recommendation,
      「契約額を登録」, read: 「Enterprise を登録するときに合意した月額も入力し、
      安全装置はその額で計算します。」). When an operator provisions an
      Enterprise plan, the agreed monthly amount is recorded with it, and the
      Cost Safety Guard counts that amount as the cycle's plan revenue
      (ADR-0093 Decision 2). An Enterprise cycle with no recorded amount stays
      unknown and keeps pausing. The amount is entered tax-exclusive (next
      entry); implementation is listed above (*Record an Enterprise
      organization's contracted monthly amount*).

- [x] **How an Enterprise organization's contracted amount is entered —
      CLOSED (tax-exclusive).** Decided by the product owner on 2026-10-28 in
      the CTO thread: 「税抜で入力」. It is entered tax-exclusive, as the
      revenue rule counts every other figure (ADR-0091; ADR-0093 Decision 2).

- [x] **What a billing cycle's revenue is, for the Cost Safety Guard — CLOSED
      (the plan's monthly price plus Unit purchases).** Chosen by the product
      owner on 2026-10-27 (decision card, option "月額+Unit購入", the
      recommendation). A cycle's revenue is the plan's monthly price plus the
      Unit purchases approved in that period, both tax-exclusive (the card's
      words). Seats and storage blocks are not counted while they are not
      recorded, and an Enterprise organization's revenue stays unknown, so the
      guard keeps pausing, until its contracted price is recorded (both on the
      card). A cancelled purchase counts nothing: ADR-0070 withdraws it and
      invoices nothing for it. Payment fees were not part of the question: no
      card payment exists yet. The paid-submission gate (`safety-guard.ts`)
      compared revenue with cost but no ADR said what counted, and the only
      reader answered unknown, pausing every cycle. To be built by GS-5b, the
      revenue reader (*Implementation work* above).

- [x] **Multi-Unit reservation funding — CLOSED (Option A).** A reservation may
      span multiple funding sources. Allocation is eligibility-first across the
      whole quantity: available Base Units (for HQ, limited by both remaining
      Base capacity and the remaining included HQ ceiling), then eligible add-on
      blocks oldest → newest within the request's quality; partial Base capacity
      is used before any add-on; Normal and HQ blocks never substitute. The
      allocation set is frozen at reservation, consume and release act on it
      without reselecting, renewal and later purchases never rebind it, and
      reservation is all-or-nothing. Standard HQ jobs needing 2–3 Units cannot be
      admitted, with no Normal fallback. Phase 6A.
- [x] **When an invoice-paid organization can use purchased Units — CLOSED.**
      As soon as its `billing.manage` holder approves the purchase; the purchase
      is invoiced afterwards under the contract. Product owner, 2026-10-16, with
      the proposal's defaults: one package per approval, Enterprise packages
      through sales, HQ never offered on Standard, no cut-off near the end of a
      period (the expiry is shown before approval instead), and a plan from the
      operator command until self-service sign-up exists. ADR-0066 Decision 4;
      the purchase record and grant built in UP-2 (ADR-0067), the screen in
      UP-3 (ADR-0068), the purchase list and invoicing export in UP-4
      (ADR-0069).

- [x] **`property.create` capability ceiling — CLOSED.** Effective Property
      creation is limited to `OWNER`, `ADMIN`, `MANAGER` and `CREATOR`. A
      `VIEWER` or `BILLING` user never holds an effective `property.create` —
      not by direct grant, not through a group — because the ceiling applies
      after every grant source is combined; such a configuration is not
      supported. A `VIEWER` who needs to create gets an authorized role change.
      ADR-0052 Decision 10.
- [x] **`MANAGER`/`CREATOR` creation-time assignments — CLOSED.** A
      `MANAGER`'s Property has its responsible user **fixed** to the creating
      `MANAGER` and exactly one of the `MANAGER`'s current groups (automatic if
      one, chosen if several; never ungrouped, never another group). A
      `CREATOR`'s Property has its responsible user fixed to the creator and its
      group **fixed to unset** — a `CREATOR` selects no group, not even its own.
      `OWNER`/`ADMIN` creation is unchanged. ADR-0052 Decision 10.
- [x] **Group deletion — CLOSED.** **`OWNER`/`ADMIN`-only**, even where
      another role holds `group.manage`; deletion is a protected sub-operation
      with its own check, and the other group-management operations are not
      redefined. The deletion consequences are unchanged: members stay in the
      organization, group-derived access ends, Properties become ungrouped,
      content and child resources survive, audit history is retained, and
      `OWNER`/`ADMIN` may reassign. ADR-0052 Decision 11.
- [x] **Scope is fixed by role — CLOSED.** `OWNER`/`ADMIN`/`BILLING` →
      `ORGANIZATION`, `MANAGER` → `GROUP`, `CREATOR`/`VIEWER` → `OWN`. There is
      **no standalone scope change** for anyone, `OWNER` included; only a role
      change moves scope, under the role-assignment ceiling. Grants never change
      scope. A role change does not rewrite Property assignments. ADR-0052
      Decision 10.
- [x] **Property assignment authority — CLOSED.** Changing a Property's
      responsible user or group is an **`OWNER`/`ADMIN`-only** authorization
      mutation; `property.edit` alone is not enough. At creation: `OWNER`/`ADMIN`
      may set or leave both unset; a `MANAGER`'s and a `CREATOR`'s Property
      have the creator as responsible user (see the creation-time entry above
      for the fixed values). Creator identity is still not the `OWN` predicate.
      ADR-0052 Decision 10.
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
      renewal**, never immediately; **no proration**; existing members stay
      active through the current period, but unused paid capacity above the
      next-period entitlement is given up once a reduction is scheduled. A reduction may be scheduled **only if current membership already
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
      approved matrix and each role's fixed Scope are ADR-0052 Decision 10.
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
      *The upgrade charge is pro-rata for the month, with the old plan's
      unused days not credited, and that month's Base-Unit ceiling is the old
      plan's plus the new plan's for the days charged, since 2026-10-28
      (ADR-0093 Decision 1, above).*
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

- [x] **Reconciled in Phase 6A:** `CONTRACT_MONTHS`, `ANNUAL_PREPAYMENT_DISCOUNT_BPS`
      and both annual-prepayment functions are removed (ADR-0055 Decision 7). The
      original item, kept as evidence:
      **The runtime pricing code assumes every plan is a 12-month contract with a
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
- [x] **`REVIEWER` survives in code or schema** where the role vocabulary is
      represented, and the Phase 3B near-duplicate UX still contradicts ADR-0052
      Decision 14. Both are listed in the implementation section above.
      *`REVIEWER` removed in Phase 6C (ADR-0057); the near-duplicate UX removed
      by ADR-0063 (2026-10-15).*

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
