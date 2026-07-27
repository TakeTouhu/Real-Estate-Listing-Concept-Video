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
| 2 | Properties and secure media upload | 🔄 In review | #3 | — | pending merge | — |
| 3 | AI analysis and storyboard | ⏳ Not started | — | — | — | — |
| 4 | WaveSpeedAI scene generation | ⏳ Not started | — | — | — | — |
| 5 | Video composition and review | ⏳ Not started | — | — | — | — |
| 6 | Billing and commercial controls | ⏳ Not started | — | — | — | — |
| 7 | SaaS operations and production readiness | ⏳ Not started | — | — | — | — |
| 8 | Beta and launch | ⏳ Not started | — | — | — | — |

`phase-0-complete` and `phase-1-complete` are annotated tags created on `main`,
whose targets were verified to equal the corresponding squash-merge commits.

> ### ⚠️ The remote tags do not exist yet
>
> Both tags exist **only in the local clone**. Pushing tag refs fails in this
> development environment with `HTTP 403` (`error: RPC failed; HTTP 403`, then
> `send-pack: unexpected disconnect`), retried six times with backoff, and the
> available GitHub tooling exposes no create-ref/create-tag API — only
> `get_tag` / `list_tags`. `git ls-remote --tags origin` returns empty.
>
> This document does **not** claim the remote tags exist. A maintainer with
> direct push access must publish them:
>
> ```bash
> git push origin refs/tags/phase-0-complete refs/tags/phase-1-complete
> git ls-remote --tags origin   # verify
> ```

## Phase reports

- `docs/gap-analysis.md`, `docs/phase-0-completion.md`
- `docs/gap-analysis-phase-1.md`, `docs/phase-1-completion.md`
- `docs/gap-analysis-phase-2.md`, `docs/phase-2-completion.md`

## Required phase documentation (CLAUDE.md v1.3)

| Document | Location |
| --- | --- |
| Architecture diagram | `docs/architecture.md` |
| Entity-relationship diagram | `docs/er-diagram.md` |
| Critical sequence diagram | `docs/sequence-upload-lifecycle.md` |
| API change summary / OpenAPI | `docs/api-changes-phase-2.md` |
| Change log | `CHANGELOG.md` |
| Release notes | `docs/release-notes-phase-2.md` |
| Database migration notes | `docs/migration-notes.md` |
| Phase completion reports | `docs/phase-{0,1,2}-completion.md` |

## Known deviation

PR #3 (Phase 2) is ~3,620 changed lines, well over the ~500-line guideline. It
was implemented under CLAUDE.md v1.2 before the milestone policy existed and is
retained as the review candidate by reviewer instruction. Phase 3 will be split
into `Phase 3A` / `3B` / `3C`. See `docs/phase-2-completion.md`.

## Decision records

`docs/decisions/` — ADR-0001…0008, plus `docs/decisions/TODO.md` for open items.
