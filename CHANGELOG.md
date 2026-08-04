# Changelog

All notable changes to this project. Phases correspond to `docs/Roadmap.md`.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — Phase 3D-1: review-correction persistence

Under review. Not merged. See `docs/phase-3d1-completion.md` and ADR-0015.

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
