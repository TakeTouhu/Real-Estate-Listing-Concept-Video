# Delivery Progress

Tracks phase status, merge commits, and release tags. `docs/Roadmap.md` remains
the authoritative scope definition; this file records what has actually shipped.

## Release-tag policy

- Every completed and merged phase receives an **annotated** Git tag named
  `phase-<n>-complete`.
- A phase tag is created only after: the phase PR is reviewed, CI succeeds, the
  PR is merged into `main`, and the merged commit is pulled and verified.
- Tags are **never** moved, overwritten, or reused, and are never created on a
  feature branch — always on the merged commit on `main`.
- Each phase completion report records the tag name, tag SHA, target commit SHA,
  and the verification result.

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

Both `phase-0-complete` and `phase-1-complete` are annotated tags whose targets
were verified to equal the corresponding squash-merge commits on `main`.

> **Note on tag publication.** The tags exist locally and are verified against
> the merged commits. Pushing them to the remote is currently blocked in the
> development environment: the git proxy rejects tag refs with `HTTP 403`, and no
> tag-creation API is available through the configured GitHub tooling. A
> maintainer with direct push access can publish them with:
>
> ```bash
> git push origin phase-0-complete phase-1-complete
> ```

## Phase reports

- `docs/gap-analysis.md`, `docs/phase-0-completion.md`
- `docs/gap-analysis-phase-1.md`, `docs/phase-1-completion.md`
- `docs/gap-analysis-phase-2.md`, `docs/phase-2-completion.md`

## Decision records

`docs/decisions/` — ADR-0001…0008, plus `docs/decisions/TODO.md` for open items.
