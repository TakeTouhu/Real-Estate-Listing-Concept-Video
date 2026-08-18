# Delivery Progress

Tracks phase status, merge commits, and release tags. `docs/Roadmap.md` remains
the authoritative scope definition; this file records what has actually shipped.

## Governance (CLAUDE.md v1.3)

### Pull request and milestone policy

- Each PR is the smallest reviewable vertical milestone, normally **≤ ~500
  changed lines** excluding lockfiles and generated migrations.
- Larger phases are split into milestone PRs (`Phase 3A`, `Phase 3B`, …); each is
  reviewed, CI-green, and merged before the next begins.
- After opening a milestone PR, stop and wait for review unless explicitly told
  to continue.

### Release-tag policy

- Every completed and merged phase receives an **annotated** Git tag named
  `phase-<n>-complete`.
- A phase tag is created only after: review approval, CI success, merge into
  `main`, and verification of the pulled merged commit.
- Tags are **never** moved, overwritten, or reused, and are never created on a
  feature branch — always on the merged commit on `main`.
- Each phase completion report records the tag name, tag object SHA, target
  commit SHA, and the verification result.
- If the environment cannot publish tag refs, the blocker is recorded explicitly
  with the exact manual push command, and **the remote tag is not claimed to
  exist** until verified on GitHub.

## Status

