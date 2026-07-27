# Phase 3 Milestone Plan — AI Analysis and Storyboard

Version: 1.0 (proposal)
Status: **Proposed plan only. Not approved. No Phase 3 branch or code exists.**
Governance: `CLAUDE.md` v1.3 — each milestone is a separate PR, normally ≤ ~500
changed lines excluding lockfiles and generated migrations, reviewed and CI-green
and merged before the next begins.

## Phase 3 scope (docs/Roadmap.md)

- room classification adapter
- quality, duplicate, privacy, and safety analysis
- editable room labels and image order
- storyboard generation
- prompt compilation and moderation

**Phase completion criteria:** users can review and correct **all** AI decisions
before generation.

## Proposed split

Three milestones, sequenced so each is independently useful, independently
compiles and tests, and never leaves a half-exposed feature.

```text
Phase 3A: Analysis domain + adapter boundary + persistence
→ review and merge
Phase 3B: Analysis review UI (editable labels, ordering, exclusion)
→ review and merge
Phase 3C: Storyboard generation + prompt compilation and moderation
→ review and merge
```

Rationale for this order: 3A establishes the data and the vendor-neutral seam
with no user-visible surface; 3B makes AI decisions correctable (the phase's
completion criterion) before anything consumes them; 3C only then compiles
reviewed decisions into a storyboard and prompts.

---

## Phase 3A — Analysis domain, adapter boundary, and persistence

**Objective.** Persist per-asset AI analysis behind a provider-neutral port, and
produce analysis records for uploaded assets using a deterministic offline
adapter. No user-visible behavior changes.

**Scope.**
- `AssetAnalysis` entity per `docs/DataModel.md`: room type, confidence, quality/
  blur/brightness scores, duplicate group, detected objects, safety flags,
  suggested order, reviewer fields.
- `ImageAnalysisProvider` port in `@app/domain` returning normalized internal
  types only (no vendor payloads past the boundary), mirroring the
  `VideoGenerationProvider` pattern.
- `FakeImageAnalysisProvider` in `@app/ai-providers`: deterministic, offline, no
  network — the Phase 3 default, same discipline as `FakeVideoProvider`.
- Provider factory + `ANALYSIS_PROVIDER` env (default `fake`); a real vision
  adapter is **out of scope** for 3A.
- Quality/duplicate/privacy/safety evaluation as pure domain logic over analysis
  inputs; promote the existing `hammingDistanceHex` duplicate foundation into
  duplicate-group assignment.
- `AnalysisService`: run analysis for an asset, persist, emit audit events.
  Organization-scoped; blocking vs warning flags separated per
  `docs/ProductRequirements.md`.
- Prisma model + additive migration; org-scoped Prisma repository; in-memory
  repository for tests.

**Files / modules likely affected.**
- `packages/domain/src/analysis/{types,ports,analysis-service,rules,audit,index}.ts`
- `packages/domain/src/testing/in-memory-analysis.ts`
- `packages/ai-providers/src/{fake-analysis-provider,factory,index}.ts`
- `packages/database/prisma/schema.prisma` + new migration
- `packages/database/src/analysis-repositories.ts`, `src/index.ts`
- `packages/shared/src/env.ts` (`ANALYSIS_PROVIDER`)
- `docs/` — ADR for the analysis adapter boundary; ER diagram update

**Tests required.**
- Unit: quality/blur/brightness thresholds; blocking vs warning classification;
  duplicate-group assignment via hamming distance; low-confidence detection.
- Adapter: fake provider determinism; factory selection; offline guarantee (no
  network in tests).
- Tenant isolation: analysis records unreadable/unwritable across organizations
  (read **and** write).
- Audit: every analysis write emits an event.
- Production guard: any non-production analysis adapter refuses
  `NODE_ENV=production`, consistent with ADR-0008 precedent.

**Completion criteria.**
- Uploading an asset produces a persisted `AssetAnalysis` with all documented
  fields.
- Low-confidence results are flagged, never silently accepted.
- Cross-tenant denial and audit coverage proven by tests.
- typecheck, lint, tests, and production build pass; no user-visible surface yet.

**Dependencies.** Phase 2 (`MediaAsset`, `READY` lifecycle, perceptual hashes).
None on 3B/3C.

**Estimated size.** ~450–500 lines excluding the generated migration.

---

## Phase 3B — Analysis review UI (editable labels, ordering, exclusion)

**Objective.** Let users review and correct every AI decision — the phase's
completion criterion.

**Scope.**
- Domain: `updateAnalysisReview` — override room label, reorder, exclude/include
  an asset, acknowledge warnings; record `reviewedBy`; audit each correction.
- Guard: assets with unresolved **blocking** flags cannot be marked ready for
  storyboarding; warnings require explicit acknowledgement.
- API: list analyses for a property; patch a single analysis; bulk reorder.
- UI on the property page: each photo with thumbnail (existing signed preview
  URL), editable room-type select, confidence and quality indicators, privacy/
  safety warnings, exclude toggle, and drag-or-control reordering. Low-confidence
  items visibly marked. Keyboard-accessible controls and visible focus states per
  `docs/UXFlow.md`.
- Room-type vocabulary from `docs/ProductRequirements.md` (15 values).

**Files / modules likely affected.**
- `packages/domain/src/analysis/{analysis-service,types}.ts` (review methods)
- `apps/web/src/app/api/properties/[propertyId]/analyses/route.ts`
- `apps/web/src/app/api/analyses/[analysisId]/route.ts`
- `apps/web/src/app/properties/[propertyId]/{analysis-panel.tsx,page.tsx}`
- `apps/web/src/app/globals.css`
- `docs/api-changes-phase-3.md`, UX notes

