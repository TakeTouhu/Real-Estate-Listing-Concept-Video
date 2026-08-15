# Changelog

All notable changes to this project. Phases correspond to `docs/Roadmap.md`.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — Phase 4B-1c: immutable generation request snapshot

Under review. Not merged. See `docs/phase-4b1c-completion.md` and ADR-0018.

### Added

- **An immutable request snapshot on `SceneGeneration`** —
  `requestCompiledPrompt`, `requestDurationSeconds`, `requestCameraMotion`,
  `requestAspectRatio`, `requestResolution`, captured at admission. These are
  exactly the request-hash facts the row did not already carry, so an admitted
  generation now holds all eight and can **recompute its own `requestHash`**.
- **`generationRequestFactsFrom(generation)`** — rebuilds the admitted request
  from the persisted row alone, and **fails closed** with a neutral
  `INTERNAL_ERROR` for a legacy row whose snapshot is absent rather than falling
  back to current storyboard or project state.
- Migration `00000000000007_phase4b1c_request_snapshot` — five nullable columns,
  no backfill, no hash rewrite, no deletion, no new index; the restraint is
  asserted by `tests/schema/request-snapshot-columns.test.ts`.

### Fixed

- **An admitted generation is no longer unexecutable after recomposition.**
  `replaceForProject` deletes every storyboard scene, and `VideoProjectUpdate`
  can change `aspectRatio`/`resolution` after admission — so the compiled prompt,
  duration and camera motion were unrecoverable and the project settings were
  unsafe to re-read. A worker that fell back to current state would have
  submitted, and paid for, a request the customer never approved under the
  stored hash. Surfaced by review of PR #32; contract recorded in ADR-0018, which
  narrowly amends ADR-0016 §3 and ADR-0017 §10.

### Unchanged (deliberately)

- `computeGenerationRequestHash` — no fact added, removed, reordered, or
  versioned. The snapshot completes the existing contract rather than altering it.
- The queue payload is still exactly `{ generationId }`.
- Audit metadata keeps its existing allowlist and still carries no prompt text.
- No provider call, no worker, no production queue adapter, no real WaveSpeed
  capability values, and no prompt renderer — the compiled prompt is stored
  opaque so exactly one renderer can be built later at the provider boundary.

## [Unreleased] — Phase 4B-1b: single-scene generation admission

