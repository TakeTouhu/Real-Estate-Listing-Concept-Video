# Phase 4C-3A-1 — MediaAsset deletion-intent monotonicity

Milestone: Phase 4C-3A-1
Base: `cf701bab2fb171c27dba1922df0b891529472d86` (merged Phase 4C-2B, PR #41)
Decision record: ADR-0028

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source.

## What shipped

```ts
updateIfCurrent(asset: MediaAsset, expectedStatus: MediaAssetStatus): Promise<MediaAsset | null>
requestDeletion(organizationId: string, assetId: string, requestedAt: Date): Promise<MediaAsset | null>
```

**ADR-0028 carries the reasoning in full**, including the interleaving that
proves a deletion CAS plus an ordinary claim-time read does **not** linearize
submission against deletion — the correction that produced this milestone.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | **1258 passed**, 61 files (baseline 1247 / 61) |
| `pnpm build` | exit 0 |
| `pnpm test:db` | **197 passed**, 9 files (baseline 184 / 8) |
| `prisma migrate diff --from-migrations` | `No difference detected.` exit 0 |

## The Prisma capability, proved before it was relied on

The whole contract rests on one conditional statement deciding the winner.
Probed against live PostgreSQL with query logging **before** any adapter code was
written:

```
UPDATE "public"."media_assets" SET "status" = ..., "updatedAt" = $2
  WHERE ("public"."media_assets"."id" = $3
    AND ("public"."media_assets"."organizationId" = $4 ...))
```

Predicate matches → the updated row is returned. Predicate does not match →
`P2025`, translated to `null`. No preliminary read, no `updateMany` + external
re-read, no raw SQL, no nested transaction.

## Where each property is proven

13 new PostgreSQL tests and 11 new service tests. The PostgreSQL ones interleave
**real** competing writes; the service ones interleave a **real** deletion
request against a real in-flight `completeUpload`, rather than stubbing a
repository to return `null`.

| Property | Proven by |
| --- | --- |
| Stale writer cannot erase intent | Deletion wins, then a pre-deletion snapshot writes → `null`, and the deletion winner's **whole row** is unchanged |
| Deletion guard is load-bearing on its own | Intent set while the status is still `PROCESSING`, so only that guard can refuse |
| Ordinary work cannot *establish* intent | A write that **wins** carries a non-null `deletionRequestedAt`; the column stays null |
| No READY resurrection | A snapshot carrying a new normalized key, hash, dimensions and `READY` → `null`, row still `DELETION_PENDING` |
| Tenant predicate is on the write | A foreign-org entity relabelled with this org still refuses |
| Expected status discriminates | Two writers, same expected status, different targets → exactly one winner |
| Deletion CAS is exactly-once | Two concurrent requests → one winner; the durable timestamp is the winner's |
| Deletion writes only its own columns | Whole-row comparison normalized on `status`, `deletionRequestedAt`, `updatedAt` |
| `DELETED` cannot be revived | `requestDeletion` on a `DELETED` row → `null` |
| Lifecycle stops early | Deletion first → `completeUpload` throws with **0 scans and 0 image processes** |
| Lifecycle stops late | Deletion injected *during* image processing → throws, row stays `DELETION_PENDING`, never `READY` |
| No credential for a doomed asset | `retryUpload` mints no signed URL after losing the guard |
| Deletion converges and still audits | Second request returns the same durable timestamp and records a **second** entry — one per successful invocation |
| A missing audit is repairable | First call's audit throws → call fails, intent durable and unaudited; retry converges and writes the entry |
| Lost final write compensates | Deletion wins during processing → both derivatives gone from storage, no `asset.upload_completed` audit |
| Referenced keys are protected | Authoritative re-read shows a `READY` row owning the normalized key → that object survives, invocation still fails |
| Cleanup failure is surfaced | One delete throws → both keys attempted, sanitized `INTERNAL_ERROR`, no key in the error |
| Removal converges | Property removal succeeds with one asset already deletion-pending; both end with intent recorded |
| Review rolls back | Deletion wins, rejection throws inside `ReviewTransaction`, analysis stays `UNREVIEWED` — proven in-memory **and** against PostgreSQL |

## Mutation ledger

| Mutation | Result |
| --- | --- |
| **M1** — `deletionRequestedAt IS NULL` dropped from the ordinary predicate | **1 DB fail** |
| **M2** — ordinary `data` writes caller-supplied `deletionRequestedAt` again | **1 DB fail** |
| **M3** — `organizationId` dropped from the ordinary predicate | **1 DB fail** |
| **M4** — `expectedStatus` dropped from the ordinary predicate | **1 DB fail** |
| **M5** — `deletionRequestedAt IS NULL` dropped from `requestDeletion` | **1 DB fail** |
| **M6** — `PropertyService.remove` back to ordinary update for deletion | **1 unit fail** |
| **M7** — `AnalysisService.reject` ignores a `null` guarded result | **1 unit fail** |
| **M8** — audit suppression restored on convergence | **2 unit fail** |
| **M9** — post-`READY`-CAS derivative cleanup removed | **2 unit fail** |
| **M10** — referenced-key protection removed from cleanup | **1 unit fail** |

Every mutated file restored byte-identically, confirmed by `diff`. No
mutation-only code is committed.

**Three of these initially passed, and the tests were fixed rather than the
result reported.** They are worth recording because each exposed a real gap in
the evidence:

- **M1 passed at first.** Every monotonicity test had the *status* predicate
  rejecting the stale writer independently — `requestDeletion` sets
  `DELETION_PENDING`, so the expected status never matched anyway. The deletion
  guard was never load-bearing. Fixed by seeding intent while the status is
  still `PROCESSING`, which is the invariant as actually stated: it is a
  property of the **column**, not of the status.
- **M2 passed at first**, masked by the predicate: a stale writer never reaches
  the write. Fixed by testing the half a predicate cannot enforce — a write that
  *wins* while carrying a non-null timestamp. Without the omission, ordinary
  lifecycle work could establish deletion intent, bypassing `requestDeletion`
  and its audit entry.
- **M6 passed at first** because the test asserted only the status, which the
  substituted ordinary update also produces. It cannot produce the
  `deletionRequestedAt` value, since that column is unwritable through it — so
  the row would have looked deletion-pending while carrying no record that
  deletion was ever requested, and no timestamp for a retention window to start
  from. Fixed by asserting both.

## Invariants held

Prisma schema and migrations **unchanged** (no migration generated) ·
`SceneGeneration` state machine **unchanged** · generation execution port and
repository **unchanged** · `PreparedGeneration` **unchanged** · `requestHash`
**unchanged** · `GenerationService` **unchanged** · provider packages
**unchanged** · environment schema **unchanged** · worker runtime **unchanged** ·
`PropertyRepository` **unchanged** · no raw SQL · no provider call · no
WaveSpeedAI call · no paid gate · no orchestrator · no worker loop · no A-2 code.

## Known limitations

- **Callers must now handle `null`.** That is the intended cost; the previous
  signature made the failure invisible.
- **Deletion and its audit are not atomic.** They share no transaction and the
  mutation commits first, so a durable deletion can briefly exist unaudited. The
  guarantee is only that **no invocation returns success unless its own audit
  write succeeded**, and that a later retry can write the missing entry. No
  outbox, no uniqueness migration, no idempotency key.
- **A failed derivative cleanup still leaves an orphan.** The losing final write
  now deletes what it created, but if a required delete throws, the object
  remains — and since the asset row does not name it, row-walking retention
  cannot find it. Recovery needs storage-prefix reconciliation. Recorded in
  `docs/decisions/TODO.md`.
- **Expected-status is not a version counter.** It discriminates only when the
  winner changes the status; two same-status → same-status writers are not
  ordered by it, and no test claims otherwise.
- **This does not yet linearize submission against deletion.** It makes what the
  Phase 4C-3A-2 lock will observe trustworthy. The lock itself is A-2.
