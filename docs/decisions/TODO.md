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
