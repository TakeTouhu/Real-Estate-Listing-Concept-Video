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
> All three tags exist **only in the local clone**. Publication remains blocked
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
>                refs/tags/phase-3a2a-complete
> git ls-remote --tags origin   # verify all five appear
> ```
>
> Local tag records (target verified against the merge commit in each case):
>
> | Tag | Tag object | Target commit |
> | --- | --- | --- |
> | `phase-3a1-complete` | `af4154f8192ccdcdf96d88c99aeb6119cc7189f5` | `a2bbf473512c8f0c0df4121b1111e66b08699dd7` |
> | `phase-3a2a-complete` | `00e9f10910a3bf2f255a45a67cce133b7b857af7` | `8d1bed31e4d3744865d1a09a1fc08feb3da3e16f` |

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
| API change summary / OpenAPI | `docs/api-changes-phase-2.md`, `docs/api-changes-phase-3a1.md` |
| Change log | `CHANGELOG.md` |
| Release notes | `docs/release-notes-phase-2.md` |
| Database migration notes | `docs/migration-notes.md` |
| Phase completion reports | `docs/phase-{0,1,2}-completion.md`, `docs/phase-3a1-completion.md`, `docs/phase-3a2a-completion.md`, `docs/phase-3a2b-completion.md` |

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
| 3A-2b | `AnalysisService` + in-memory double + transaction/retry-safety tests | 826 (estimated 509 — over target, disclosed) | In review |
| 3A-2c | `refresh`, duplicate grouping, `suggestedOrder`, read APIs | ~250 (estimate) | Not started |
| 3A-3 | Analysis HTTP endpoints | ~350 (estimate) | Not started |
| 3B | Analysis review UI | ~450–500 | Not started |
| 3C | Storyboard + prompt compilation | ~500 | Not started |

`phase-3-complete` is created only after every Phase 3 milestone is merged and
verified. A milestone PR never receives a phase tag.

## Forward planning

- `docs/phase-3-milestone-plan.md` — approved Phase 3A/3B/3C milestone plan.

## Decision records

`docs/decisions/` — ADR-0001…0009, plus `docs/decisions/TODO.md` for open items.
