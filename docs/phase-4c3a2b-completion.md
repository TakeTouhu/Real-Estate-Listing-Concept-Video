# Phase 4C-3A-2b — Locked prepared-source submission claim

Milestone: Phase 4C-3A-2b
Base: `f8a78659738153077432cb325dc90259e4d7092f` (merged Phase 4C-3A-2a, PR #43)
Decision record: ADR-0030

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source.

## What shipped

```ts
claimPreparedForSubmission(
  generationId: string,
  sourceIdentity: PreparedSourceIdentity,
): Promise<SubmissionClaimOutcome>;

type SubmissionClaimOutcome =
  | { kind: "CLAIMED";        claim: ClaimedSceneGeneration }
  | { kind: "SOURCE_INVALID"; reason: PreflightRefusalReason }
  | { kind: "NOT_CLAIMABLE" };
```

`claimQueuedForSubmission` is **deleted**. `isMediaAssetStatus` is added to
`execution-source.ts` as a runtime guard over the existing exhaustive map.
**ADR-0030 carries the reasoning in full.**

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | exit 0 |
| `pnpm test` | **1345 passed**, 62 files (baseline 1320 / 62) |
| `pnpm build` | exit 0 |
| `pnpm test:db` | **213 passed**, 9 files (baseline 199 / 9) |
| `prisma migrate diff --from-migrations` | `No difference detected.` |

## What the lock buys, measured rather than argued

Three probes against live PostgreSQL, run **before** the lock mode was chosen:

| Probe | Result |
| --- | --- |
| `FOR NO KEY UPDATE` vs the real `requestDeletion` write shape | **blocked** (lock timeout); succeeds after release |
| FK-referencing `storyboard_scenes` insert under `FOR NO KEY UPDATE` | **not blocked** |
| The same insert under `FOR UPDATE` | **blocked** |
| `status` column via `$queryRaw` | decodes as a plain **string**, not the Prisma enum |
| `$extends` query interceptor inside an interactive transaction | **fires** (`intercepted: 1`) |

The last one decided the test harness. Without it the barrier below would never
engage and the concurrency tests would pass while proving nothing.

## The deterministic concurrency harness

Both lock properties need the claim held open at an exact point — after the lock
statement returns, before commit. There is **no production seam** for that and
there must not be: a pause hook on the one method that issues licences to spend
money is worse than a weaker test.

The barrier is entirely test-owned. The repository factory already takes a
`PrismaClient`, so the test hands it an **extended** client whose
`sceneGeneration.updateMany` interceptor waits on a promise the test controls.
Reaching that interceptor *is* the proof the lock is held.

Where the claim must instead be observed **blocked**, the test polls
`pg_locks WHERE NOT granted` from its **own** connection — not a sleep, and not
through the pool the blocked transaction is already holding a connection from.

## Where each property is proven

| Property | Proven by |
| --- | --- |
| A real deletion blocks while the claim holds the lock | Barrier harness; deletion hits `lock_timeout`, claim then commits `CLAIMED`, deletion then succeeds |
| A later deletion does not revoke an issued licence | Same test: the generation is still `SUBMITTING` afterwards |
| `NOT_CLAIMABLE` outranks a stale source verdict | Claim blocks on a held lock, a **real** `failQueuedPreflight` parks the row, source already broken → `NOT_CLAIMABLE` |
| Exactly one winner | 2 claimers → 1 `CLAIMED` / 1 `NOT_CLAIMABLE`; 8 claimers → 1 / 7 |
| Two generations, one asset | Both `CLAIMED`, serialized on the asset row, no deadlock |
| Claim vs preflight park | Identical `state='QUEUED'` predicate; exactly one wins, loser is `NOT_CLAIMABLE` |
| Every non-`QUEUED` state | `NOT_CLAIMABLE` with whole-row equality, all 7 states |
| Deletion intent on the locked row | `ASSET_UNRECOVERABLE` |
| Locked status buckets | `PROCESSING`→`ASSET_NOT_READY`, `FAILED`→`ASSET_UPLOAD_FAILED`, `QUARANTINED`→`ASSET_UNRECOVERABLE` |
| Key changed | `ASSET_SOURCE_CHANGED` |
| **Same key + same MIME + different valid digest** | `ASSET_SOURCE_CHANGED` — the case the whole prepared-source contract exists for |
| Missing / malformed locked digest | `ASSET_SOURCE_UNIDENTIFIABLE` |
| Non-JPEG locked row | `ASSET_FORMAT_UNSUPPORTED`, not forced into "changed" |
| Foreign-organization asset | `ASSET_NOT_FOUND`, foreign row untouched and undescribed |
| Absent asset | `ASSET_NOT_FOUND` |
| Every `SOURCE_INVALID` | Whole-row equality including `updatedAt` — asserted in the shared helper, so no case can skip it |
| Successful claim | Only `state` and `updatedAt` differ, with **non-null** history seeded so preservation is discriminating |
| Status guard | All ten accepted; arbitrary/empty/lowercase strings, `null`, `undefined`, numbers, objects, arrays and `toString`/`constructor`/`__proto__`/`hasOwnProperty` all refused |

## Mutation ledger

| Mutation | Result |
| --- | --- |
| **M1** — `FOR NO KEY UPDATE` removed | **2 DB fail** |
| **M2** — post-lock generation recheck removed | **1 DB fail** |
| **M3** — classifier's deletion input forced to `null` | **1 DB fail** |
| **M4** — `storageKey` equality removed | **1 DB fail** |
| **M5** — `mimeType` equality removed | **0 DB fail**, **1 unit fail** — see below |
| **M6** — `sha256` equality removed | **1 DB fail** |
| **M7** — public one-argument claim restored | **compile-only: 2 TS errors, 0 runtime failures** |
| **M8** — CAS moved before validation, committing on refusal | **15 DB fail** |
| **M9** — `organizationId` dropped from the locked-asset predicate | **1 DB fail** |
| **M10** — `SOURCE_INVALID` returned after a post-lock move | **2 DB fail** |

Every mutated file restored byte-identically, confirmed by `diff`. No
mutation-only code is committed.

**M5 is reported honestly as non-discriminable at the database boundary, and no
invalid source state was manufactured to make it fail.** The reason is
classifier precedence: `classifyExecutionSource` only returns `USABLE` for
`mimeType === "image/jpeg"`, and preflight likewise only produces JPEG
identities — so both sides of the comparison are constrained to the same value
and can never legitimately differ. The `mimeType` term is therefore defence
against a future third producer of identities rather than against any reachable
state today. It is still covered as a pure property by
`sameSourceIdentity`'s unit test, which is the one failure M5 produces.

**M7 is compile-only**, the same honest treatment A-2a gave its M5: restoring the
method is caught by `tsc` (2 errors, including the type-level assertion that the
old key is absent from the port), while Vitest strips types so the runtime suite
still passed.

**M3's first run applied no mutation** — the anchor string did not match and the
edit silently did nothing, so the "72 passed" from that attempt proved nothing.
Re-run against the correct anchor, it fails 1 DB test. Recorded because a
mutation that never applied looks exactly like a mutation that was not caught.

## Invariants held

Prisma schema and migrations **unchanged** (no migration generated) ·
`PreparedSourceIdentity` **unchanged** · `prepareQueuedGeneration` **unchanged** ·
`PreflightRefusalReason` vocabulary **unchanged** at fourteen · `requestHash`
**unchanged** · `SceneGeneration` state machine **unchanged** ·
`MediaAssetRepository` **unchanged** · `AssetService` **unchanged** ·
`PropertyService` **unchanged** · `AnalysisService` **unchanged** · provider
packages **unchanged** · environment schema **unchanged** · audit runtime
**unchanged** · worker runtime **unchanged** · `apps/web` **unchanged** · no paid
gate · no provider call · no WaveSpeedAI call.

## Known limitations

- **The raw statement is the first in the repository.** Bounded to one private
  parameterized query, but it is a boundary that did not exist before and a
  future edit could widen it.
- **`FOR NO KEY UPDATE` is chosen, not configurable.** If a future writer needs
  to conflict with FK holders too, the mode has to change deliberately.
- **The post-lock recheck depends on READ COMMITTED.** Prisma sets no isolation
  level and PostgreSQL's default supplies it; raising the level would silently
  disable the check. Stated in ADR-0030 §3 rather than assumed.
- **`mimeType` equality is unreachable-by-construction today** (see M5). Kept
  because the identity contract is three fields, not two.
- **Nothing calls any of this.** Still production-dormant; the orchestrator, the
  paid gate and provider submission are all later milestones.
