# Phase 4C-2A — Immutable execution preflight

Milestone: Phase 4C-2A
Base: `27ba4df1159da1ef69693d3dcebe975b14e7e96f` (merged Phase 4C-1b, PR #39)
Decision record: ADR-0026

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source.

## What shipped

```ts
prepareQueuedGeneration(
  deps: ExecutionPreflightDeps,
  candidate: SystemGenerationCandidate,
): Promise<PreparedGeneration>
```

**ADR-0026 carries the reasoning in full.** This report records what was built
and how it was checked.

- **Changes nothing, structurally.** The row is still `QUEUED` on return.
  `ExecutionPreflightDeps` declares no generation repository, and each remaining
  dependency is narrowed with `Pick` to what preparation uses — `assets` to
  `findById`, `storage` to `exists` and `createSignedDownloadUrl`. Nothing in
  scope can move the row, mutate the asset, or write to storage; no upload
  credential is reachable.
- **Domain-owned artifact.** `PreparedGeneration` is not `ProviderGenerationInput`;
  importing that would invert the `@app/video-providers → @app/domain` dependency.
  `packages/domain/package.json` still depends only on `@app/shared`.
- **Snapshot-only sourcing.** Prompt and the four request settings come from the
  frozen row. The stored `requestHash` is re-computed and compared rather than
  trusted.
- **Tenancy proven, not asserted.** The ordinary scoped `MediaAssetRepository` is
  addressed with the `organizationId` ADR-0025 resolved through `VideoProject`.
  No system-scoped asset port was added.
- **Classified refusals.** Ten reasons in a closed set, each `INTERNAL_ERROR`,
  each carrying `retryable` — which marks what a *future explicit policy* may do,
  never an automatic re-queue.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | **1198 passed**, 60 files (baseline 1160 / 59) |
| `pnpm build` | exit 0 |
| `pnpm test:db` | **153 passed**, 7 files (unchanged — no persistence in this milestone) |
| `prisma migrate diff --from-migrations` | `No difference detected.` exit 0 |

### Where each property is proven

All 38 new tests are unit tests against the existing
`InMemoryMediaAssetRepository` and a local storage fake. **No new shared double
was added** — the fake lives in the test file that needs it, following
`property.test.ts`, and nothing consumes the preflight function in production
yet.

| Property | Proven by |
| --- | --- |
| Every artifact field comes from the frozen snapshot | Snapshot set to `9:16`/`720p`/3s while the asset is 4:3 and the model advertises only `16:9`/`1080p` — the snapshot wins |
| The prompt is never re-rendered | Frozen text a current renderer would not produce is returned verbatim |
| Preparation mutates nothing | Whole-row comparison of the generation before/after |
| Stored hash is verified | A row whose hash disagrees with its facts is refused |
| Provider/model contract still in force | Refused when either differs from the configured capability |
| All 10 refusal reasons | One test each; `retryable` is asserted to partition the whole vocabulary |
| Every `MediaAssetStatus` is classified | The single production `Record<MediaAssetStatus, …>` — a new status fails to compile until classified; all ten are also covered behaviourally |
| Tenant isolation | An asset in another organization yields `ASSET_NOT_FOUND`, and **nothing is signed** |
| Secret safety | Storage key, signed URL and prompt appear in no refusal message |
| Preflight cannot claim or submit | Type-level assertion on `ExecutionPreflightDeps` |
| Preflight cannot mutate an asset or object | Type-level assertion that `assets` exposes only `findById` and `storage` only `exists`/`createSignedDownloadUrl` |

### Mutation verification

| Mutation | Result |
| --- | --- |
| Resolution taken from live capability instead of the snapshot | **1 fail** |
| Request-hash verification removed | **1 fail** |
| Asset `READY` check removed | **4 fail** |
| `deletionRequestedAt` check dropped | **1 fail** |
| Storage existence check removed | **2 fail** |
| Preflight TTL reverted to the human-download 300s | **2 fail** |
| URL signed before the asset checks | **2 fail** |
| `FAILED` put back into the unrecoverable bucket (the reviewed defect) | **1 fail** |
| A status removed from the production `Record` | **compile error** `TS2741` |
| `DELETION_PENDING` reclassified as recoverable | **1 fail** |
| `deletionRequestedAt` override removed | **1 fail** |
| `ASSET_UPLOAD_FAILED` folded back into `ASSET_NOT_READY` | **1 fail** |
| `storage` widened back to the full `ObjectStorage` | **compile error** `TS2420`/`TS2739` |
| `assets` widened back to the full `MediaAssetRepository` | **compile error** `TS2322` |

Each restored, `git diff --stat` confirming the file unchanged afterwards.

The TTL mutation is worth recording because it initially **passed**. The test
asserted the signed TTL equalled `PREFLIGHT_SOURCE_URL_TTL_SECONDS` — the same
constant it was checking — so both could move together undetected. It now
asserts the literal, plus the relationship that justifies a separate constant at
all: the preflight TTL must exceed `DOWNLOAD_URL_TTL_SECONDS`.

## Invariants held

8-fact `requestHash` **unchanged** · state machine **unchanged** · schema and
migrations **unchanged** · the six request/frozen artifacts untouched ·
tenant-facing `SceneGenerationRepository` untouched · `generation-service.ts`
untouched · `execution-ports.ts` and its adapter untouched · no worker loop,
claim, state write, asset write, persisted URL, provider call, prediction,
submission audit, polling, sweep, retry, or output ingestion.

### Corrected in review

**`FAILED` was terminal, and should not have been.** It was grouped with deleted
and quarantined assets as `ASSET_GONE`. `AssetService.retryUpload` accepts a
failed asset and resets that same id to `PENDING_UPLOAD`, from which it can
reach `READY` — so a future durable mapper would have permanently failed an
attempt whose photo was one customer action away. It is now
`ASSET_UPLOAD_FAILED`, retryable, and deliberately its own reason rather than
merged into `ASSET_NOT_READY`: waiting resolves an in-progress asset and never
resolves a failed upload.

**The criterion is now stated exactly**, because the original wording invited
this mistake. It is not "does this fix itself" but *can this same `MediaAsset`
identity become an executable `READY` source again, without changing the
admitted `assetId`?* Nothing recoverable is described as resolving on its own —
`PENDING_UPLOAD` may be waiting on a customer's client just as `FAILED` waits on
`retryUpload`.

**`ASSET_GONE` is renamed `ASSET_UNRECOVERABLE`.** Quarantined and rejected
content still exists; "gone" described the wrong property.

**One `Record<MediaAssetStatus, AssetExecutability>` in production is the whole
classification.** It is the only exhaustive map of these states anywhere — the
tests deliberately keep no copy, since a second map could drift from the first
while both stayed green.

**The dependencies are narrowed with `Pick`.** Preflight held the complete
mutable `MediaAssetRepository` and `ObjectStorage`, so "preparation changes
nothing" rested on a comment. It now rests on the type: `update`, `putObject`,
`deleteObject` and `createSignedUploadUrl` are not reachable, and the test fake
implements only the two storage methods rather than throwing from four it can no
longer be asked for.

## Known limitations

- **Nothing calls this yet.** Production-dormant, like Phase 4C-1b.
- **The asset-status / URL-signing window is open**, by decision (ADR-0026,
  Consequences). Ordering ensures nothing is signed for an asset already known
  to be unusable.
- **Capability re-validation is identity-only.** `assertSettingsSupported`
  cannot be re-run, because it needs a discrete `negativePrompt` the snapshot
  does not store. A capability table edited under an unchanged model id would go
  unnoticed. Recorded in `docs/decisions/TODO.md`.
- **No durable disposition exists for a refusal.** Phase 4C-2B owns that.

## Size

| Category | Lines changed |
| --- | --- |
| Production | 440 (of which ~181 are statements; the rest is comment) |
| Tests | 499 |
| Docs | 437 |
| **Total** | **1,376** across 9 files |

Measured from `git diff --numstat 27ba4df..HEAD` after the final commit existed,
reconciling with the raw diff (`+1372 −4 = 1,376`).

**This is over the planning estimate and is recorded as over.** The approved
plan estimated ~210–260 production and ~330–400 tests for the *whole* of Phase
4C-2; 4C-2A alone exceeds both. The overrun is concentrated in two places: the
refusal taxonomy turned out to need nine reasons rather than eight, each with
its own test and its own justification, and the `MediaAssetStatus` split is
exhaustive over ten states rather than sampled. Neither was padding, but neither
was in the estimate either.