| Phase | Scope | Status | PR | Merge commit | Tag | Tag SHA |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Engineering foundation | ✅ Merged | #1 | `5185fea6fdf5458b72a316ec94fcd0fe9cc54443` | `phase-0-complete` | `76d36045934a97bc4a997a64dcd1e932cfe837de` |
| 1 | Identity, organizations, tenant isolation | ✅ Merged | #2 | `62259776f88fa1010736e8a365618b7c20c38902` | `phase-1-complete` | `7d8bc81b460568becc82bc49cfc15b345d23d5a6` |
| 2 | Properties and secure media upload | ✅ Merged | #3 | `653372a54d72d8dacc38fb7103ad32f15041cc2f` | `phase-2-complete` | `b13e5490f2014dc43a3815c3570795c955a2089a` |
| 3 | AI analysis, human review and correction, storyboard | ✅ Merged (24 milestones, #4 … #27) | #27 (final) | `541ada413a6c7b71df5169faca0592626c9be454` | `phase-3-complete` | see the tag table below |
| 4 | WaveSpeedAI scene generation | 🔄 In progress (4A and 4B-1 closed; 4B-2a merged, 4B-2b in review) | #28 … #34 merged | `be9259681ba3caf179f8ec73aee98943a9672cd8` (latest) | — | — |
| 5 | Video composition and review | ⏳ Not started | — | — | — | — |
| 6 | Billing and commercial controls | ⏳ Not started | — | — | — | — |
| 7 | SaaS operations and production readiness | ⏳ Not started | — | — | — | — |
| 8 | Beta and launch | ⏳ Not started | — | — | — | — |

All four phase tags are **annotated** tags created on `main` (never on a feature
branch), and each target was verified to equal the corresponding squash-merge
commit. None has been moved, overwritten, or reused.

| Tag | Tag object SHA | Target commit | Target verified |
| --- | --- | --- | --- |
| `phase-0-complete` | `76d36045934a97bc4a997a64dcd1e932cfe837de` | `5185fea6fdf5458b72a316ec94fcd0fe9cc54443` | ✅ |
| `phase-1-complete` | `7d8bc81b460568becc82bc49cfc15b345d23d5a6` | `62259776f88fa1010736e8a365618b7c20c38902` | ✅ |
| `phase-2-complete` | `b13e5490f2014dc43a3815c3570795c955a2089a` | `653372a54d72d8dacc38fb7103ad32f15041cc2f` | ✅ |
| `phase-3-complete` | `bbc711d2e7aa8275e17f301f0eec24f51f8f0512` | `541ada413a6c7b71df5169faca0592626c9be454` | ✅ |

Milestone tags (`phase-3d4b-complete` and its siblings) are recorded in their own
milestone completion reports, not here.

`phase-4b2a-complete` is the first tag whose target is a **merge commit** rather
than a squash-merge commit: PR #34 was merged with `--merge` on instruction, to
keep the three-commit sequence (original contract fix, blocker fixes, correction
of an unverified claim) as the record. Tag object `2310161d7804388262744a39c344c3bded56e211`,
target `be9259681ba3caf179f8ec73aee98943a9672cd8`, created on `main` after the
merge was fetched and verified. Publication failed exactly as below.

> ### ⚠️ No completion tag has been published to the remote
>
> Every `phase-*-complete` tag exists **only in the local clone**. Publication is
> blocked in this development environment and has been re-attempted, and re-failed,
> at every milestone closure since Phase 0.
>
> ```text
> error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403
> send-pack: unexpected disconnect while reading sideband packet
> fatal: the remote end hung up unexpectedly
> ```
>
> Branch pushes to the same remote succeed, so the proxy rejects tag refs
> specifically. The available GitHub tooling exposes no create-ref/create-tag
> API — only `get_tag` / `list_tags`.
>
> **This document does not claim any remote tag exists.** Deliberately no count
> and no ref list is recorded here: both go stale at every milestone, and a stale
> number reads as a claim about remote state. Inspect the real state instead:
>
> ```bash
> git tag -l 'phase-*-complete'                     # what exists locally
> git for-each-ref --format='%(refname:short) %(objecttype) %(*objectname)' \
>   refs/tags/                                      # tag object type and target
> git ls-remote --tags origin                       # what exists on the remote
> ```
>
> A maintainer with tag-push permission publishes them normally:
>
> ```bash
> git push origin --tags
> git ls-remote --tags origin                       # verify
> ```
>
> Each tag is annotated, created on `main` after the merge was pulled and
> verified, and targets the exact squash-merge commit. None has been moved,
> overwritten, or reused. Per-milestone tag object SHAs and targets are recorded
> in each `docs/phase-*-completion.md`.

## Phase reports

- `docs/gap-analysis.md`, `docs/phase-0-completion.md`
- `docs/gap-analysis-phase-1.md`, `docs/phase-1-completion.md`
- `docs/gap-analysis-phase-2.md`, `docs/phase-2-completion.md`
- `docs/gap-analysis-phase-3a1.md`, `docs/phase-3-completion.md`, plus one
  milestone report per Phase 3 milestone (`docs/phase-3{a,b,c,d}*-completion.md`)
- one milestone report per Phase 4 milestone (`docs/phase-4*-completion.md`);
  Phase 4 itself is not complete, so there is no `docs/phase-4-completion.md`

## Required phase documentation (CLAUDE.md v1.3)

| Document | Location |
| --- | --- |
| Architecture diagram | `docs/architecture.md` — Phase 4B-2b adds the generation module, `renderPrompt`, and the capability descriptor to the component-status table. No boundary changed, so the runtime diagram is unchanged. |
| Entity-relationship diagram | `docs/er-diagram.md`. **Not applicable to Phase 4B-2b** — zero schema, migration, and Prisma diff. |
| Critical sequence diagram | `docs/sequence-upload-lifecycle.md`, `docs/sequence-analysis-lifecycle.md` |
| API change summary / OpenAPI | `docs/api-changes-phase-2.md`, `docs/api-changes-phase-3a1.md`, `docs/api-changes-phase-3a3.md`, `docs/api-changes-phase-3b2.md`, `docs/api-changes-phase-3c5.md`, `docs/api-changes-phase-3d4a.md` |
| Change log | `CHANGELOG.md` |
| Sequence diagram (Phase 4B-2b) | **Not applicable** — the milestone adds one pure function with no new interaction between components. The admission sequence is unchanged and already recorded for Phase 4B-1b. |
| API change summary (Phase 4B-2b) | **Not applicable** — no route, request, response, or DTO changed. `CompiledPrompt` and the rendered string are server-side generation data and are not exposed over HTTP. |
| Release notes | `docs/release-notes-phase-2.md`. **Not applicable to Phases 3 and 4** — no release is cut, because the product still cannot generate video. |
| Database migration notes | `docs/migration-notes.md` — Phase 4C-0a adds one additive nullable column (`requestRenderedPrompt`), no backfill and no index. **Not applicable to Phases 4B-2b and 4C-0b** — no migration in either. |
| Phase completion reports | `docs/phase-{0,1,2,3}-completion.md`, plus one report per Phase 3 and Phase 4 milestone — `docs/phase-3*-completion.md`, `docs/phase-4*-completion.md` (listed individually here they only go stale, so use `ls docs/phase-*-completion.md`) |

## Known deviation

PR #3 (Phase 2) was ~5,110 changed lines, well over the ~500-line guideline. It
was implemented under CLAUDE.md v1.2 before the milestone policy existed and was
accepted as a **one-time exception** by explicit reviewer decision. Phase 3 is
split into `Phase 3A` / `3B` / `3C` milestones — see
`docs/phase-3-milestone-plan.md`.

## Phase 3 milestones

Phase 3A was split because it exceeded the ~500-line PR guideline
(`docs/gap-analysis-phase-3a1.md`). Phase 3A-2 was split again — **before
implementation**, per the governance rule that splitting must precede coding —
because its planned 17 files / ≈916 lines did not fit the guideline
(`docs/phase-3a2a-completion.md`).

| Milestone | Content | Size | Status |
| --- | --- | --- | --- |
| 3A-1 | Analysis contracts + deterministic offline provider | 869 | **Merged** (PR #4, `a2bbf47`) |
| 3A-2a | `asset_analyses` persistence + live PostgreSQL CI + DB integration tests | 382 | **Merged** (PR #5, `8d1bed3`) |
| 3A-2b | `AnalysisService` + in-memory double + failure-consistency and retry-safety tests | 826 (estimated 509 — accepted as a one-time size exception) | **Merged** (PR #6, `4058086`) |
| 3A-2c | `refresh`, duplicate grouping, `suggestedOrder`, read APIs | 333 (estimated ~290) | **Merged** (PR #7, `e49ae6a`) |
| 3A-3 | Analysis HTTP endpoints | 571 (estimated ~445 — accepted as a one-time exception) | **Merged** (PR #8, `e3fcc74`) |
| 3B-1a | Review infrastructure: columns, partial unique index, `ReviewTransaction` | 489 (estimated ~312) | **Merged** (PR #9, `0a7818f`) |
| 3B-1b | Review domain logic: `approve` / `reject` | 982 — 388 production + 594 tests (698 at approval; accepted as a milestone exception) | **Merged** (PR #10, `2f2f3d7`) |
| 3B-2 | Review HTTP endpoints | 497 — 139 production + 358 tests (estimated 418) | **Merged** (PR #11, `50c2e4d`) |
| 3B-3a | Read-only review surface | 694 — 436 production + 258 tests (estimated ~455; accepted as a milestone exception) | **Merged** (PR #12, `c78ecf2`) |
| 3B-3b | Decision interactions + DOM test infrastructure | 516 — 287 production + 229 tests (re-cost 525) | **Merged** (PR #13, `6a5c848`) |
| 3C-1 | Storyboard persistence: `video_projects`, `storyboard_scenes`, repositories | 604 — 375 production + 229 tests (accepted as a milestone exception) | **Merged** (PR #14, `f7419bc`) |
| 3C-2a | Eligible-input selection + composition fingerprint | 354 — 107 production + 247 tests (estimated ~250) | **Merged** (PR #15, `7596699`) |
| 3C-2b | Deterministic ordering + duration allocation | 520 — 204 production + 316 tests (accepted as a small exception) | **Merged** (PR #16, `d7ede3a`) |
| 3C-3 | Prompt compilation + moderation port and offline default | 636 — 270 production + 366 tests (accepted as a milestone exception) | **Merged** (PR #17, `0b39eb1`) |
| 3C-4 | `StoryboardService`: compose + assertFresh | 603 — 208 production + 395 tests (accepted as an MVP exception) | **Merged** (PR #18, `003edaf`) |
| 3C-5a | Video-project creation path (service + HTTP) | 623 — 230 production + 393 tests (accepted as an MVP exception) | **Merged** (PR #19, `afb9fbe`) |
| 3C-5b | Storyboard compose + read + project list, `isFresh` | 732 — 252 production + 480 tests (re-cost ~711) | **Merged** (PR #20, `37df1b7`) |
| 3C-6a | Video-project discovery + creation UI | 845 — 423 production + 422 tests (approved ~430, re-cost ~620 — **reported before implementation**) | **Merged** (PR #21, `efff531`) |
| 3C-6b | Storyboard detail, composition, freshness, recompose | 1286 — 579 production + 707 tests (estimated ~780; **overran the ~800 threshold without a mid-implementation report**; includes a 126-line nested-route integrity fix found in review) | **Merged** (PR #22, `235783b`) |
| 3D-1 | Review-correction persistence: columns, migration, `effectiveRoomType`, refresh clearing | 426 — 121 production + 305 tests (re-cost ~351, approved ~460) | **Merged** (PR #23, `1ebe30a`) |
| 3D-2 | `AnalysisService.correct`: validation, lifecycle, authorization, provenance, audit | 708 — 189 production + 519 tests (re-cost ~558, approved ~481/~500; the 52-case mandated matrix, reported not trimmed) | **Merged** (PR #24, `3d59332`) |
| 3D-3 | Corrections reach composition: projection, ordering precedence, fingerprint payload | 413 — 92 production + 321 tests (approved range ~445–560) | **Merged** (PR #25, `1e51453`) |
| 3D-4a | Correction HTTP contract, additive DTO, nested-route integrity fix | 609 — 170 production + 439 tests (re-cost ~684) | **Merged** (PR #26, `cc0d3d5`) |
| 3D-4b | Review-page correction controls + unsaved/decision interlock | 1080 — 510 production + 570 tests (re-cost ~865; over, reported not trimmed; includes the optimistic-unlock fix found in review) | **Merged** (PR #27, `541ada4`) |

### Phase 3D — closing the Phase 3 review contract

Phase 3's roadmap scope includes **"editable room labels and image order"**, and
its completion criterion is *"users can review and correct all AI decisions
before generation."* Phases 3A–3C shipped approve and reject but no correction
path, so `phase-3-complete` was **not** created until Phase 3D shipped.
Milestones were strictly ordered — 3D-4 could not precede 3D-3, or a reviewer
could have recorded a correction that composition silently ignored.

| Milestone | Content | Status |
| --- | --- | --- |
| 3D-1 | Schema, migration, domain type, `effectiveRoomType`, refresh clearing | **Merged** (`1ebe30a`) |
| 3D-2 | `AnalysisService.correct`, lifecycle guards, authorization, audit | **Merged** (`3d59332`) |
| 3D-3 | `EligibleInput`, ordering precedence, fingerprint payload | **Merged** (`1e51453`) |
| 3D-4a | Correction HTTP contract + DTO + nested-route integrity | **Merged** (`cc0d3d5`) |
| 3D-4b | Review-page correction controls + interlock | **Merged** (`541ada4`) |

Phase 3 is closed. Every milestone is merged and verified on `main`, the full
completion gate was run against the merged tree, and `phase-3-complete` targets
the 3D-4b squash-merge commit. A milestone PR never receives a phase tag. See
`docs/phase-3-completion.md`.

## Phase 4 milestones

Phase 4 generates the first real scene through a video provider. Webhook support
is **deferred** — WaveSpeedAI documents polling as a supported task-completion
path, so bounded polling is the MVP completion mechanism, and no milestone is
reserved for a webhook.

| Milestone | Content | Size | Status |
| --- | --- | --- | --- |
| 4A-1 | Generation state model, active/terminal sets, request identity, ADR-0016 | 655 — 310 production + 345 tests (estimated 517; **overran, reported not trimmed**) + a 118/19 review fix allowing `PROCESSING → FAILED_RETRYABLE` | **Merged** (PR #28, `daa685b`) |
| 4A-2a | `scene_generations` table, migration, active-request partial unique index, SQL/domain agreement guard, live PostgreSQL evidence | 761 — 189 production + 572 tests (re-cost ~725 raw / ~800–900; **first estimate in six milestones that did not overrun**) | **Merged** (PR #29, `6e681c2`) |
| 4A-2b | Generation repository port, narrow update contract, Prisma adapter, typed not-found and conflict errors, P2002 translation, organization-addressed `create` | 789 + a 178/35 review fix for a `create`-path tenant-boundary defect | **Merged** (PR #30, `53cc574`) |
| 4B-1a | Capability contract + pure validation, narrow succeeded lookup, in-memory generation repository | 920 (two P2 fixes) | **Merged** (PR #31, `7d1cca8`) |
| 4B-1b | `GenerationService.startScene` single-scene admission, queue port, `generation.requested` audit, `StoryboardReader` port, recording queue double | ~360 prod / ~590 test / ~450 docs | **Merged** (PR #32, `c169bd6`) |
| 4B-1c | Immutable generation request snapshot: five persisted request-hash facts, `generationRequestFactsFrom`, additive migration (ADR-0018) | ~1,040 | **Merged** (PR #33, `e52d302`) |
| 4B-2a | Ownership-aware capability semantics, verified OpenVideo descriptor, adapter request-body correction, single model identity (ADR-0019) | 1,023 + two P1 review fixes | **Merged** (PR #34, `be92596`) |
| 4B-2b | The prompt renderer, the `PROMPT_RENDERED` pinning test, removal of unread provider input fields (ADR-0020) | 1,713 — 367 production + 465 tests + 881 docs | **Merged** (PR #35, `cd9d136`) |
| 4C-0b | Camera motion becomes a closed, server-enforced vocabulary (ADR-0022) | 1,304 — 356 production + 485 tests + 463 docs | **Merged** (PR #36, `35970da`) |
| 4C-0a | Execution prompt freeze: `requestRenderedPrompt` persisted at admission (ADR-0023) | 1,170 — 147 production + 492 tests + 531 docs | **Merged** (PR #37, `082a596`) |
| 4C-1a | Row-as-queue admission: `SceneGenerationQueue` removed, admission becomes create → audit (ADR-0024) | 787 — 146 production + 147 tests + 494 docs | PR #38 — see GitHub for lifecycle |
| 4C-1b | System-scoped execution repository: queued-candidate discovery + state-CAS submission claim | — | Not started |
| 4C-2…5 | Execution input assembly, submission, polling, worker runtime — fake provider first | — | Not started |
| 4D | WaveSpeedAI model integration, managed-storage output copy, real-provider contract verification once the commercial gate clears | — | Not started |
| 4E | Minimum HTTP/UI to start one scene generation and observe normalized status | — | Not started |

Phase 4A was split before implementation because a calibrated re-cost put it at
~950–1,150 lines, materially over the ~800 guideline. 4A-1 had to merge before
4A-2, because the database invariants depend on the reviewed state-machine
semantics. **Phase 4A-2 was then split again**, before implementation, when a
re-cost against merged main put the combined scope at ~1,050–1,250: 4A-2a is the
table and its invariants, 4A-2b the repository port and adapter. The split is by
layer rather than by concern because the active-request partial unique index must
ship in the *same migration* as the table — deferring it would leave the entity
persisted without its duplicate-charge protection.

**Commercial/provider gate.** Engineering against fake providers continues, but
production customer traffic through WaveSpeedAI, a paid production integration,
and any claim of commercial launch readiness are all blocked until the selected
model's commercial-use licence, WaveSpeedAI's terms for use as a backend to a
paid customer-facing SaaS, commercial delivery of generated output, and the
data-retention/privacy terms are verified and recorded — preferably by written
confirmation rather than inference from marketing copy.

## Forward planning

- `docs/phase-3-milestone-plan.md` — the approved Phase 3A/3B/3C milestone plan.
  Phase 3D was added later, after review found that the Roadmap scope item
  *"editable room labels and image order"* had no implementation.
- Phase 4 — WaveSpeedAI scene generation. 4A and 4B are delivering as milestone
  PRs (#28 … #34); 4C, 4D and 4E remain.

## Decision records

`docs/decisions/` — ADR-0001…0019, plus `docs/decisions/TODO.md` for open items.
ADR-0015 is the current authority on review corrections; ADR-0012 and ADR-0013
each carry a dated partial-supersession note rather than a rewrite. ADR-0016
covers scene-generation state, local idempotency, and ambiguous provider
submission; ADR-0017 covers single-scene generation admission, reuse precedence,
and the `create → enqueue → audit` side-effect ordering. ADR-0018 adds the
immutable generation request snapshot and narrowly amends both ADR-0016 §3 and
ADR-0017 §10 with dated notes rather than rewrites. ADR-0019 records provider
capability ownership, the verified OpenVideo contract, and why that model
receives no `aspect_ratio`, `negative_prompt`, or `camera_motion`; two of its
sections carry dated Phase 4B-2b amendments rather than rewrites. ADR-0020
records the prompt renderer's format, what flattening five structured parts into
one provider field costs, and what would reverse the choice; two of its sections
carry dated Phase 4C-0b amendments. ADR-0022 closes camera motion to a reviewed
vocabulary and records why moderation was rejected as the primary control.
ADR-0023 freezes the rendered execution prompt at admission and records why the
8-fact hash is deliberately left alone; it carries dated amendments into ADR-0018
and ADR-0020.

## Phase 4 status

- **Phase 4A** (4A-1, 4A-2a, 4A-2b) — merged. Generation state model, request
  identity, persistence, and the organization-addressed repository boundary.
- **Phase 4B-1a** — merged. Capability contract and the in-memory generation
  repository. No real provider values.
- **Phase 4B-1b** — merged as `c169bd6` (PR #32). `GenerationService.startScene`:
  single-scene admission, reuse precedence, race convergence,
  `create → enqueue → audit`.
- **Phase 4B-1c** — merged as `e52d302` (PR #33). Immutable generation request
  snapshot (ADR-0018), closing the reconstruction gap that PR #32's review
  surfaced. This unblocks Phase 4C.
- **Phase 4B-2a** — merged as `be92596` (PR #34). Honest provider contract:
  ownership-aware capability semantics, the verified OpenVideo descriptor,
  adapter mapping correction, model-identity unification (ADR-0019). Two P1
  blockers were found by independent pre-merge review and fixed before merge.
- **Phase 4B-2b** — merged as `cd9d136` (PR #35). The single prompt renderer
  (ADR-0020), taking the persisted snapshot as its boundary with parsing and
  fail-closed validation inside it. Three P1 blockers were found by independent
  pre-merge review and fixed before merge.
- **Phase 4C-0b** — merged as `35970da` (PR #36). Camera motion becomes a closed
  vocabulary enforced in the domain (ADR-0022), closing the first of Phase 4C's
  two hard prerequisites.
- **Phase 4C-0a** — merged as `082a596` (PR #37). The execution prompt freeze
  (ADR-0023): `requestRenderedPrompt` is rendered once at admission and submitted
  verbatim, closing the second and last prerequisite.
- **Phase 4C-1a** — PR #38; see GitHub for its lifecycle. The `SceneGeneration`
  row becomes the durable queue (ADR-0024): `SceneGenerationQueue` is removed
  rather than kept as a production no-op, and admission becomes create → audit.
  Work is discovered by `state = 'QUEUED'`, so ADR-0017 §13's mandatory
  stranded-row recovery is satisfied by the design rather than by an added
  sweep.
- **Phase 4C proper** — 4C-1b onward remains unstarted: the system-scoped
  execution repository, execution input assembly, submission, polling, and the
  worker runtime, fake provider first. Its prerequisites are recorded in
  `docs/decisions/TODO.md`.
