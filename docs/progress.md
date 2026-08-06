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
| 3 | AI analysis and storyboard | 🔄 In progress (3A-1 in review) | 3A-1: #4 | — | — | — |
| 4 | WaveSpeedAI scene generation | ⏳ Not started | — | — | — | — |
| 5 | Video composition and review | ⏳ Not started | — | — | — | — |
| 6 | Billing and commercial controls | ⏳ Not started | — | — | — | — |
| 7 | SaaS operations and production readiness | ⏳ Not started | — | — | — | — |
| 8 | Beta and launch | ⏳ Not started | — | — | — | — |

All three tags are **annotated** tags created on `main` (never on a feature
branch), and each target was verified to equal the corresponding squash-merge
commit. None has been moved, overwritten, or reused.

| Tag | Tag object SHA | Target commit | Target verified |
| --- | --- | --- | --- |
| `phase-0-complete` | `76d36045934a97bc4a997a64dcd1e932cfe837de` | `5185fea6fdf5458b72a316ec94fcd0fe9cc54443` | ✅ |
| `phase-1-complete` | `7d8bc81b460568becc82bc49cfc15b345d23d5a6` | `62259776f88fa1010736e8a365618b7c20c38902` | ✅ |
| `phase-2-complete` | `b13e5490f2014dc43a3815c3570795c955a2089a` | `653372a54d72d8dacc38fb7103ad32f15041cc2f` | ✅ |

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

## Required phase documentation (CLAUDE.md v1.3)

| Document | Location |
| --- | --- |
| Architecture diagram | `docs/architecture.md` |
| Entity-relationship diagram | `docs/er-diagram.md` |
| Critical sequence diagram | `docs/sequence-upload-lifecycle.md`, `docs/sequence-analysis-lifecycle.md` |
| API change summary / OpenAPI | `docs/api-changes-phase-2.md`, `docs/api-changes-phase-3a1.md`, `docs/api-changes-phase-3a3.md`, `docs/api-changes-phase-3b2.md` |
| Change log | `CHANGELOG.md` |
| Release notes | `docs/release-notes-phase-2.md` |
| Database migration notes | `docs/migration-notes.md` |
| Phase completion reports | `docs/phase-{0,1,2}-completion.md`, `docs/phase-3a1-completion.md`, `docs/phase-3a2a-completion.md`, `docs/phase-3a2b-completion.md`, `docs/phase-3a2c-completion.md`, `docs/phase-3a3-completion.md`, `docs/phase-3b1a-completion.md`, `docs/phase-3b1b-completion.md`, `docs/phase-3b2-completion.md` |

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
| 3D-3 | Corrections reach composition: projection, ordering precedence, fingerprint payload | 413 — 92 production + 321 tests (approved range ~445–560) | In review |

### Phase 3D — closing the Phase 3 review contract

Phase 3's roadmap scope includes **"editable room labels and image order"**, and
its completion criterion is *"users can review and correct all AI decisions
before generation."* Phases 3A–3C shipped approve and reject but no correction
path, so `phase-3-complete` is **not** created until Phase 3D ships. Milestones
are strictly ordered — 3D-4 must not precede 3D-3, or a reviewer could record a
correction that composition silently ignores.

| Milestone | Content | Status |
| --- | --- | --- |
| 3D-1 | Schema, migration, domain type, `effectiveRoomType`, refresh clearing | **Merged** (`1ebe30a`) |
| 3D-2 | `AnalysisService.correct`, lifecycle guards, authorization, audit | **Merged** (`3d59332`) |
| 3D-3 | `EligibleInput`, ordering precedence, fingerprint payload | In review |
| 3D-4 | HTTP endpoint, DTO exposure, review-UI correction controls | Not started |

| 3B | Analysis review UI | ~450–500 | Not started |
| 3C | Storyboard + prompt compilation | ~500 | Not started |

`phase-3-complete` is created only after every Phase 3 milestone is merged and
verified. A milestone PR never receives a phase tag.

## Forward planning

- `docs/phase-3-milestone-plan.md` — approved Phase 3A/3B/3C milestone plan.

## Decision records

`docs/decisions/` — ADR-0001…0014, plus `docs/decisions/TODO.md` for open items.