Merged as `c169bd604543cc973c741f85bcec168562ec742a` (PR #32).
See `docs/phase-4b1b-completion.md`.

### Added

- **`GenerationService.startScene`** — the one operation that safely admits a
  single storyboard scene for generation: authorize `property:write` → hard
  freshness gate → resolve the scene only inside the scoped storyboard view →
  refuse a scene with no compiled prompt → snapshot capability once and validate
  → compute the request hash → reuse an active or succeeded attempt, else create
  → enqueue → audit. It creates nothing on any refusal or reuse, calls no
  provider, and writes no storage.
- **`SceneGenerationQueue` + `SceneGenerationJob`** — a domain-owned queue port
  whose entire payload is `{ generationId }`; no organization id, prompt,
  provider detail, URL, or credential. The production `@app/queue` adapter is
  still deferred to Phase 4C.
- **`generation.requested` audit action** (`resourceType: scene_generation`) —
  emitted once per newly created attempt, only after a successful enqueue, with
  an explicit metadata allowlist and no prompt or secret leakage.
- **`StoryboardReader`** — a narrow consumer-owned port (freshness + the scoped
  project and scenes) that `StoryboardService` satisfies structurally, so
  generation orchestration reuses the freshness decision without re-deriving a
  fingerprint.
- **`RecordingSceneGenerationQueue`** — a test-only queue double that records
  payloads and can fail the next enqueue on demand.

### Notes

- **Ordering is `create → enqueue → audit`.** A job never accepted by the queue
  is never recorded as requested for execution. Enqueue failure leaves a durable
  `QUEUED` row (not deleted, not failed, identity intact) and audits nothing; a
  later call returns that row without re-enqueuing. Phase 4C's `QUEUED` sweep is
  the recovery mechanism, not `startScene`.
- **Reuse is duplicate-spend prevention, not output reuse.** A succeeded attempt
  is returned to avoid a second charge; whether its output is usable waits on
  `outputStorageKey` in Phase 4D. Deliberate regeneration is not exposed here.
- **The database partial unique index remains the concurrency authority.** A
  create that loses the active-request race converges by re-reading active then
  succeeded; an unreconcilable conflict is a neutral `INTERNAL_ERROR`, never a
  validation error. `create` is attempted at most once — no retry loop.
- No schema, migration, provider, or storage change. See ADR-0017.

## [Unreleased] — Phase 4B-1a: generation foundations

Under review. Not merged. See `docs/phase-4b1a-completion.md`.

### Added

- **`VideoModelCapability` + `VideoModelCapabilityProvider`** — a provider-neutral
  description of what a configured model can actually do, and the port through
  which orchestration reads it. `DurationPolicy` has both a range and an
  enumerated form because real models differ and collapsing them would force a
  lie about whichever does not fit.
- **`assertSettingsSupported`** — the pure rule that refuses a request the model
  cannot satisfy, before anything billable can happen. Duration, resolution,
  aspect ratio, and the two optional customer-authored inputs.
- **`findLatestSucceededByRequestIdentity`** — the one narrow history query the
  repository has. Terminal states release the active identity, so the active
  lookup provably cannot see a succeeded attempt; without this, an identical
  already-succeeded request would automatically become a second paid attempt.
- **`InMemorySceneGenerationRepository`** — models the repository contract for
  Phase 4B-1b's service tests, importing `ACTIVE_SCENE_GENERATION_STATES` rather
  than restating it.

### Notes

- **"No `aspect_ratio` parameter" is not "aspect ratio supported".**
  `AspectRatioSupport` describes the *delivered video*, not request fields.
  Absence of a way to ask is not evidence the request was honoured, so a model
  marked `UNSUPPORTED` causes a project requesting a ratio to be **refused** —
  never silently served an unknown shape.
- **No real capability values ship here.** Every test uses a fixture descriptor
  explicitly labelled as invented; the verified WaveSpeed descriptor is Phase
  4B-2's, after the provider contract is checked against an authoritative source.
- The succeeded lookup orders by `createdAt` then `id`, both descending —
  explicit and total, because two attempts can share a millisecond. A live test
  creates exactly that tie.
- **Duplicate-spend prevention is not output reuse.** Whether a succeeded
  attempt is usable depends on `outputStorageKey`, which nothing populates until
  Phase 4D.
- No `GenerationService`, no queue, no provider call, no schema change. Nothing
  calls the capability provider yet.

## [phase-4a2b-complete] — Phase 4A-2b: scene-generation repository boundary

Merged in PR #30 as `53cc574cf3f3b1138c794c84cb6baa79b1479100`.
See `docs/phase-4a2b-completion.md`.

### Added

- **`SceneGenerationRepository`** — four methods:
  `create(organizationId, input)`, `findById`, `findActiveByRequestIdentity`,
  `update`. No `delete` (history is retained because it can record a paid call),
  no generic `save`, no listing, no worker-claim method.
- **`SceneGenerationUpdate`** — the narrow contract. Ten identity, provenance and
  timestamp fields are *absent from the type*, so mutating them is a compile
  error rather than a silently ignored property.
- **`SceneGenerationNotFoundError`** — a typed neutral error instead of the plain
  `Error` older repositories throw. A worker has to tell "the row is gone or not
  mine" apart from "the database failed" to classify a retry, and matching
  message strings for that would be a bug waiting on a wording change. Local to
  this module; the older repositories are untouched.
- **`ActiveGenerationConflictError`** — raised only for the active-request
  identity collision.
- **`createPrismaSceneGenerationRepository`** — the adapter, with P2002
  translation built on the runtime shape verified in Phase 4A-2a.

### Notes

- **Only the active-request collision is translated.** Recognition is an exact,
  order-insensitive match on `meta.target` against
  `["videoProjectId", "requestHash"]` — never the index name, which Prisma does
  not emit, and never a message substring. Exact cardinality means a future
  unique constraint over a superset stays a different invariant. Two real
  database failures prove the narrowness: a **duplicate primary key** (also
  `P2002`, but `target: ["id"]`) and an **invalid project FK** (`P2003`) both
  propagate untouched.
- **Tenant scope is carried by the query**, never by an application check after
  an unscoped read — `videoProject: { organizationId }` on every read, and
  `updateMany` with the same predicate for writes. `count === 0` is the single
  code path for both "unknown id" and "another tenant's", so they are
  indistinguishable by construction.
- **Review found and fixed a tenant-boundary defect in `create`.** It was the one
  operation not organization-addressed, and the adapter inserted a
  caller-supplied `videoProjectId` without checking ownership — so a caller for
  organization A could write into organization B's project, *and* read B's state
  back, because a colliding request would answer
  `ActiveGenerationConflictError`. `create` now takes `organizationId` and
  verifies the project **before** inserting, so a foreign caller never reaches the
  active-request index. A nonexistent project and another tenant's project give
  the same neutral `SceneGenerationNotFoundError`. No `organizationId` column was
  added anywhere.
- **`providerPredictionId` outlives `PROCESSING`.** An absent key means "leave
  alone", so a state-only update cannot clear it; only an explicit `null` does.
  Proven on `SUCCEEDED`, `FAILED_RETRYABLE` and `FAILED_TERMINAL` rows.
- `findActiveByRequestIdentity` is documented as a convenience lookup, **not**
  concurrency control: two callers can both find nothing, so `create` still
  handles the database collision.
- The repository holds no state machine — whether a transition is legal stays a
  domain question answered by `assertTransition`.
- 51 live PostgreSQL cases. No schema or migration change; 4A-2a's SQL invariant
  matrix is not repeated.

## [phase-4a2a-complete] — Phase 4A-2a: scene-generation persistence

Merged in PR #29 as `6e681c2c60d3aad36dc725bd5841ac13a0248a15`.
See `docs/phase-4a2a-completion.md`.

### Added

- **`scene_generations`** — one row per attempt to generate one scene through a
  video provider, with the `SceneGenerationState` enum carrying exactly the eight
  Phase 4A-1 states.
- **An active-request partial unique index** on `(videoProjectId, requestHash)`
  over the five active states, created in the same migration as the table. The
  database — not application code — is authoritative for *at most one active
  attempt per request identity*, so two concurrent submissions cannot both
  produce a billed provider call. Terminal states release the identity, so a
  deliberate regeneration stays possible.
- **`tests/schema/active-generation-states.test.ts`** — reads the real migration
  SQL, parses the state literals out of the index predicate, and compares them
  with `ACTIVE_SCENE_GENERATION_STATES`. Hand-written SQL cannot import
  TypeScript, so nothing else stops the two definitions of "active" drifting
  apart — and drift there would let a second billed POST through.
- `SceneGeneration` domain entity type extending `SceneGenerationProvenance`.

### Notes

- **This table records money, and the schema reflects that.** Three decisions are
  the opposite of the schema default:
  - `videoProjectId` is **`ON DELETE RESTRICT`**, unlike every other child here.
    A future physical deletion must resolve retention policy for paid-attempt
    history deliberately rather than inheriting a cascade. It changes no current
    behaviour — property removal is a *soft* delete and nothing physically
    deletes a property or project today.
  - `sourceStoryboardSceneId` has **no FK**: `replaceForProject` deletes and
    recreates every scene on each recompose, so a cascade would destroy a paid
    call's record during an ordinary user action and a restrict would block
    recomposition.
  - `assetId` has **no FK**, for the same reason one step later — the retention
    pipeline removes assets, and history still has to explain what was generated.
- **No `organizationId` column.** Tenant scope resolves through the owning
  project, as `storyboard_scenes` does. A live test asserts the absence.
- **Not persisted:** any temporary provider output URL (Phase 4D copies to
  managed storage and keeps the managed key) and any retry counter (no worker
  exists yet to have a policy). A live test asserts no column name contains
  `url`.
- **Real error shapes captured, not translated.** The collision surfaces as
  `P2002` with `meta.target = ["videoProjectId","requestHash"]` — the
  hand-written index name appears nowhere, matching the lesson in
  `analysis-repositories.ts` that an earlier name-matching translation silently
  never fired. Phase 4A-2b will translate it; this milestone only pins the truth.
- Persistence only: no repository port, no adapter, no service, no queue, no
  worker, no HTTP/UI, no provider call.

### Fixed

- `schema.prisma`'s `compositionFingerprint` comment still described the Phase 3C
  payload `(assetId, analysisRevision)`; since Phase 3D-3 it also carries
  `effectiveRoomType` and `orderOverride`.
- `docs/er-diagram.md` listed provider prediction ids under *"deliberately not
  stored"*. They **are** stored now, internal-only, because `PROCESSING` asserts
  a known prediction and polling needs it.

## [phase-4a1-complete] — Phase 4A-1: generation state model and request identity

Merged in PR #28 as `daa685bd472dd3d632b630334d9c1bc5fcc72f36`.
See `docs/phase-4a1-completion.md`.

### Added

- **Scene-generation state vocabulary** — eight states covering one attempt to
  generate one scene through a video provider, with the legal moves in a single
  transition table rather than scattered conditionals.
- **`SUBMISSION_UNKNOWN`** — a first-class state for a submission whose outcome
  could not be established. It has **no automatic exit at all**, because the
  provider may already hold a billed prediction for that request.
- **Active / terminal sets.** Active — `QUEUED`, `SUBMITTING`, `PROCESSING`,
  `FAILED_RETRYABLE`, `SUBMISSION_UNKNOWN` — are the states that hold the local
  generation identity. `ACTIVE_SCENE_GENERATION_STATES` is exported so Phase
  4A-2's hand-written partial-index predicate has one source, and a test pins its
  contents so SQL and domain cannot drift apart silently.
- **`computeGenerationRequestHash`** — `sha256:<hex>` over a fixed-order tuple of
  the facts that decide what would be generated: asset, compiled prompt,
  duration, camera motion, aspect ratio, resolution, provider, model.
- **`SceneGenerationProvenance`** — the minimum facts a persisted attempt carries
  so it is understandable without the storyboard scene it came from.
- **ADR-0016** — scene generation state, local idempotency, and ambiguous
  provider submission.

### Notes

- **Storyboard scenes are ephemeral, so there is no foreign key to them.**
  `replaceForProject` deletes every scene row and re-inserts with fresh ids on
  each compose, and an attempt that may represent a paid call must outlive that.
  The field is named `sourceStoryboardSceneId` to make the non-relational meaning
  unmistakable. Tenant ownership comes through the persistent `VideoProject`; no
  `organizationId` is denormalized to compensate.
- **The four ways a submission ends are kept distinct**, because their financial
  consequences differ. Only positive evidence that the POST was *not* accepted
  produces `FAILED_RETRYABLE`.
- **Polling separates "we could not read the state" from "we read a failure".**
  A transport failure of the status GET is **not** a state change: the job stays
  `PROCESSING` and the idempotent GET is retried. A *successful* GET that reports
  a retryable prediction failure is `PROCESSING → FAILED_RETRYABLE`, matching the
  `ProviderGenerationState` vocabulary the shipped provider port already
  normalizes. `PROCESSING → QUEUED` stays absent, so
  `FAILED_RETRYABLE → QUEUED → SUBMITTING` remains the only route into a POST.
- **Scene position and `sourceAnalysisRevision` are excluded from the hash**, so
  reordering a storyboard or refreshing an analysis that changes nothing
  generative cannot manufacture a second paid request.
- **No claim of provider exactly-once.** The guarantee is one active *local* job
  per request identity and no automatic duplicate POST when submission is
  ambiguous — the external API offers no idempotency mechanism that would make a
  retry provably safe.
- **Operational cost recorded, not hidden:** one dropped connection during
  submission blocks that scene until a human resolves it. Tracked in
  `docs/decisions/TODO.md`.
- Pure domain: no schema, no migration, no repository, no provider call, no
  queue, no worker, no HTTP or UI. Nothing calls any of it yet.

## [phase-3-complete] — AI analysis, human review and correction, storyboard

Phase 3 closes at `541ada413a6c7b71df5169faca0592626c9be454` (PR #27), across 24
milestone PRs (#4 … #27). See `docs/phase-3-completion.md` for the full
milestone record and completion evidence.

The Roadmap criterion for Phase 3 is *users can review and correct all AI
decisions before generation.* Phases 3A–3C delivered review; **correction**
arrived in Phase 3D, and only with it merged is the criterion met.

### Phase 3 in one paragraph

A property's photos are analyzed by a swappable `ImageAnalysisProvider` — today
a deterministic offline adapter, no vision vendor. A human reviewer then sees
every AI decision and can approve it, reject it, or **correct** it: change the
room the analyzer read, or give a photo an order priority. Approved photos, with
their corrected values, compose into a storyboard whose freshness is recomputed
at read time, so a storyboard that no longer matches its inputs reads stale and
cannot pass the `assertFresh` gate that Phase 4 generation will sit behind.
Nothing is generated and nothing is published; a storyboard is a plan.

### Closure documentation

- `docs/phase-3-completion.md` — new.
- `docs/architecture.md` — component table corrected: it listed `AnalysisService`,
  analysis persistence, and the review UI as *not implemented* after all three
  had shipped, and had no entry for corrections or the moderation port.
- `docs/sequence-analysis-lifecycle.md` — a correction sequence added (it had
  none), and the by-milestone table brought from 3B-2 up to 3D-4b. The
  low-confidence/blocking note no longer says enforcement is pending: it landed
  in 3B.

### Known limitations carried forward

No generation yet; video projects cannot be renamed, edited, or deleted; aspect
ratio and resolution are free text until a provider's real capabilities are
known; a no-op correction leaves the decision interlock engaged by design;
`LocalObjectStorage` is still in-process; image processing still runs inline in
the upload request; `suggestedOrder` is inert in ordering and preserved as
analyzer output only.

## [phase-3d4b-complete] — Phase 3D-4b: review-page correction controls

Merged in PR #27 as `541ada413a6c7b71df5169faca0592626c9be454`.
See `docs/phase-3d4b-completion.md`.

### Added

- **Correction controls on the review page.** A reviewer sees what the analyzer
  read the room as, can override it or restore the analyzer's result, can set or
  clear an order priority, and saves that with an explicit **Save correction**
  action — separate from Approve and Reject.
- **`ReviewItemControls`** — a small client wrapper holding one piece of state:
  which corrections are unsaved. No context, no store, no form framework, no
  domain rule.
- **`correction-errors.ts`** — zero-import client-safe status mapping, `422`
  rendering the API's own message unparsed.
- `ReviewItem.correction` carrying `analyzerRoomType`, `effectiveRoomType`,
  `roomTypeOverride`, `orderOverride`, `corrected`, `canCorrect`.
  `effectiveRoomType` comes from the domain helper **server-side**; the browser
  never re-derives `roomTypeOverride ?? roomType`.

### Changed

- **Unsaved corrections now block Approve and Reject.** Approving with edits
  still on screen would freeze the revision around the *old* stored correction
  and silently discard what the reviewer can see. While any correction here is
  dirty the decision controls are unavailable and say why; a **failed** save
  keeps them blocked, because the edits are still unsaved. `ReviewDecisionPanel`
  gained one presentation-only optional prop, `disabledReason` — its request
  payload and business semantics are untouched, and it knows nothing about how
  corrections are stored.

### Notes

- **The three HTTP states survive into the UI.** Each field tracks
  `{ touched, value }` explicitly: untouched omits the key, an explicit clear
  sends `null`, a value sets it. Dirtiness is never inferred from an empty
  input, because that cannot separate "never touched" from "deliberately
  cleared". The room select carries an explicit *Use analyzer result* option so
  `null` is expressible.
- A field touched and returned to its stored value stays dirty and is sent — the
  domain already has correct no-op semantics, and a client-side stored-value
  diff would be presentation pretending to be a business rule.
- **A successful save does not unlock the decision.** It asks for
  `router.refresh()` and stays blocked until the refreshed render lands: a `200`
  means the write succeeded, not that the screen is fresh. Because
  `router.refresh()` preserves client state, `review/page.tsx` keys the controls
  on authoritative correction and review state, so the refreshed payload — and
  only it — remounts them and resets local edit state. A save the domain treats
  as a no-op changes nothing authoritative, so the interlock holds and **Discard
  changes** is the escape.
- Decided revisions show their corrections **read-only**. No post-decision
  editing; refresh remains the path to a new reviewable revision.
- Room options are built server-side and passed as plain data. The clean-build
  scan finds none of `ROOM_TYPES`, `humanizeRoomType`, `isRoomType`,
  `effectiveRoomType`, `isCorrected`, `AnalysisService`, `StoryboardService`,
  `@app/domain`, `@app/database`, `PrismaClient`, `node:crypto|fs|util`,
  `authorizeOrganization`, or `CorrectionField` in any client chunk, with a
  `CorrectionPanel` literal as positive control.
- Zero diff across all of `packages/` and across `apps/web/src/app/api/` — **no
  API contract change**.
- Size: 1080 code lines (510 production, 570 tests) against a re-cost of ~865 —
  over, and reported rather than trimmed. A review fix added 66 more.

## [phase-3d4a-complete] — Phase 3D-4a: correction HTTP contract

Merged as `cc0d3d5` (PR #26). See `docs/phase-3d4a-completion.md` and
`docs/api-changes-phase-3d4a.md`.

### Added

- **`POST /api/properties/{propertyId}/assets/{assetId}/analysis/correction`** —
  exposes the Phase 3D-2 correction operation. JSON semantics: an omitted key
  leaves the stored override unchanged, `null` clears it, a value sets it. The
  adapter decides by **property presence** (`"roomType" in body`), never by
  truthiness, because `null` is meaningful. Requires `video:review`.
- **Five additive `AnalysisDto` fields** — `roomTypeOverride`,
  `effectiveRoomType`, `orderOverride`, `corrected`, alongside the existing
  `roomType`, which continues to carry the **analyzer's** classification.
  `effectiveRoomType` is resolved server-side so the browser never reimplements
  it. Every existing field keeps its name, type, nesting and semantics.

### Fixed

- **Nested property/asset route integrity across every analysis action.** All
  five existing handlers — analyze, read, approve, reject, refresh —
  destructured `propertyId` from the URL and then ignored it, so a
  same-organization asset filed under a *different* property could be acted on
  through a hand-built path. Not a cross-tenant leak (the services resolve the
  asset organization-scoped) but wrong, and the same defect class as Phase
  3C-6b. `requireAssetInProperty` now runs before delegation on all six routes.
  A mismatch and a genuinely unknown asset produce the **same** `404`, so
  nothing discloses that the asset exists elsewhere. **No request or response
  contract changed** — a caller using a correct URL sees identical behaviour,
  and a member without permission still gets `403` rather than a `404`.

### Notes

- `AnalysisService.correct` is **unchanged**; no JSON semantics entered the
  domain, and no domain signature was altered for HTTP path semantics.
- The route check is URL integrity, not authorization: it authorizes
  organization membership exactly as these routes already did, and the action's
  own permission check still runs afterwards. No unrelated error is flattened
  into `404`.
- `correctedBy`, `correctedAt`, audit metadata, fingerprints, provider
  internals, storage keys and organization internals remain unexposed.
- The client-safe correction error mapper is **deferred to 3D-4b** rather than
  shipped as dead production code.
- **No UI yet.** Phase 3 is not complete until 3D-4b ships the reviewer-facing
  controls.
- Zero diff across all of `packages/`, and across the review UI and CSS.
- Size: 609 code lines (170 production, 439 tests), re-cost at ~684.

## [phase-3d3-complete] — Phase 3D-3: corrections reach composition

Merged as `1e51453` (PR #25). See `docs/phase-3d3-completion.md`.

### Changed

- **`selectEligibleAnalyses` now projects the effective room type** and the
  reviewer's order priority. `EligibleInput.roomType` means the *effective*
  classification from this milestone on, and `EligibleInput.orderOverride` is
  new. This projection is the **only** place a correction enters composition —
  `orderScenes` never imports `effectiveRoomType`, `fingerprint.ts` never reads
  an `AssetAnalysis`, and **`StoryboardService` changed by zero lines**.
- **`orderScenes` sorts by a global priority.** The primary key is
  `orderOverride ?? roomRank(effectiveRoomType)`; ties break by an explicit
  priority beating an automatic rank, then effective room rank, `suggestedOrder`
  (nulls last), and `assetId`. Priority and room ranks share one numeric space,
  so a priority of `2` slots *between* `ENTRANCE` and `LIVING_ROOM` rather than
  jumping the sequence, and a priority of `8` genuinely sits later than an
  exterior shot. Priorities are never clamped. With no priorities set anywhere,
  ordering is unchanged from Phase 3C.
- **The composition fingerprint payload is now
  `[assetId, analysisRevision, roomType, orderOverride]`** — a correction does
  not advance `analysisRevision`, so the corrected values must appear in the
  digest themselves. Canonical sort, `JSON.stringify`, SHA-256, and
  `sha256:<hex>` are unchanged.

### ⚠️ One-time stale consequence

The fingerprint **format** changed, and two extra members are serialized even
when both are null. A digest computed under the Phase 3C format cannot match one
computed now, so **every storyboard composed before this milestone reads stale
once and must be recomposed.**

This is deliberate and fail-safe. There is no compatibility fallback, no
dual-format support, no backfill, and **no database migration** — treating an old
digest as fresh would assert something the function can no longer verify.

### Notes

- Correction provenance stays out of `EligibleInput`: composition has no use for
  who corrected a photo or when, and a test asserts the projected key set.
- `suggestedOrder` keeps its tie-break role and the duplicate-`assetId` refusal
  is untouched. Duplicate *priorities* are legitimate and resolve
  deterministically.
- Two pre-existing 3C assertions were updated because they described the
  contract this milestone changes — the fingerprint's "ignores room type" case
  became "ignores `suggestedOrder`", and eligibility's "four facts" became
  "five". Every other 3C assertion is untouched and green.
- Dated supersession notes were appended to **ADR-0012** and **ADR-0013**;
  neither historical record was rewritten.
- Seven files changed, all under `packages/domain/src/storyboard/`. Zero diff
  across the schema, migrations, `AnalysisService`, roles, HTTP, UI, and
  providers.
- Size: 413 code lines (92 production, 321 tests) against an approved ~445–560.

## [phase-3d2-complete] — Phase 3D-2: the correction operation

Merged as `3d59332` (PR #24). See `docs/phase-3d2-completion.md`.

### Added

- **`AnalysisService.correct`** — the write path for the correction columns
  added in 3D-1. Records and clears a reviewer's room classification and sort
  priority for the current analysis revision.
- **`CorrectionField<T>` / `CorrectInput`** — a structural input contract where
  an absent field leaves the stored override alone, `{ set: null }` clears it,
  and `{ set: value }` sets it. The three states cannot collapse: the obvious
  `roomType?: RoomType | null` makes `{}` and `{ roomType: undefined }` the same
  type, so a caller forwarding an unset value would silently clear a reviewer's
  work.
- **`analysis.corrected`** audit action on the existing sink, emitted exactly
  once per real change, carrying `analysisId`, `assetId`, `propertyId`,
  `analysisRevision`, the **effective** room before and after, and the stored
  order override before and after.

### Notes

- **Lifecycle, authorization and tenancy are `requireReviewable`'s** — the same
  guard approve and reject use, unchanged. Corrections are allowed exactly while
  a decision is (`SUCCEEDED` + `UNREVIEWED`) and repeatably; `PENDING`, `FAILED`,
  `APPROVED`, and `REJECTED` are refused. `video:review` admits OWNER, ADMIN and
  REVIEWER and excludes CREATOR through the existing role map, with no branching.
  A foreign asset is `NOT_FOUND`, never `FORBIDDEN`.
- **`analysisRevision` is never advanced by a correction** — it identifies an
  analysis *result*, and a human edit is not a new result.
- **Change detection is on the stored override pair, not effective values.**
  Setting an override to the room the analyzer already chose is a real change
  (`null → KITCHEN`): a person confirmed the classification, so `isCorrected`
  becomes true and the row records who. The audit entry then reads
  `previousRoomType: KITCHEN, newRoomType: KITCHEN`, which is the honest record.
- **A request that restates the stored values is a true no-op** — no write, no
  audit, `updatedAt` and `correctedAt` unmoved. A request naming no field at all
  is refused.
- **Provenance is self-consistent**: clearing the last override clears
  `correctedBy` and `correctedAt` too, so the row agrees with `isCorrected`. Who
  cleared it survives in the audit log.
- Order priorities require a whole number above zero, with **no upper bound**.
  Persistence stays rule-free (3D-1); the rule lives in the service only.
- **No HTTP, DTO, UI, storyboard, or fingerprint change.** Composition still
  ignores corrections — that is Phase 3D-3.
- Four files changed, all under `packages/domain/src/analysis/`. No schema or
  migration change.
- Size: 708 code lines (189 production, 519 tests), re-cost at ~558 against an
  approved ~481/~500 — the overrun is the 52-case mandated matrix, reported
  rather than trimmed.

## [phase-3d1-complete] — Phase 3D-1: review-correction persistence

Merged as `1ebe30a` (PR #23). See `docs/phase-3d1-completion.md` and ADR-0015.

### Added

- **Four nullable columns on `asset_analyses`** — `roomTypeOverride`,
  `orderOverride`, `correctedBy`, `correctedAt` — so a reviewer can correct what
  the analyzer decided. Migration
  `00000000000005_phase3d1_review_corrections` is purely additive: no backfill,
  no index, no constraint, no change to any existing column.
- **`effectiveRoomType(analysis)`** — the single resolution point,
  `roomTypeOverride ?? roomType`. Plus `isCorrected(analysis)`, which reads the
  overrides rather than `correctedBy`, so a cleared row reads as uncorrected.
- **ADR-0015** recording the whole decision: preserved AI output versus
  mutation, the correction lifecycle, `orderOverride` as a global sort priority
  rather than an absolute position, the approved Phase 3D-3 precedence rule, the
  fingerprint payload change and its one-time stale consequence, and why
  `suggestedOrder` is retained despite being inert.

### Changed

- **A refresh now clears the four correction fields** at reservation, alongside
  the stale analysis and review state it already cleared. A correction belongs
  to the revision it was made against, and clearing at reservation means it can
  never outlive the result it describes — not even on a `FAILED` row.

### Notes

- **The analyzer's output is never overwritten.** `roomType` and
  `suggestedOrder` keep their values; a correction is stored beside the AI value
  so the model's answer stays recoverable and `confidence` keeps describing the
  value it was produced for.
- **There is deliberately no `effectiveOrder` helper.** `orderOverride` is the
  priority as stored; a wrapper would imply a derivation that does not exist,
  and one falling back to `suggestedOrder` would move an ordering decision into
  the analysis model. Ordering interpretation belongs to the storyboard
  primitive (Phase 3D-3).
- **Nothing can write a correction yet** — no service method, no endpoint, no
  UI. Composition still ignores corrections, by design.
- No fingerprint change in this milestone.
- Size: 426 code lines (121 production, 305 tests), re-cost at ~351 against an
  approved ~460.

## [phase-3c6b-complete] — Phase 3C-6b: storyboard detail, composition, and freshness UI

Merged as `235783b` (PR #22). See `docs/phase-3c6b-completion.md`.

### Added

- **`/properties/{propertyId}/video-projects/{projectId}`** — the storyboard
  detail page, linked from each row of the Videos list. Read-only project
  settings, the approved-photo count against `MIN_STORYBOARD_SCENES`, the
  freshness banner, and the composed scenes with short-lived signed thumbnails.
- **Compose panel** — posts to the existing
  `POST /api/video-projects/{projectId}/storyboard`. `minSceneSeconds` and
  `maxSceneSeconds` are explicit required inputs with **no default of any kind**;
  the button is unavailable until both are whole numbers above zero.
  Recomposition uses the **same** endpoint — none was added.
- **`apps/web/src/lib/thumbnails.ts`** — the signed-thumbnail helper extracted
  unchanged from the review page, now with two consumers. Server-only; returns
  signed URLs and never a storage key.
- `mapComposeError` / `COMPOSE_ERRORS` in the existing zero-import client-safe
  mapper.

### Notes

- **Freshness is decided by `fresh`, never by `project.status`.** The persisted
  status is written at compose time and nothing updates it when an approval
  later changes (ADR-0012). A test drives `STORYBOARD_READY` with `fresh: false`
  and asserts the **stale warning wins** — a stale storyboard is never presented
  as ready or current.
- Three states, exhaustively: never composed (`scenes: []`), fresh, and stale.
- The approved-photo count is informational, labelled as approved photos rather
  than eligible scenes, does **not** reimplement the duplicate-group eligibility
  rule, and does **not** gate composition. The compose result is authoritative.
- `MIN_STORYBOARD_SCENES` is resolved on the server and passed down as a plain
  number: the presentation module mounts a Client Component, so it carries no
  domain value import.
- Nothing outside `apps/web/` changed — `packages/`, the Prisma schema, the
  migrations, and every API route have a **zero diff**.
- The clean production build was scanned: no domain, server, or Node-builtin
  symbol appears in any browser chunk, verified against a positive control from
  the new compose component.
- Size: 1286 code lines (579 production, 707 tests) against a ~780 estimate —
  over the threshold, and reported as such rather than trimmed. 1160 of those
  were the first review head; the remaining 126 are the review fix below.

### Fixed (found in review, before merge)

- **Nested-route integrity on the storyboard page.** The page resolved the URL's
  `propertyId` but loaded the storyboard by `organizationId + projectId` alone,
  never checking the two agreed. `getStoryboard` is organization-scoped — the
  security boundary is intact — but a project from a *different property in the
  same organization* is a valid result, so a hand-built URL could render one
  property's header, assets, and approved count beside another's project and
  scenes. `resolveStoryboardForProperty` now returns the not-found result for
  both a genuine `NOT_FOUND` and a property mismatch, **identically**, so a
  mismatch never discloses that the project exists elsewhere. The same change
  stops a genuine `NOT_FOUND` escaping as a 500. `FORBIDDEN`,
  `VALIDATION_FAILED`, `UNAUTHENTICATED`, and repository errors all still
  propagate — a broken system must not read as a missing page.

## [phase-3c6a-complete] — Phase 3C-6a: video-project discovery and creation UI

Merged as `efff531` (PR #21). See `docs/phase-3c6a-completion.md`.

### Added

- **`/properties/{propertyId}/video-projects`** — the Videos page, reached from
  a new entry on the property page. Lists every video project the property has
  with its name, status, target length, aspect ratio, resolution, and the
  customer's own camera-motion, prompt, and negative-prompt text.
- **Create panel** — posts to `POST /api/properties/{propertyId}/video-projects`
  with only the fields `CreateProjectInput` accepts. The button stays unusable
  until name, target length, aspect ratio, and resolution are all filled and the
  length is a whole number above zero. A successful `201` clears the form and
  refreshes the server component; the authoritative list comes from the server,
  never from a local insert.
- **`apps/web/src/lib/project-errors.ts`** — client-safe status→message mapping
  with **no imports**, so nothing drags `@app/domain` into the browser bundle.
  `422` renders the API's own message and is never parsed.
- `ProjectsView`, a synchronous presentational component, so the project list
  and the authorization gating are directly testable under jsdom.

### Notes

- A property may hold **any number** of projects. No active, default, or primary
  project; no pagination, search, filter, or sorting control.
- Rows carry **no link** — the project detail route does not exist until Phase
  3C-6b, and a link to a missing route is worse than none.
- Authorization is presentational as well as enforced: a role without
  `property:write` receives **no create markup at all**, not a disabled control.
  The API remains the security boundary and the client re-derives nothing.
- **No lifecycle field is ever sent** — no `status`, `compositionFingerprint`,
  `scenes`, or `createdBy`. A test asserts each is absent from the request body.
- Aspect ratio and resolution are free text; the placeholders show the shape of
  the string and make **no claim about provider capability**, which is Phase 4's
  to establish.
- Nothing outside `apps/web/` changed — `packages/`, the Prisma schema, and the
  migrations all have a **zero diff**.
- The production build was scanned: no domain or server symbol appears in any
  browser chunk.

## [phase-3c5b-complete] — Phase 3C-5b: storyboard compose, read, and project list

Merged as `37df1b7` (PR #20). See `docs/phase-3c5b-completion.md` and
`docs/api-changes-phase-3c5.md`.

### Added

- **`StoryboardService.isFresh`** and a **shared internal freshness comparison**
  used by both `isFresh` and `assertFresh`, which remains the Phase 4 hard gate.
  `isFresh` is `false` for exactly two reasons — nothing composed, or the inputs
  moved; authorization, `NOT_FOUND`, repository, and invariant failures all
  **propagate**, so a broken system never reads as a merely outdated storyboard.
- **`POST /api/video-projects/{projectId}/storyboard`** — compose with
  caller-supplied `minSceneSeconds` / `maxSceneSeconds`, validated for shape
  only. Requires `property:write`.
- **`GET /api/video-projects/{projectId}/storyboard`** — project, scenes, and a
  `fresh` boolean. Any member may read; an uncomposed project returns
  `scenes: []` and `fresh: false` with **no invented status**.
- **`GET /api/properties/{propertyId}/video-projects`** — discovery so the UI
  can reload a property and find its projects through the API rather than
  reaching into the repository. No pagination, filtering, sorting, or
  active-project notion.
- `StoryboardService.getStoryboard` and `.listProjects` — the application
  boundary the two read endpoints delegate to.
- Scene and storyboard-read DTOs.

### Notes

- **No `compiledPrompt` crosses the HTTP boundary** in any form, nor do
  preservation constraints, system negatives, moderator identity, provider data,
  storage keys, `organizationId`, or `compositionFingerprint`. A test asserts the
  scene DTO's exact key set.
- An unknown or foreign property returns `404` from the list endpoint rather than
  an empty list, which would itself disclose that the property is not in this
  tenant.
- `packages/database/`, the Prisma schema, migrations, the analysis
  implementation, and the review routes all have a **zero diff**.
- Size: 732 code lines (252 production, 480 tests), re-cost at ~711 — one
  coherent HTTP capability, kept in a single PR by the product-completion
  directive.

## [phase-3c5a-complete] — Phase 3C-5a: video-project creation path

Merged as `afb9fbe` (PR #19). See `docs/phase-3c5a-completion.md`.

### Added

- **`StoryboardService.createProject`** — the only way a `VideoProject` comes
  into existence. Authorizes `property:write`, resolves the property through
  organization-scoped access, and returns `NOT_FOUND` for an unknown or foreign
  one. Structural validation only: **no provider capability rule** is applied to
  duration, aspect ratio, or resolution.
- **`POST /api/properties/{propertyId}/video-projects`** — a thin adapter
  returning `201` with the project DTO.
- `apps/web/src/lib/storyboard.ts` — service wiring and `VideoProjectDto`.
- `requiredString` / `requiredPositiveInteger` shape helpers.

### Notes

- **Lifecycle state is unrepresentable, not ignored.** `CreateProjectInput` has
  no `status`, no `compositionFingerprint`, and no scenes, so a client cannot
  present a project as already composed. A new project is always `DRAFT`,
  unfingerprinted, and sceneless.
- **Nothing about the compiled prompt, preservation rules, system negative
  constraints, or the moderator's identity is exposed** over HTTP — a test
  asserts none of those strings appears in the response.
- Prisma schema, migrations, the analysis implementation, and the review routes
  all have a **zero diff**. No new model, no new repository abstraction, no
  reusable in-memory storyboard repository.
- Size: 623 code lines (230 production, 393 tests) against a ~500 gate,
  estimated 377 — reported, not absorbed.

## [phase-3c4-complete] — Phase 3C-4: storyboard orchestration

Merged as `003edaf` (PR #18). See `docs/phase-3c4-completion.md`.

### Added

- **`StoryboardService.compose`** — authorize `property:write`, load the
  org-scoped project, select eligible approved analyses, require the minimum,
  order, allocate durations from **caller-supplied bounds**, compile one
  structured prompt per scene, compute the fingerprint, replace the scenes,
  mark the project `STORYBOARD_READY`, and record one audit event.
- **`StoryboardService.assertFresh`** — Phase 4's gate. Recomputes the
  fingerprint from the current eligible set and refuses when it differs or when
  none is stored. Derived, never pushed: no hook, no background marking.
- Each scene persists its structured `CompiledPrompt` as JSON in the existing
  `compiledPrompt` column — encoding only, so Phase 4 consumes the reviewed
  prompt rather than recompiling different content.

### Notes

- **Orchestration only.** No rule is restated: eligibility, the minimum,
  ordering, allocation, compilation, moderation, and the fingerprint all stay in
  their existing tested functions. A test asserts the composed order equals
  `orderScenes`' output rather than a hard-coded sequence.
- **Moderation runs once per field per compose**, not 2N times. The compiler is
  invoked once — which is what moderates — and the other scenes reuse its
  verified output with their own facts. **No allow-all moderator exists**, so
  nothing can be mistaken for a moderation boundary that isn't one.
- **No transaction abstraction.** Scenes are written before the project is
  marked ready, so a scene-write failure leaves the project `DRAFT`, unmarked
  and unaudited.
- Deferred as agreed: automatic recomposition, manual scene-edit preservation,
  idempotency keys, a reusable in-memory double, provider capability tables, new
  statuses, HTTP, UI, and provider integration.
- `packages/database/`, `apps/`, the Prisma schema, migrations, and
  `packages/domain/src/analysis/` all have a **zero diff**.
- Size: 603 code lines (208 production, 395 tests) against a ~500 gate,
  re-cost at ~410 — reported, not absorbed.

## [phase-3c3-complete] — Phase 3C-3: prompt compilation and moderation

Merged as `0b39eb1` (PR #17). See `docs/phase-3c3-completion.md` and ADR-0014.

### Added

- **`compileScenePrompt`** — produces a `CompiledPrompt` **structure**, never an
  interpolated string, keeping five parts in distinct fields: immutable
  preservation rules, system-derived scene facts, untrusted user customization,
  system negative constraints, and the untrusted user negative prompt.
- **`PromptModerator` port** with `{ field, code }` findings — coded, never
  vendor prose, never an excerpt of the input.
- **`createOfflinePromptModerator`** — deterministic, offline, five
  documented-rule patterns plus polarity, so "do not add people" is allowed
  while "add people" is flagged, and "do not preserve the original walls" is
  caught as `DEFEATS_PRESERVATION`.
- **ADR-0014** recording structural separation as the primary integrity
  mechanism.
- **34 unit tests**, including five prompt-injection shapes and a marker test
  proving no offending text reaches an error or a log.

### Notes

- **Injection is contained structurally, not detected.** User text is data in a
  field no constraint is read from; nothing scans for "ignore previous
  instructions", and a test proves such text is confined while preservation,
  system negatives, and scene facts stay intact.
- **The offline moderator is an explicit-violation detector, not semantic
  moderation.** False negatives are expected — a passing test records that a
  paraphrase gets through — and a real vendor behind the same port is the fix.
- Rejection is terminal and sanitized: coded findings only, one moderator call
  per non-empty field, no automatic retry.
- `packages/database/`, `apps/`, the Prisma schema, and migrations have a **zero
  diff**.
- Size: 636 code lines (270 production, 366 tests) against a ~500 target,
  estimated ~530 — reported, not absorbed.

## [phase-3c2b-complete] — Phase 3C-2b: ordering and duration allocation

Merged as `d7ede3a` (PR #16). Three pure functions — see
`docs/phase-3c2b-completion.md` and ADR-0013.

### Added

- **`orderScenes`** — the documented walkthrough sequence, completed over the
  existing `RoomType` enum: `CHILD_ROOM` after `BEDROOM`, `STUDY` after that,
  `OTHER`/null/unknown last, wet areas resolved to `BATHROOM → WASHROOM →
  TOILET`. Ties break by `suggestedOrder` (nulls last) then `assetId`, so the
  result never depends on input order. A repeated `assetId` raises
  `VALIDATION_FAILED` rather than being deduplicated; valid input yields a
  complete permutation.
- **`allocateDurations`** — caller-supplied bounds, no defaults. `base =
  floor(total / n)` with the remainder front-loaded, so durations sum exactly to
  the request and each value stays within bounds.
- **`requireMinimumScenes`** — the three-scene rule, deliberately separate from
  the duration math.
- **ADR-0013** recording the ordering contract and the allocation invariant.
  ADR-0012 is untouched.
- **39 unit tests**, including an exhaustive sum-and-bounds check across 12 scene
  counts × every achievable total.

### Fixed

- A determinism bug the new tests caught before merge: ranking a null
  `suggestedOrder` as `Infinity` and subtracting yields `NaN` for two nulls, so
  the `assetId` tie-break never ran and the pair kept its input order.

### Notes

- **Structural failures quote no achievable range.** A scene count below one, a
  non-positive-integer total or bound, and `min > max` fail on their own terms;
  only a structurally sound model reports `minimumAchievableDuration` and
  `maximumAchievableDuration`, in `AppError.details` as well as the message.
- An unachievable total fails — never satisfied by reusing a photo, never quietly
  shortened.
- `packages/database/`, `apps/`, the Prisma schema, and migrations have a **zero
  diff**.
- Size: 520 code lines (204 production, 316 tests) against a ~500 target.

## [phase-3c2a-complete] — Phase 3C-2a: eligible-input selection and fingerprint

Merged as `7596699` (PR #15). Two pure functions — see
`docs/phase-3c2a-completion.md` and ADR-0012.

### Added

- **`selectEligibleAnalyses`** — admits only `SUCCEEDED` + `APPROVED` analyses,
  projected to the four facts composition may depend on and sorted by `assetId`.
  An unapproved analysis is never admitted, including to pad a scene count.
  Two approved analyses sharing one duplicate group raise `VALIDATION_FAILED`
  rather than being resolved: the partial unique index makes that state
  impossible, so reaching it means a guarantee was violated and picking a winner
  would hide the defect.
- **`computeCompositionFingerprint`** — digests the complete eligible input set
  as sorted `[assetId, analysisRevision]` tuples, serialized canonically and
  hashed with SHA-256, returned as `sha256:<hex>`. It changes when an approved
  asset is added, disappears, or is re-analyzed, and is unaffected by input
  order, room type, and suggested order. Staleness is therefore *derived* by
  comparison — no cross-module hook or event exists.
- **ADR-0012** recording both contracts, including that changing what the
  fingerprint covers is a breaking change.
- **24 unit tests**, including the encoding-collision family a delimiter-joined
  payload would fail.

### Notes

- No minimum scene count here: 0, 1, and 2 eligible analyses are all valid
  results. The minimum-three rule belongs to Phase 3C-2b.
- Nothing calls these functions yet; `StoryboardService` arrives in 3C-4.
- `packages/database/`, `apps/`, the Prisma schema, and migrations have a **zero
  diff** — every changed file is under `packages/domain/src/storyboard/`.
- Size: 354 code lines (107 production, 247 tests) against a ~500 target.

## [phase-3c1-complete] — Phase 3C-1: storyboard persistence

Merged as `f7419bc` (PR #14). Persistence and infrastructure only — see
`docs/phase-3c1-completion.md`.

### Added

- **`video_projects`** — provider-neutral project settings for one property's
  walkthrough, plus `compositionFingerprint`, the digest of the approved-analysis
  input set a storyboard was composed from. Freshness is *derived* by comparing
  it with the current eligible set; no module notifies another when an analysis
  is refreshed.
- **`storyboard_scenes`** — ordered scenes with `sourceAnalysisRevision`
  provenance and `UNIQUE(videoProjectId, position)`.
- **Tenant scope without a duplicated column.** Scenes carry no
  `organizationId`: reads filter through the owning project, and two composite
  foreign keys — `(videoProjectId, propertyId)` and `(assetId, propertyId)` —
  make a scene mixing two properties, and therefore two tenants, impossible to
  insert. A live-PostgreSQL test proves the database refuses it.
- `packages/domain/src/storyboard/` types and persistence ports;
  `createPrismaStoryboardRepositories`.
- **9 live-PostgreSQL tests** covering round-trip, tenant isolation on read and
  write, position uniqueness, the cross-tenant insert rejection, and cascades.

### Notes

- No composition algorithm, prompt compiler, moderator, service, HTTP endpoint,
  or UI — those are later 3C milestones.
- `durationSeconds`, `aspectRatio`, and `resolution` are stored as requested. No
  provider capability table and no provisional limits; Phase 4 owns that.
- `packages/domain/src/analysis/` and every HTTP route have a zero diff.
- Size: 571 code lines (343 production, 228 tests) against a ~500 target,
  estimated ~500 — reported, not absorbed.

## [phase-3b3-complete] — Phase 3B-3b: decision interactions

Merged as `6a5c848` (PR #13). The interactive half of the human review UI — see
`docs/phase-3b3b-completion.md`.

### Added

- **Approve / reject from the review page.** Two explicit controls, never a
  toggle. Approve carries an optional note; reject requires a reason and stays
  disabled while it is blank. On success the page calls `router.refresh()` so the
  server component re-renders from the database.
- **Duplicate-primary selection** — a radio group names the primary, and approval
  acts on the selected member, so the request's `primaryAssetId` and its target
  can never disagree.
- **Per-row pending and error state** — `Recording…` while in flight, inline
  errors, and a failed row stays usable.
- **`apps/web/src/lib/decision-errors.ts`** — status-based error presentation:
  `401`/`403`/`404` map to their own message, a `422` renders the API's
  `error.message` **unchanged and unparsed**, and anything else falls back
  generically.
- **jsdom + Testing Library** (`jsdom`, `@testing-library/react`,
  `@testing-library/user-event`) with 13 component tests. The
  `@vitest-environment jsdom` docblock scopes the DOM to `.tsx` tests, so every
  node-environment suite is untouched.

### Fixed

- The client panel no longer imports `@/lib/review-view`, which imports
  `@app/domain`: `next build` caught that it would have pulled server-side domain
  code into the browser bundle. Error presentation now lives in a standalone
  import-free module.

### Notes

- **No request carries `analysisRevision`** — the API accepts no revision token,
  and a test asserts the exact key set of an approve request.
- Duplicate conflict, already-reviewed, blocking finding, missing primary, and
  blank reason are **not** distinguished in the UI. They share one error code
  today, and matching message text would turn a display string into an implicit
  API contract; a machine-readable refusal reason is recorded in
  `docs/decisions/TODO.md`.
- No controls are rendered — not merely disabled — for a decided revision, a
  viewer without `video:review`, or an approve action barred by a blocking
  finding.
- `packages/domain`, the Prisma schema, migrations, and every HTTP contract have
  a zero diff.
- Size: 516 code lines (287 production, 229 tests) against a ~500 target,
  re-cost at 525 before implementation.

## [phase-3b3a-complete] — Phase 3B-3a: read-only review surface

Merged as `c78ecf2` (PR #12). The first half of the human review UI — see
`docs/phase-3b3a-completion.md`.

### Added

- **`/properties/{propertyId}/review`** — a read-only page grouping a property's
  analyses into awaiting decision, decided, and not reviewable yet. Shows signed
  thumbnails, room labels, analysis revisions, blocking findings, warnings, and
  low-confidence cautions. Linked from the property page.
- **Duplicate clusters** — members of a multi-member duplicate group render as
  one choice; a member already holding the group's approval is named, and the
  others say so rather than offering an action that would fail.
- **Immutable decision records** — decision, note, reviewer user id, timestamp,
  and the revision the decision was made against, with the statement that only a
  refresh reopens review.
- **`apps/web/src/lib/review-view.ts`** — the whole presentation model as pure
  functions over domain records, with 13 unit tests. No React, no fetch.
- **Presentation-level authorization** — a role without `video:review` sees a
  read-only banner and no decision affordance; the API enforces the same rule
  independently.
- **Loading state** for the review route.

### Fixed

- `tests/integration/review-duplicate-conflict.db.test.ts` now skips without
  `DATABASE_URL` instead of failing inside a hook. CI, which always sets it, is
  unaffected.

### Notes

- **Nothing mutates.** Approve/reject controls are Phase 3B-3b. Revision numbers
  are display-only: no request carries a revision token, and no optimistic
  concurrency is invented at the UI layer.
- `packages/domain`, the Prisma schema, migrations, and every HTTP contract have
  a zero diff.
- Size: 694 code lines against a ~500 target — reported, not absorbed; see the
  completion report for where the estimate went wrong.

## [phase-3b2-complete] — Phase 3B-2: review HTTP endpoints

Merged as `50c2e4d` (PR #11). Exposes the review decisions over HTTP — see
`docs/phase-3b2-completion.md` and `docs/api-changes-phase-3b2.md`.

### Added

- **Two endpoints**, both requiring `video:review` (CREATOR denied):
  - `POST /api/properties/{propertyId}/assets/{assetId}/analysis/approve`
  - `POST /api/properties/{propertyId}/assets/{assetId}/analysis/reject`
  Separate routes rather than one endpoint with a decision field: they are
  distinct consequential actions, and rejection also mutates asset status.
- **Nested `review` object** on the analysis representation — `status`, `note`,
  `reviewedAt`, `reviewedBy`, `analysisRevision`. `reviewedBy` is the reviewer's
  **user id only**, never expanded into name or email. Additive: no previously
  returned field changed name, type, or position, so the Phase 3A-3 endpoints
  gain the object without breaking clients.
- **15 route tests** covering both decisions, the revision travelling with the
  response, duplicate-group refusals, authentication, CREATOR denial, tenant
  isolation, malformed input, and response hygiene.

### Notes

- Route handlers stay thin adapters: **`AnalysisService` has a zero-line diff**.
  Whether a reason is required, whether `primaryAssetId` is needed or matches,
  and whether a revision was already reviewed are all domain rules the routes
  never re-check.
- Duplicate-group conflicts remain **`422`**, asserted by a test to be `422` and
  not `409`. A future `409` needs a distinct domain error kind and is out of
  scope.
- One Phase 3A-3 assertion ("`reviewedBy` never appears") is **superseded** by
  the decision to expose it, and was rewritten rather than deleted: an unreviewed
  analysis must now report `reviewedBy: null`, and no user name or email may
  appear in any body.

### Not included (deliberately)

- No review UI (Phase 3B-3), no rate limiting, no domain change, no Prisma
  schema change, no migration.

## [phase-3b1b-complete] — Phase 3B-1b: review domain logic

Merged in PR #10 as `2f2f3d76d54bc0a6a0d9e8a0f60c3713d3a8cc05`.
Tagged `phase-3b1b-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Makes human review executable — see
`docs/phase-3b1b-completion.md`.

### Added

- **`AnalysisService.approve` / `.reject`**, gated on `video:review` (OWNER,
  ADMIN, REVIEWER). **CREATOR is denied**: whoever runs an analysis is not
  whoever approves it.
- **Blocking findings cannot be approved.** An analysis carrying a `BLOCKING`
  safety flag can only be rejected.
- **Immutable decisions per revision.** A reviewed analysis refuses further
  decisions; refreshing clears the review state and makes it reviewable again.
- **Duplicate groups are a soft block.** With more than one member in the group,
  `primaryAssetId` is required and must equal the asset being approved. Whether
  another member is already approved is decided by the PostgreSQL partial unique
  index — the service performs **no pre-check read**, which would be a
  check-then-act race. The violation is recognized in the Prisma adapter and
  handed to the domain as a neutral `DuplicateApprovalConflictError`, mapped to
  `VALIDATION_FAILED`, and never retried or reconciled.
- **Rejection is transactional**: the analysis review update and
  `MediaAsset.status = REJECTED` commit together or not at all. Rejected assets
  are then excluded downstream by the existing status checks.
- **Reason handling**: required and non-blank for rejection, optional for
  approval, recorded as `null` when absent.
- **`analysisRevision` transitions**: first successful analysis → 1, successful
  refresh → previous + 1, failed refresh → unchanged. Keyed on whether the run
  was a refresh, never inferred from the row reaching `SUCCEEDED`, since an
  initial analysis and a refresh both end there.
- **Audit** `analysis.approved` / `analysis.rejected` carrying `analysisId`,
  `assetId`, `propertyId`, `organizationId`, `actorId`, `reason`, and
  `analysisRevision`.
- **32 new tests** covering revision semantics, approval and rejection,
  immutability, duplicate rules, authorization, tenant isolation, transactional
  failure consistency, and audit payloads.

### Notes

- No Prisma schema or migration change; everything needed shipped in 3B-1a.
- **Database error interpretation lives in the adapter.** The domain reacts to a
  neutral `DuplicateApprovalConflictError` and imports nothing from Prisma;
  recognizing the underlying constraint violation is the repository's job.
- **A live-PostgreSQL test covers the whole runtime path** — service → Prisma
  repositories → PostgreSQL → adapter translation → `AppError`. It caught a real
  defect: the adapter matched the violation by index name, which Prisma never
  reports (it identifies the constraint by covered fields), so the translation
  would silently never have fired in production.
- `InMemoryAssetAnalysisRepository` mirrors the partial unique index and raises
  the same neutral error, so unit tests exercise the mapping rather than passing
  against a permissive double.
- Audit atomicity remains outside the transaction — still the transactional-
  outbox item in `docs/decisions/TODO.md`.

### Not included (deliberately)

- No HTTP endpoints (Phase 3B-2) and no review UI (Phase 3B-3).

## [phase-3b1a-complete] — Phase 3B-1a: review infrastructure

Merged in PR #9 as `0a7818f10371bcf8072b6b8cc2f501c9b5868f97`.
Tagged `phase-3b1a-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Persistence and the transaction boundary for human
review — see `docs/phase-3b1a-completion.md`.

### Added

- **Review columns on `asset_analyses`**: `reviewStatus` (`UNREVIEWED` /
  `APPROVED` / `REJECTED`, default `UNREVIEWED`), `reviewNote`, and
  `analysisRevision` (default 1), plus an index on
  `(organizationId, reviewStatus)`. Additive migration, no backfill.
- **A partial unique index** making the database authoritative for "at most one
  `APPROVED` analysis per duplicate group", so concurrent approvals of two
  members of a group cannot both succeed. Prisma cannot express a partial index,
  so it is hand-written in the migration under **ADR-0011 — database constraints
  beyond the Prisma schema**; the CI drift check still passes, and the
  `prisma migrate dev` caveat is recorded in `docs/migration-notes.md`.
- **`ReviewTransaction` port** with Prisma and in-memory implementations. The
  Prisma implementation rebuilds both repositories against the transaction
  client *inside* `run`, so both writes of a rejection go through the same
  transaction; the in-memory implementation snapshots and restores state on
  throw, giving the double real rollback semantics.
- **Domain review types**: `ReviewStatus`, `REVIEW_STATUSES`, `isReviewStatus`,
  `isReviewed`. `analysisRevision` identifies the persisted *result* — it starts
  at 1 and increments only on a successful refresh, so a failed refresh leaves
  it unchanged.
- **12 new tests**: 8 live-PostgreSQL (partial-index behaviour across five
  cases, transaction commit and rollback, review-column round-trip) and 4 for
  the in-memory transaction double.

### Not included (deliberately)

- No `approve` / `reject` service methods, no audit events, no HTTP surface and
  no UI — Phase 3B-1b onward.
- Audit atomicity is **not** covered by `ReviewTransaction`; it remains the
  transactional-outbox item in `docs/decisions/TODO.md`.

## [phase-3a3-complete] — Phase 3A-3: analysis HTTP endpoints

Merged in PR #8 as `e3fcc7410052ded01e936f75b00dbec239ac2e3e`.
Tagged `phase-3a3-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Closes Phase 3A — see
`docs/phase-3a3-completion.md` and `docs/api-changes-phase-3a3.md`.

### Added

- **Four analysis endpoints**, making `AnalysisService` reachable from the web
  app for the first time:
  - `POST /api/properties/{propertyId}/assets/{assetId}/analysis`
  - `POST /api/properties/{propertyId}/assets/{assetId}/analysis/refresh`
  - `GET  /api/properties/{propertyId}/assets/{assetId}/analysis`
  - `GET  /api/properties/{propertyId}/analyses`
- **Analysis DTO** that omits `organizationId`, the internal `provider` name and
  the unwritten review columns, and adds `lowConfidence` / `hasBlockingFlag`
  derived server-side so clients cannot drift from the documented thresholds.
- **`@app/ai-providers` barrel exports** for `DeterministicImageAnalysisProvider`
  and `createImageAnalysisProvider`. The barrel still held only the Phase 0
  placeholder, so the adapter shipped in 3A-1 was unreachable outside its package.
- **13 route tests** that stub only session resolution and run against a real
  `AnalysisService`, covering idempotency, refresh, eligibility, authentication,
  authorization, tenant isolation, validation, and response hygiene.

### Notes

- Route handlers are thin adapters: authenticate, validate shape, delegate, map.
  No business decision lives in the web layer, and `AnalysisService` is unchanged
  by this milestone.
- `organizationId` is caller-supplied and membership-verified, matching the
  Phase 1/2 convention — the session has no active-organization concept. The
  convention is recorded in **ADR-0010 — organization context resolution**.
- `POST` returns `200` rather than `201`, and a non-`READY` asset is `422` rather
  than `409`: distinguishing those cases in the route would require it to
  interpret why the service refused. See `docs/api-changes-phase-3a3.md`.

### Not included (deliberately)

- **No rate limiting.** No rate limiter exists anywhere in the codebase yet;
  adding one for analysis alone would leave login, registration and upload
  unprotected. Recorded in `docs/decisions/TODO.md` as a cross-cutting milestone.
- No review UI or approval endpoints (Phase 3B), no Prisma schema change, and no
  real vision provider (ADR-0009).

## [phase-3a2c-complete] — Phase 3A-2c: refresh, duplicate grouping, ordering, reads

Merged in PR #7 as `e49ae6aa3466fdeaf8d616084c7163a15f9466f5`.
Tagged `phase-3a2c-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Completes `AnalysisService` to the full Phase 3A-2
contract — see `docs/phase-3a2c-completion.md`.

### Added

- **`refresh` option** on `analyzeAsset`. Recomputes an analysis that already
  `SUCCEEDED`, reusing the same row and calling the provider again, and emits
  `analysis.refreshed`. Without it, an existing `SUCCEEDED` row is still
  returned untouched with no provider call.
- **Stale-state clearing on reservation.** A refresh resets the row to `PENDING`
  with every result field cleared — room type, all four scores, duplicate group,
  detected objects, safety flags, suggested order, failure reason — *before* the
  provider runs, so a refresh that fails ends in `FAILED` with nothing from the
  previous run surviving.
- **Duplicate grouping wired into the success path.** `resolveDuplicateGroup`
  now runs against same-organization assets that carry a perceptual hash,
  excluding the subject asset, and the result is persisted. Both the asset and
  analysis lookups are tenant-scoped, so a cross-tenant photo can never
  influence a group.
- **`suggestedOrder` persisted** via `roomOrderRank`, following the documented
  room sequence; `OTHER` ranks after every recognized room type.
- **Organization-scoped read methods** `listForProperty` and `getForAsset`, with
  read-level authorization — any member may read, including `REVIEWER`, who
  cannot start or refresh an analysis. `getForAsset` throws `NOT_FOUND` when no
  analysis exists.
- **18 new unit tests** covering refresh semantics, stale-state clearing,
  duplicate grouping (identical, distant, cross-tenant, and null hashes), room
  ordering, and read scoping/authorization.

### Not included (deliberately)

- No Prisma schema or migration change — the columns already existed.
- No HTTP endpoints (Phase 3A-3), no review UI (Phase 3B).
- No transactional outbox and no concurrent provider-call deduplication; both
  remain open TODO items.
- **No real vision provider** — offline deterministic adapter only (ADR-0009).

## [phase-3a2b-complete] — Phase 3A-2b: AnalysisService orchestration

Merged in PR #6 as `40580866469b3d891f719cb9d83f17bf8b692081`.
Tagged `phase-3a2b-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Merged as a one-time size exception — see
`docs/phase-3a2b-completion.md`.

### Added

- **`AnalysisService.analyzeAsset`** (`@app/domain`): authorizes
  `property:write`, accepts READY assets only, reserves a `PENDING` row before
  calling the provider, merges provider safety flags with platform-derived
  quality flags keeping the most severe per code, persists `SUCCEEDED`, and
  emits `analysis.requested` / `analysis.succeeded` / `analysis.failed`.
- **Failure-consistent, retry-safe, idempotent at the persisted analysis-row
  level.** Every write is a single-row status transition. A provider failure can
  only produce `FAILED`, never a completed record. A failed terminal write leaves
  the row `PENDING` with null result fields and surfaces the error. Retries reuse
  the existing row and converge on the same result. This is **not** full
  transactional atomicity: the analysis row and its audit entry are written
  separately (see the consistency boundary below).
- **Documented consistency boundary.** The analysis row is persisted *before*
  its audit event, so an audit-sink failure can return an error while the
  analysis remains `SUCCEEDED`. This is intentional — the alternative, losing a
  completed analysis because its audit write failed, is worse. Strict atomicity
  between analysis persistence and audit persistence would require a shared
  database transaction or a transactional outbox; recorded in
  `docs/decisions/TODO.md`.
- **Concurrency reconciliation.** The unique index on `asset_analyses.assetId`
  is the concurrency control: a request whose insert loses the race re-reads and
  adopts the winner's row instead of creating a second one. A create failure
  that is not a uniqueness conflict is rethrown.
- **`InMemoryAssetAnalysisRepository`** (`@app/domain/testing`): organization-
  scoped test double that mirrors the unique-`assetId` constraint and rejects
  asynchronously, the way a real constraint violation surfaces.
- **28 new unit tests**, including the six required resilience cases: provider
  timeout, provider exception, repository write failure, audit write failure,
  repeated retry after failure, and concurrent duplicate requests.

### Not included (deliberately)

- No `refresh` option, so a `SUCCEEDED` analysis cannot yet be recomputed
  (Phase 3A-2c).
- No duplicate-group resolution or `suggestedOrder` persistence, though both
  pure functions exist from 3A-1 (Phase 3A-2c).
- No read APIs (`listForProperty`, `getForAsset`) and no HTTP endpoint, so the
  service is not yet reachable from the web app (Phase 3A-2c / 3A-3).
- **No real vision provider** — offline deterministic adapter only (ADR-0009).

### Known limitation

Concurrent requests for the same asset each perform their own provider call.
The row is never duplicated and both converge on the same result, but
deduplicating the work needs a lease or conditional status update, which belongs
with the job queue in Phase 4.

## [phase-3a2a-complete] — Phase 3A-2a: analysis persistence and live-PostgreSQL CI

Merged in PR #5 as `8d1bed31e4d3744865d1a09a1fc08feb3da3e16f`.
Tagged `phase-3a2a-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). Scoped to persistence and its verification only — see
`docs/phase-3a2a-completion.md`.

### Added

- **`asset_analyses` table** (`packages/database/prisma/schema.prisma`) with the
  `AnalysisStatus` and `RoomType` enums, a unique `assetId` foreign key to
  `media_assets` (`ON DELETE CASCADE`), `jsonb` columns for detected objects and
  safety flags, and indexes on `(organizationId, status)` and
  `(organizationId, duplicateGroup)`.
- **Migration `00000000000002_phase3a2_asset_analysis`** — additive only, no
  backfill, generated from the committed schema.
- **`createPrismaAnalysisRepository`** implementing the Phase 3A-1
  `AssetAnalysisRepository` port. Every read filters on `organizationId`, so
  another tenant's row is not found rather than merely forbidden.
- **Live-PostgreSQL CI job** (`database` in `.github/workflows/ci.yml`): applies
  the committed migrations to an empty PostgreSQL 16 service container, runs the
  shadow-database drift check with `--exit-code`, and executes the integration
  suite. Throwaway credentials only; no production data.
- **`tests/integration/analysis-repository.db.test.ts`** — real-database
  coverage for JSON round-tripping, cross-tenant invisibility, the one-analysis-
  per-asset unique constraint, list filtering, and cascade on asset deletion.
- **`pnpm test:db`** with `vitest.integration.config.ts`; `pnpm test` stays
  offline and requires no database.
- **Root `tsconfig.json`** so the Vitest configs and `tests/**` are typechecked
  (they previously were linted but not typechecked).

### Not included (deliberately)

- No `AnalysisService`: no authorization, audit emission, idempotency, or
  provider invocation yet (Phase 3A-2b).
- No in-memory analysis repository double — it ships with the service that
  consumes it (Phase 3A-2b).
- No HTTP endpoints, review UI, storyboard generation, or prompt compilation
  (Phase 3A-3 / 3B / 3C).
- **No real vision provider** — offline deterministic adapter only (ADR-0009).

## [phase-3a1-complete] — Phase 3A-1: analysis contracts and deterministic offline provider

Merged in PR #4 as `a2bbf473512c8f0c0df4121b1111e66b08699dd7`.
Tagged `phase-3a1-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`). First Phase 3A milestone — see
`docs/gap-analysis-phase-3a1.md` for why Phase 3A was split.

### Added

- **Analysis domain contracts (`@app/domain`)**
  - `AssetAnalysis` entity: room type, confidence, quality/brightness/blur
    scores, duplicate-group reference, detected objects, safety and privacy
    flags, suggested display order, status, and failure reason.
  - 15-value `RoomType` vocabulary with an `isRoomType` guard, and
    `AnalysisStatus` (`PENDING` / `SUCCEEDED` / `FAILED`).
  - Eight safety/privacy flag codes with `BLOCKING` / `WARNING` severity, plus
    `hasBlockingFlag` and `isLowConfidence` (threshold 0.6).
- **`ImageAnalysisProvider` boundary** with normalized `AnalysisRequest` /
  `AnalysisResult` / `AnalysisProviderError` types (ADR-0009).
- **Platform-owned normalization**: `normalizeAnalysisResult` (unknown room type
  → `OTHER` with zero confidence, scores clamped to 0..1 with any non-finite
  value mapped to 0, objects capped at 50, flags at 20), `deriveQualityFlags`
  (resolution, blur, exposure warnings), and `analysisProviderError` with
  explicit retryability.
- **Ordering and duplicate rules**: `roomOrderRank` implementing the documented
  room sequence, and `resolveDuplicateGroup` reusing Phase 2 perceptual hashes
  with hamming distance.
- **Deterministic offline adapter (`@app/ai-providers`)**:
  `DeterministicImageAnalysisProvider` performs no network I/O; room type and
  scores derive from the asset id, brightness is measured from real bytes.
- **Configuration**: `ANALYSIS_PROVIDER` (server-side, `deterministic` only;
  the factory fails fast on any other value).
- **Documentation**: ADR-0009, Phase 3A-1 gap analysis, analysis lifecycle
  sequence diagram, architecture and ER diagram updates, API change summary
  (not applicable), migration notes, and the Phase 3A-1 completion report.

### Not included (deliberately)

- No persistence: no Prisma model, migration, or repository (Phase 3A-2a).
- No `AnalysisService`, so no audit emission, authorization, or idempotency
  behaviour yet — only the audit action vocabulary (Phase 3A-2b).
- No live PostgreSQL CI job (Phase 3A-2a).
- No review UI, storyboard generation, or prompt compilation (Phase 3B / 3C).
- **No real vision provider** — offline deterministic adapter only (ADR-0009).

## [phase-2-complete] — Phase 2: Properties and secure media upload

Merged in PR #3 as `653372a54d72d8dacc38fb7103ad32f15041cc2f`.
Tagged `phase-2-complete` locally; the remote tag is **not** yet published
(see `docs/progress.md`).

### Added

- **Property management**
  - `Property` domain entity with `PropertyService`: create, get, list, update,
    and soft delete, all organization-scoped and permission-checked.
  - Mandatory photo-rights confirmation when creating a property.
  - `POST`/`GET /api/properties`, plus create forms on the dashboard.
- **Media asset domain**
  - `MediaAsset` entity with a ten-state upload lifecycle and `AssetService`
    (`requestUpload`, `completeUpload`, `retryUpload`, `createDownloadUrl`,
    `requestDeletion`, `list`).
  - Per-property file-count, file-size, and image-dimension limits as
    configuration (`DEFAULT_UPLOAD_LIMITS`).
- **Object storage abstraction (`@app/storage`)**
  - `ObjectStorage` port with `LocalObjectStorage` (in-process) implementation.
  - HMAC-SHA256 signed storage tokens that are expiring and **single-purpose**
    (upload XOR download), bound to exactly one storage key.
  - Tenant-scoped, opaque storage keys:
    `org/{orgId}/properties/{propertyId}/assets/{assetId}/{variant}.{ext}`.
  - `PUT /api/storage/upload` and `GET /api/storage/download`, authorized by
    token alone and never by a caller-supplied key.
- **Media processing pipeline**
  - `SharpImageProcessor`: EXIF/GPS metadata removal, EXIF orientation
    correction, normalization to a bounded long edge, and WebP thumbnails.
  - 64-bit average-hash perceptual hashing (16 hex chars) plus
    `hammingDistanceHex` for the duplicate-detection foundation.
  - `MalwareScanner` port with `PassthroughMalwareScanner` (EICAR-aware) and a
    `QUARANTINED` terminal state.
  - Content-based MIME validation from magic bytes (JPEG/PNG/WebP allowlist).
- **Upload UI**
  - Property detail page with a drag-and-drop `UploadPanel` showing real
    per-file progress via XHR, processing/ready/error states, duplicate hints,
    and a retry action for failed uploads.
- **Persistence**
  - Prisma `Property` and `MediaAsset` models, four new enums, tenant-first
    indexes, and migration `00000000000001_phase2_properties_media`.
  - Organization-scoped Prisma repositories for properties and assets.
- **Audit logging** — eleven new actions covering every property and asset write.
- **Retention foundation** — `DELETION_PENDING`/`DELETED` states,
  `deletionRequestedAt`, `retentionExpiresAt`; deleting a property cascades its
  assets to `DELETION_PENDING`.
- **Configuration** — `STORAGE_SIGNING_SECRET` (server-only, validated).
- **Documentation** — architecture diagram, ER diagram, upload-lifecycle
  sequence diagram, API change summary with an OpenAPI fragment, this changelog,
  release notes, migration notes, `docs/progress.md`, ADR-0008, Phase 2 gap
  analysis, and the Phase 2 completion report.

### Changed

- `recordAudit` now accepts a narrower `AuditSink` dependency so both the
  identity and property domains can emit audit events without coupling.
- `@app/domain` exports the property/media surface; `@app/storage` is no longer
  a placeholder.
- Vitest resolves workspace subpath exports (e.g. `@app/domain/testing`).
- `sharp` is declared in `apps/web` and listed in `serverExternalPackages` so
  Next leaves it external and its native binary resolves under pnpm.

### Security

- Declared filename and Content-Type are never trusted; the real type comes from
  magic bytes and the size is re-verified against the stored object.
- Storage keys contain only internal ids and are never returned to the browser.
- Upload tokens cannot be replayed as download tokens; key tampering invalidates
  the signature; expired tokens are rejected.
- Quarantined, rejected, and failed assets are never downloadable.
- Download responses set `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`, and a sandboxing CSP.
- Client filenames are stripped of path components and control characters.
- **Production-safety guard:** `LocalObjectStorage` and
  `PassthroughMalwareScanner` throw `NonProductionAdapterError` when
  constructed under `NODE_ENV=production`. The message names the adapter and
  the required action and contains no secrets; development and test are
  unaffected.

### Known limitations

- `LocalObjectStorage` keeps objects in process memory: not durable and not
  multi-instance safe. A durable S3/Azure adapter is required before production.
- Image processing runs inline in the upload-completion request rather than on
  the async worker.
- No live-PostgreSQL integration job in CI yet.

## [phase-1-complete] — Identity, organizations, and tenant isolation

Merged in PR #2 as `62259776f88fa1010736e8a365618b7c20c38902`.

### Added

- PostgreSQL + Prisma persistence with organization-scoped repositories.
- Identity domain: users, organizations, memberships, RBAC roles, invitations.
- Email/password authentication (scrypt) with server-side sessions; session and
  invitation tokens stored only as SHA-256 hashes.
- Audit-log foundation with an event for every identity/organization write.
- Automated cross-tenant isolation tests.
- Real `WaveSpeedVideoProvider` behind `VideoGenerationProvider` with an injected
  HTTP client (no real API calls in tests).

## [phase-0-complete] — Engineering foundation

Merged in PR #1 as `5185fea6fdf5458b72a316ec94fcd0fe9cc54443`.

### Added

- pnpm monorepo, strict TypeScript, ESLint, Vitest, and GitHub Actions CI
  (typecheck, lint, test, build).
- `VideoGenerationProvider` abstraction with an offline `FakeVideoProvider`.
- Authenticated health-check application and worker bootstrap.
- Zod-validated server-only environment and a redacting structured logger.
- ADR-0001…0005, gap analysis, and the Phase 0 completion report.
