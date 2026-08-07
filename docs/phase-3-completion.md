# Phase 3 Completion Report — AI analysis and storyboard

Phase: 3 — AI analysis and storyboard
Final merge commit: `541ada413a6c7b71df5169faca0592626c9be454` (PR #27, Phase 3D-4b)
Milestone PRs: #4 … #27 (24 milestones across 3A, 3B, 3C, 3D)
Verified on: merged `main`, 2026-08-07

This report closes Phase 3. It is written from the merged tree, not from the
milestone reports: every claim below was re-verified on
`541ada413a6c7b71df5169faca0592626c9be454`.

## Roadmap scope and completion criterion

`docs/Roadmap.md` defines Phase 3 as:

| Scope item | Where it landed |
| --- | --- |
| room classification adapter | 3A-1 — `ImageAnalysisProvider` + deterministic offline provider |
| quality, duplicate, privacy, and safety analysis | 3A-1, 3A-2b, 3A-2c |
| **editable room labels and image order** | **3D-1 … 3D-4b** |
| storyboard generation | 3C-1 … 3C-6b |
| prompt compilation and moderation | 3C-3 |

Completion criterion: *users can review and correct all AI decisions before
generation.*

Phases 3A–3C shipped review — approve and reject — but no correction path, so
the criterion was **not** met at the end of 3C. Phase 3D was added specifically
to close it, and only with 3D-4b merged does a reviewer both *review* and
*correct*. That is why `phase-3-complete` is created on the 3D-4b merge commit
and not earlier.

## Milestone record

Every milestone is a squash merge on `main`. Commits are the squash-merge
commits themselves.

### Phase 3A — analysis domain and HTTP surface

| Milestone | PR | Squash-merge commit | Purpose |
| --- | --- | --- | --- |
| 3A-1 | #4 | `a2bbf473512c8f0c0df4121b1111e66b08699dd7` | Image-analysis contracts (`ImageAnalysisProvider`, room vocabulary, findings) and a deterministic offline provider, so analysis has a port before it has an implementation. |
| 3A-2a | #5 | `8d1bed31e4d3744865d1a09a1fc08feb3da3e16f` | `asset_analyses` persistence, the Prisma repository, and the live-PostgreSQL CI job that all later database evidence depends on. |
| 3A-2b | #6 | `40580866469b3d891f719cb9d83f17bf8b692081` | `AnalysisService` orchestration: failure-consistent, retry-safe analysis of one asset. |
| 3A-2c | #7 | `e49ae6aa3466fdeaf8d616084c7163a15f9466f5` | `refresh`, perceptual-hash duplicate grouping, `suggestedOrder`, and the organization-scoped read methods. |
| 3A-3 | #8 | `e3fcc7410052ded01e936f75b00dbec239ac2e3e` | Analysis HTTP endpoints as thin adapters — no business rule restated in a route handler. |

### Phase 3B — human review

| Milestone | PR | Squash-merge commit | Purpose |
| --- | --- | --- | --- |
| 3B-1a | #9 | `0a7818f10371bcf8072b6b8cc2f501c9b5868f97` | Review infrastructure: review columns, the partial unique index enforcing one approved member per duplicate group, and `ReviewTransaction`. |
| 3B-1b | #10 | `2f2f3d76d54bc0a6a0d9e8a0f60c3713d3a8cc05` | Review domain logic — `approve` / `reject`, immutable per revision, blocking findings barring approval. |
| 3B-2 | #11 | `50c2e4df49e921df4430b2becd0741642e625bee` | Review HTTP endpoints. |
| 3B-3a | #12 | `c78ecf2588748099012fce6c6a391cd68dc1eaf6` | Read-only review surface: three buckets, duplicate clusters, decisions as immutable records, `video:review` presented as well as enforced. |
| 3B-3b | #13 | `6a5c8484e225f89147b168f54b7d62edfd072dc2` | Decision interactions — separate Approve and Reject controls, per-row pending/error state, and the DOM test infrastructure. |

### Phase 3C — storyboard and prompt compilation

| Milestone | PR | Squash-merge commit | Purpose |
| --- | --- | --- | --- |
| 3C-1 | #14 | `f7419bcbaf1b96408fd4e5d5700eb6a539594eac` | Storyboard persistence: `video_projects`, `storyboard_scenes`, repositories. |
| 3C-2a | #15 | `75966994eafa9f6ec58c2243e34f66f89296f3d9` | Eligible-input selection (only APPROVED analyses) and the composition fingerprint. |
| 3C-2b | #16 | `d7ede3a3ecd2d4ae0bf13c9ea0d19149f06ca2b9` | Deterministic scene ordering and duration allocation. |
| 3C-3 | #17 | `0b39eb1f4eb98e4d8b4e7e8841c05c1cb31ac1c3` | Structured `CompiledPrompt` compilation and the prompt-moderation port with an offline default (ADR-0014). |
| 3C-4 | #18 | `003edaf97dbcc651e7ba66affbc06ac523e1fe8d` | `StoryboardService`: `compose` and the `assertFresh` gate. |
| 3C-5a | #19 | `afb9fbeb373b8b14cef989bc4a4210de753652b9` | Video-project creation path, service and HTTP. |
| 3C-5b | #20 | `37df1b77418012907011d69bed9508aded1252ca` | Storyboard compose, read, project list, and `isFresh` recomputed at read time. |
| 3C-6a | #21 | `efff53195cbb7314ce457b13a9bac0b91d323ab1` | Video-project discovery and creation UI. |
| 3C-6b | #22 | `235783b329dba160df7b6edbb7ea63310fa4481a` | Storyboard detail page: read-only settings, freshness banner, composition, recompose, scene list. Includes the nested-route integrity fix found in review. |

### Phase 3D — editable room labels and image order

| Milestone | PR | Squash-merge commit | Purpose |
| --- | --- | --- | --- |
| 3D-1 | #23 | `1ebe30ada17ee8d2f208d159d823a2d390d9293d` | Correction persistence: four additive columns, `effectiveRoomType` / `isCorrected` as the single resolution point, refresh clearing corrections with the revision. |
| 3D-2 | #24 | `3d5933239959981130d173c82210ecf93d9405f2` | `AnalysisService.correct` — validation, lifecycle guard, authorization, provenance, no-op semantics, and the `analysis.corrected` audit event. |
| 3D-3 | #25 | `1e51453bc94b7ddb309a6f289fb670100936a26c` | Corrections reach composition: effective room in `EligibleInput`, `orderOverride` as a global sort priority, and both in the fingerprint payload. |
| 3D-4a | #26 | `cc0d3d525a1647634699d5497a025dbcddb1d4c7` | Correction HTTP contract, additive `AnalysisDto` fields, and the nested property/asset integrity guard applied to all six analysis handlers. |
| 3D-4b | #27 | `541ada413a6c7b71df5169faca0592626c9be454` | Review-page correction controls and the unsaved-correction / decision interlock. |

Per-milestone size, estimate accuracy, and disclosed deviations are recorded in
`docs/progress.md` and in each `docs/phase-3*-completion.md`.

## Completion evidence

Gathered on merged `main` at `541ada4`. Where a section is proved by tests, the
test files are named; where it needed a runtime walk, that is said explicitly.

### A. Human-review path

Covered by `tests/api/review-routes.test.ts`,
`apps/web/src/app/properties/[propertyId]/review/*.test.tsx`,
`packages/domain/src/analysis/*.test.ts`, and a temporary real-PostgreSQL
runtime walk (below).

| Step | Evidence |
| --- | --- |
| 1. analysis exists for listing photos | `AnalysisService.analyzeAsset`; `tests/integration/analysis-repository.db.test.ts` |
| 2. reviewer sees analyzer classification | `ReviewItem.correction.analyzerRoomType`, rendered separately from the effective room |
| 3. reviewer changes room override | correction endpoint + `CorrectionPanel` |
| 4. reviewer saves correction | explicit **Save correction**, its own request |
| 5. reviewer sets order priority | `order` field, whole number above zero |
| 6. reviewer can clear room override | `roomType: null` via the **Use analyzer result** option |
| 7. reviewer can clear order priority | `order: null` |
| 8. unsaved corrections cannot be approved/rejected | `review-item-controls.test.tsx` interlock cases |
| 9. correction and decision remain separate | separate endpoints, separate audit actions, separate buttons |
| 10. approval under immutable-per-revision lifecycle | `analysis-review.test.ts`, `review-routes.test.ts` |
| 11. rejection where appropriate | same |
| 12. CREATOR cannot correct or review | `video:review` excludes CREATOR; asserted at domain, HTTP, and presentation layers |

A temporary runtime smoke over **real PostgreSQL** walked correction → approve →
compose → stale through the Prisma-backed services (19 checks, all passing). It
was run out of tree and deleted; it is evidence, not test infrastructure, and the
repository is unchanged by it.

### B. Original AI output preservation

`analysis.roomType` and `analysis.suggestedOrder` are never written by
`correct()`. The overrides live in separate columns, and the effective value is
derived by `effectiveRoomType(analysis)` — `roomTypeOverride ?? roomType` — at
the single resolution point in `packages/domain/src/analysis/effective.ts`.
Verified in `effective.test.ts`, in
`tests/integration/analysis-repository.db.test.ts` ("preserves corrections
through an unrelated update"), and in the runtime walk, where a photo the
analyzer read as `BATHROOM` still read `BATHROOM` after being corrected to
`LIVING_ROOM`.

### C. Storyboard correction integration

- `selectEligibleAnalyses` projects `roomType: effectiveRoomType(a)` — the only
  correction seam into composition.
- `orderOverride` travels on `EligibleInput`.
- The corrected room reaches the scene; the order priority reaches the ordering.
- Uncorrected inputs keep their previous ordering behaviour, because
  `primaryKey` falls back to `rankOf(roomType)`.
- `StoryboardService` contains **zero** correction-specific symbols: it neither
  reads nor writes `roomTypeOverride`, `orderOverride`, `correctedBy`, or
  `correctedAt`. Corrections reach it only through the projection.

### D. Freshness and fingerprint

The digest payload is, per asset in canonical `assetId` order:

```text
[ assetId, analysisRevision, effectiveRoomType, orderOverride ]
```

Confirmed: a corrected room changes the digest; an order priority changes the
digest; canonical ordering is stable regardless of input order. Storyboards
composed before 3D-3 become stale the next time freshness is evaluated — there
is **no** status rewrite and no migration touching stored storyboards; the
persisted status is simply no longer the authority. A stale storyboard cannot
pass `assertFresh`, which is the gate Phase 4 generation will sit behind.

### E. Review-correction audit

Unchanged from 3D-2, and unchanged during closure. One `analysis.corrected`
event for a real change; **no** event for a stored-value no-op; actor and
organization preserved; effective room before/after and order before/after
recorded; no storage key, provider payload, or moderator internal in the
metadata.

### F. Tenant and nested-resource safety

`requireAssetInProperty` is applied on all six handlers under
`/api/properties/[propertyId]/assets/[assetId]/analysis`:

| Handler | File | Call site |
| --- | --- | --- |
| analyze | `analysis/route.ts` | `POST`, line 27 |
| analysis read | `analysis/route.ts` | `GET`, line 50 |
| approve | `analysis/approve/route.ts` | line 29 |
| reject | `analysis/reject/route.ts` | line 28 |
| refresh | `analysis/refresh/route.ts` | line 28 |
| correction | `analysis/correction/route.ts` | line 56 |

A same-organization asset filed under a different property is
**indistinguishable** from one that does not exist — same code, same message,
and neither the other property nor the other asset appears anywhere in the
error. Authorization refusals and repository failures are propagated rather than
flattened into `NOT_FOUND`, so a broken system is never presented as a missing
page. Cross-tenant isolation is asserted independently in
`tests/api/analysis-routes.test.ts` and `tests/api/review-routes.test.ts`.

### G. Storyboard product path

Walked through the **real route handlers** — project creation, project list,
correction, approve, compose, storyboard read — over one shared set of
repositories, as a temporary out-of-tree run:

| Step | Result |
| --- | --- |
| project can be created | `201`, status `DRAFT`, no scenes |
| project can be selected | present in the property's project list |
| corrected values feed composition | the scene for the corrected photo carries `LIVING_ROOM`, not the analyzer's `KITCHEN`; the analyzer's own value is unchanged underneath |
| order priority feeds composition | the photo given priority 1 leads the storyboard, ahead of its room rank |
| storyboard can be composed | `200`, three ordered scenes |
| storyboard scenes can be read | positions `[1, 2, 3]`, safe DTO fields only |
| freshness is visible | `fresh: true` immediately after composing |
| stale storyboard is visibly stale | approving a fourth photo makes the read report `fresh: false` while the persisted status still reads `STORYBOARD_READY` — the banner follows freshness, not status |
| recompose restores freshness | `fresh: true` again, now four scenes |
| an unrelated correction does not disturb freshness | correcting a photo that is not in the storyboard leaves `fresh: true` |

No provider call was involved, as expected for Phase 3. Both cases passed; the
file was deleted and the working tree is unchanged.

### H. Required checks on merged main

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors across all 10 workspace packages |
| `pnpm lint` | clean, no warnings |
| `pnpm test` | **737 passed / 737**, 45 files |
| `pnpm build` | clean production build from a removed `.next` |
| `pnpm test:db` | **27 passed / 27**, 4 files, live PostgreSQL |
| migrations from an empty database | all 6 applied in order on a dropped-and-recreated database |
| Prisma drift check | `No difference detected.` (exit 0) |

The first `pnpm test:db` invocation failed with
`Environment variable not found: DATABASE_URL`. That is a **local environment**
condition, not a code defect and not a database outage —
`pg_isready` reported the cluster online and `pg_lsclusters` showed
`16/main` running. The variable was supplied for the run; no repository file was
modified, and the rerun passed 27/27. Recorded here because closure evidence
must show what actually happened.

No code was altered to produce any result in this table.

## Client-bundle boundary

Scanned after a clean production build. Absent from every client chunk:
`ROOM_TYPES`, `humanizeRoomType`, `isRoomType`, `effectiveRoomType`,
`isCorrected`, `AnalysisService`, `StoryboardService`, `CorrectionField`,
`@app/domain`, `@app/database`, `PrismaClient`, `authorizeOrganization`,
`node:crypto`, `node:fs`, `node:util`. The positive control — the literal
`Use analyzer result` from `CorrectionPanel` — is present in
`static/chunks/app/properties/[propertyId]/review/page-*.js`, so the scan was
looking at real client output.

## Required phase documentation (CLAUDE.md v1.3)

| Document | Status for Phase 3 |
| --- | --- |
| Architecture diagram | `docs/architecture.md` — **corrected at closure.** Its component table still listed `AnalysisService`, `AssetAnalysis` persistence, and the review UI as *not implemented* after all three had shipped, and had no entry for corrections or the moderation port. Presenting shipped behaviour as missing is the same documentation defect as the reverse, so the table was brought in line with the merged tree. |
| Entity-relationship diagram | `docs/er-diagram.md` — updated at 3A-2a, 3B-1a, 3C-1, and 3D-1; carries the correction columns. Unchanged at closure: the schema did not change. |
| Critical sequence diagram | `docs/sequence-analysis-lifecycle.md` — **extended at closure.** It covered analysis and the review decision but had **no correction sequence at all**, and its by-milestone table stopped at 3B-2 with 3B-3/3C listed as pending. A correction sequence (3D-2 domain, 3D-4 HTTP and UI, including the interlock and the no-op branch) was added and the table brought up to 3D-4b. |
| OpenAPI / API change summary | `docs/api-changes-phase-3a1.md`, `-3a3.md`, `-3b2.md`, `-3c5.md`, `-3d4a.md`. Unchanged at closure: 3D-4b added no endpoint, field, or status code — it is presentation only. |
| Change log | `CHANGELOG.md` |
| Release notes | **Not applicable** — no release is cut at Phase 3. The product cannot yet generate video, so there is nothing to release to a customer. Release notes resume when Phase 4 makes generation real. |
| Database migration notes | `docs/migration-notes.md` — migrations `…0002`, `…0003`, `…0004`, `…0005`, each with its milestone. Unchanged at closure: no migration was added after 3D-1. |
| Phase completion report | this document, plus 24 milestone reports |

The two documents corrected at closure were **stale, not merely incomplete** —
they described a product that no longer existed. Everything else was left alone,
because its contents did not change.

## Release tag status

| Tag | Object type | Tag object SHA | Target commit |
| --- | --- | --- | --- |
| `phase-3d4b-complete` | `tag` (annotated) | `db18f16dda4db2ee033243c005ca783a52b3c1ed` | `541ada413a6c7b71df5169faca0592626c9be454` |
| `phase-3-complete` | `tag` (annotated) | `bbc711d2e7aa8275e17f301f0eec24f51f8f0512` | `541ada413a6c7b71df5169faca0592626c9be454` |

Both are annotated tags created on `main` after the merge was pulled and
verified, targeting the exact Phase 3D-4b squash-merge commit. Neither has been
moved, overwritten, or reused.

### Tag publication is still blocked — the remote tags do NOT exist

Publication was attempted once per tag, normally, with no workaround:

```text
error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403
send-pack: unexpected disconnect while reading sideband packet
fatal: the remote end hung up unexpectedly
```

`git ls-remote --tags origin` returns **no tags at all**. Branch pushes to the
same remote succeed, so the proxy rejects tag refs specifically, and the
available GitHub tooling exposes no create-ref/create-tag API — only `get_tag`
and `list_tags`.

**This report does not claim any remote tag exists.** A maintainer with
tag-push permission publishes them with:

```bash
git push origin refs/tags/phase-3d4b-complete refs/tags/phase-3-complete
git ls-remote --tags origin   # verify
```

## Known limitations carried out of Phase 3

These are recorded, not hidden. None blocks the Phase 3 completion criterion;
each is scoped to a later phase or to `docs/decisions/TODO.md`.

- **No generation.** A storyboard is a plan. Phase 4 makes the first real scene.
- **Video projects cannot be renamed, edited, or deleted** through the product.
  Recorded for commercial-launch readiness in `docs/decisions/TODO.md`.
- **Aspect ratio and resolution are free text.** The configured provider's real
  supported formats are Phase 4's to establish; nothing today claims a provider
  accepts a given string.
- **A no-op correction leaves the decision interlock engaged.** Approved
  deliberately: inventing client-side domain equality to auto-unlock would put a
  business rule in the browser. **Discard changes** is the escape.
- **`LocalObjectStorage` is still in-process.** A durable S3/Azure adapter
  remains a production blocker, unchanged since Phase 2.
- **Image processing still runs inline** in the upload-completion request rather
  than on the worker.
- **`suggestedOrder` is inert in ordering.** It equals the room rank it is
  compared against, so it never breaks a tie in practice. It is preserved as
  analyzer output and kept in the comparator for stability; it is not a decision
  input. Documented rather than removed.

## Next phase

Phase 4 — WaveSpeedAI scene generation. The plan is prepared separately and is
not started here.