**Tests required.**
- Unit: label override persists and marks the record reviewed; reorder produces a
  contiguous ordering; exclusion removes an asset from the ready set; blocking
  flags cannot be bypassed; warnings need acknowledgement.
- Authorization: `CREATOR` may edit, `REVIEWER` may not (mirrors Phase 2 RBAC).
- Tenant isolation: cross-tenant analysis edits denied (read **and** write).
- Audit: every correction emits an event with before/after values.
- Accessibility: labelled controls and keyboard operability on the review panel.

**Completion criteria.**
- A user can correct **every** AI decision: room label, order, inclusion,
  warning acknowledgement.
- Low-confidence classifications cannot silently proceed.
- All corrections audited; cross-tenant edits denied.
- typecheck, lint, tests, and production build pass.

**Dependencies.** **Requires 3A merged** (analysis records and service must
exist).

**Estimated size.** ~450–500 lines.

---

## Phase 3C — Storyboard generation, prompt compilation, and moderation

**Objective.** Turn reviewed analyses into an ordered storyboard with compiled,
moderated, preservation-first prompts — ready for Phase 4 generation.

**Scope.**
- `VideoProject` and `StoryboardScene` entities per `docs/DataModel.md`
  (project settings, per-scene asset/position/room/duration/camera motion/
  compiled prompt).
- Storyboard generation from reviewed analyses using the documented ordering
  (exterior → entrance → hallway → living → dining → kitchen → bedroom → wet
  areas → storage → balcony), using **only** available photos and never
  synthesizing missing rooms.
- Scene duration allocation against a requested total length.
- Prompt compilation keeping system constraints, property context, room metadata,
  user prompt, negative prompt, and brand template **separate**, with the
  mandatory preservation rules from `docs/AIVideoPipeline.md` (do not add
  nonexistent windows/doors/equipment/views/rooms; do not alter materials or
  apparent size; no people or fictional logos).
- Moderation of user prompt and negative prompt via a `PromptModerator` port with
  an offline default implementation; rejected prompts surface a sanitized reason.
- API: generate storyboard, read storyboard, patch scene order/duration/prompt.
- UI: storyboard preview presented as a sequence, explicitly **not** a claim of
  actual geometry.
- Prisma models + additive migration.

**Files / modules likely affected.**
- `packages/domain/src/storyboard/{types,ports,storyboard-service,ordering,prompt-compiler,moderation,audit,index}.ts`
- `packages/domain/src/testing/in-memory-storyboard.ts`
- `packages/database/prisma/schema.prisma` + new migration;
  `src/storyboard-repositories.ts`
- `apps/web/src/app/api/video-projects/**`, storyboard UI components
- `docs/` — sequence diagram for storyboard compilation, ER update, ADR for
  prompt compilation and moderation

**Tests required.**
- Unit: ordering rules; ordering with missing room types; duration allocation
  sums to the requested length; excluded assets never appear; no fabricated
  scenes.
- Prompt compilation: preservation clauses always present; user prompt cannot
  override system constraints (injection attempt); negative prompt preserved;
  brand template kept separate.
- Moderation: disallowed prompts rejected with a sanitized reason and audited;
  moderation failures are **not** auto-retried.
- Tenant isolation: storyboards and projects denied across organizations (read
  **and** write).
- Audit: storyboard generation and every scene edit emit events.

**Completion criteria.**
- A reviewed property yields a storyboard whose scenes reference only included
  assets in documented order, with compiled prompts carrying the mandatory
  preservation rules.
- Moderation blocks disallowed prompts with a sanitized reason.
- Cross-tenant denial and audit coverage proven.
- typecheck, lint, tests, and production build pass.
- **Phase 3 completion criterion satisfied**: users can review and correct all AI
  decisions before generation (3B) and the storyboard derives only from those
  reviewed decisions (3C).

**Dependencies.** **Requires 3A and 3B merged.** Deliberately excludes all Phase
4 work: no provider submission, webhooks, polling, or managed-storage copy.

**Estimated size.** ~500 lines excluding the generated migration; if prompt
compilation plus the storyboard UI exceeds that during implementation, it will be
split again into `3C-1` (storyboard domain + API) and `3C-2` (prompt compilation,
moderation, and UI) **before** the code grows further.

---

## Cross-milestone commitments

- **Documentation per merged milestone** (`CLAUDE.md` v1.3): update the ER
  diagram, add/refresh the relevant sequence diagram, record API changes,
  changelog, and migration notes. The architecture diagram is updated when a
  module boundary changes. A single Phase 3 completion report lists all three
  milestone PRs, their merge commits, test results, limitations, and remaining
  work.
- **Carried-over items to resolve inside Phase 3** (from
  `docs/decisions/TODO.md`): the near-duplicate block-vs-warn UX decision lands
  in 3B, and the live-PostgreSQL CI integration job should land alongside 3A now
  that a third schema migration exists.
- **No real vision provider in Phase 3.** Offline deterministic adapters only,
  behind ports, matching the Phase 0–2 discipline. Selecting a real provider is a
  separate decision with its own ADR and cost controls.
- **Tag policy.** `phase-3-complete` is created only after all three milestone
  PRs are merged and verified — never on a feature branch, never per-milestone.

## Approval requested

This is a plan, not an implementation. Requested decisions:

1. Approve or amend the 3A / 3B / 3C split and ordering.
2. Confirm the offline-adapter-only stance for Phase 3.
3. Confirm whether the live-PostgreSQL CI job should be folded into 3A.
4. Confirm 3A may begin, and whether a branch should be created at that point.
