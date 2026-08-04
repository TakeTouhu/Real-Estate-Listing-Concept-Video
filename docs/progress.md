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

> ### ⚠️ The remote tags do not exist
>
> All eighteen tags exist **only in the local clone**. Publication remains blocked
> in this development environment. `git ls-remote --tags origin` returns empty.
>
> Attempted 2026-07-27 with three different invocations — explicit refspecs,
> `--tags`, and a single tag — each failing identically:
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
> This document does **not** claim the remote tags exist. A maintainer with
> direct push access must publish them:
>
> ```bash
> git push origin refs/tags/phase-0-complete \
>                refs/tags/phase-1-complete \
>                refs/tags/phase-2-complete \
>                refs/tags/phase-3a1-complete \
>                refs/tags/phase-3a2a-complete \
>                refs/tags/phase-3a2b-complete \
>                refs/tags/phase-3a2c-complete \
>                refs/tags/phase-3a3-complete \
>                refs/tags/phase-3b1a-complete \
>                refs/tags/phase-3b1b-complete \
>                refs/tags/phase-3b2-complete \
>                refs/tags/phase-3b3-complete \
>                refs/tags/phase-3c1-complete \
>                refs/tags/phase-3c2a-complete \
>                refs/tags/phase-3c2b-complete \
>                refs/tags/phase-3c3-complete \
>                refs/tags/phase-3c4-complete \
>                refs/tags/phase-3c5a-complete
> git ls-remote --tags origin   # verify all eighteen appear
> ```
>
> Local tag records (target verified against the merge commit in each case):
>
> | Tag | Tag object | Target commit |
> | --- | --- | --- |
> | `phase-3a1-complete` | `af4154f8192ccdcdf96d88c99aeb6119cc7189f5` | `a2bbf473512c8f0c0df4121b1111e66b08699dd7` |
> | `phase-3a2a-complete` | `00e9f10910a3bf2f255a45a67cce133b7b857af7` | `8d1bed31e4d3744865d1a09a1fc08feb3da3e16f` |
> | `phase-3a2b-complete` | `546823e04b7dded1ed62644d424080689bab46f9` | `40580866469b3d891f719cb9d83f17bf8b692081` |
> | `phase-3a2c-complete` | `34d0a211e2d65bcfd0edf7bf83aad1e46093793d` | `e49ae6aa3466fdeaf8d616084c7163a15f9466f5` |
> | `phase-3a3-complete` | `4c85d6d4bc67aa2f0e4485e0348f1cf3a5779457` | `e3fcc7410052ded01e936f75b00dbec239ac2e3e` |
> | `phase-3b1a-complete` | `5537f3f41f7fe3cacb0fb5e2b57319b90a3f2af6` | `0a7818f10371bcf8072b6b8cc2f501c9b5868f97` |
> | `phase-3b1b-complete` | `8a45e866d8a1a753ffb928eed24354e1c1a82d89` | `2f2f3d76d54bc0a6a0d9e8a0f60c3713d3a8cc05` |
> | `phase-3b2-complete` | `8bfd7ceb4cae81f636ced97e7da3a3639760fd03` | `50c2e4df49e921df4430b2becd0741642e625bee` |
> | `phase-3b3-complete` | `ff3f866ccda7b550490b1bb26e5780f9002540b2` | `6a5c8484e225f89147b168f54b7d62edfd072dc2` |
> | `phase-3c1-complete` | `00b1ae3b45036707f09ba59da9687a7173d8f94b` | `f7419bcbaf1b96408fd4e5d5700eb6a539594eac` |
> | `phase-3c2a-complete` | `4b21324ea555c5dff427512e991b82f66e2e329e` | `75966994eafa9f6ec58c2243e34f66f89296f3d9` |
> | `phase-3c2b-complete` | `f5f5555e21070ab1401107932ffc2bacba562957` | `d7ede3a3ecd2d4ae0bf13c9ea0d19149f06ca2b9` |
> | `phase-3c3-complete` | `0e471b3c241de745b454954bd0646516770e7af7` | `0b39eb1f4eb98e4d8b4e7e8841c05c1cb31ac1c3` |
> | `phase-3c4-complete` | `77d9285b175f95bb97828aa99a93642b84189c57` | `003edaf97dbcc651e7ba66affbc06ac523e1fe8d` |
> | `phase-3c5a-complete` | `04927d6cd64fcc103d5eb1b7a6e495c0c3d96ca1` | `afb9fbeb373b8b14cef989bc4a4210de753652b9` |

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
| 3C-6a | Video-project discovery + creation UI | 845 — 423 production + 422 tests (approved ~430, re-cost ~620 — **reported before implementation**) | In review |

| 3B | Analysis review UI | ~450–500 | Not started |
| 3C | Storyboard + prompt compilation | ~500 | Not started |

`phase-3-complete` is created only after every Phase 3 milestone is merged and
verified. A milestone PR never receives a phase tag.

## Forward planning

- `docs/phase-3-milestone-plan.md` — approved Phase 3A/3B/3C milestone plan.

## Decision records

`docs/decisions/` — ADR-0001…0014, plus `docs/decisions/TODO.md` for open items.
