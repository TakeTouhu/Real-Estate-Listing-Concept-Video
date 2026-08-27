# ADR-0028: MediaAsset deletion-intent monotonicity

Status: Accepted (Phase 4C-3A-1)
Date: 2026-08-27

## Context

Phase 4C-3 needs a point at which a paid submission and an asset deletion are
ordered against each other. The first proposal was: make `requestDeletion` a
compare-and-swap, and have the submission claim read the asset inside its own
transaction. **That does not linearize anything**, and the counter-example is
short:

```
T1 (submission)  BEGIN
T1               SELECT media_assets WHERE id=A     → READY, no deletion intent
T2 (deletion)    UPDATE media_assets ... WHERE id=A AND deletionRequestedAt IS NULL
T2               COMMIT
T1               UPDATE scene_generations ... WHERE id=G AND state='QUEUED'
T1               COMMIT
```

Both succeed. A plain `SELECT` takes no lock, so T1's observation is a value
read at an earlier instant, not an ordering; and the two `UPDATE`s touch
different rows, so neither predicate can see the other. A CAS makes deletion
correct against *other deletion writers* — it says nothing about a transaction
that merely read.

Ordering those two requires the submission transaction to lock the asset row.
That is Phase 4C-3A-2. But the lock is only worth taking if what it observes is
trustworthy, and inspection showed it is not.

**Every asset mutation went through one method** — `update(asset: MediaAsset)` —
which addressed rows by `id` alone and wrote **every** column from the caller's
snapshot, `deletionRequestedAt` included. Eleven production writers used it, and
nine could silently erase a deletion request. The worst is `completeUpload`: it
reads the asset once, then runs a malware scan, image processing and two storage
writes before its final write. A deletion committed anywhere in that stretch was
overwritten, and the asset came back as **`READY` under a fresh storage key** —
an executable source, resurrected after deletion had won.

The generic whole-entity `update` is the root problem, not its callers. A method
that writes every column from a caller-held snapshot cannot express "leave
deletion intent alone", so every caller inherited the defect and every future
caller would too.

## Decision

### 1. Deletion intent is monotonic

Once `deletionRequestedAt` is non-null, no ordinary lifecycle mutation can make
it null again, and none can return the row to an executable state.

Enforced by the database, in the repository, not by service comments.

### 2. Ordinary lifecycle mutation becomes a conditional update

```ts
updateIfCurrent(asset: MediaAsset, expectedStatus: MediaAssetStatus): Promise<MediaAsset | null>
```

Predicate: `id` **and** `organizationId` **and** `status = expectedStatus`
**and** `deletionRequestedAt IS NULL`.

Two guards, doing different jobs:

- **`deletionRequestedAt IS NULL`** — deletion has not won.
- **`status = expectedStatus`** — the caller names the state it believes it is
  replacing, so a stale snapshot cannot overwrite a row another writer already
  moved. This is a narrow expected-state rule for asset lifecycle, **not** a
  version column and not a global asset state machine; the repository checks
  what the caller supplies and has no opinion about which transitions are legal.

`deletionRequestedAt` is **absent from the written columns entirely**. The
predicate stops a stale writer; the omission means no path — present or future —
can set or clear intent through this method even if the predicate were weakened.

`null` means: the durable row no longer satisfies what this mutation expected.
Deletion won, another writer moved the status, the organization does not own it,
or it does not exist. Undifferentiated, because the caller's next action is the
same in all four: stop.

### 3. A dedicated deletion CAS

```ts
requestDeletion(organizationId: string, assetId: string, requestedAt: Date): Promise<MediaAsset | null>
```

Predicate: `id` **and** `organizationId` **and** `deletionRequestedAt IS NULL`
**and** `status <> 'DELETED'`. Writes exactly `status = DELETION_PENDING` and
`deletionRequestedAt`, and nothing else — a deletion request must not disturb
the storage key, hashes or dimensions an in-flight lifecycle writer may still be
reading.

The only method that may establish deletion intent.

### 4. One statement, not a read-then-write

Prisma 5.22 accepts non-unique filters beside the unique one in `where`, and
compiles the above to a single

```sql
UPDATE "media_assets" SET ... WHERE "id" = $1 AND "organizationId" = $2
  AND "status" = $3 AND "deletionRequestedAt" IS NULL
```

**Verified against PostgreSQL with query logging rather than assumed**, because
the whole contract depends on it: the winner is decided by that one statement's
`WHERE`. `updateMany` followed by a re-read would reopen exactly the TOCTOU
window this exists to close, and it would change the returned-row concurrency
contract — the losing writer could still observe a row it had already failed to
claim. `P2025` (no record matched) becomes `null`; every other error propagates,
so a connection failure is never reported as a lost race.

No raw SQL, and no nested `$transaction` — the same repository is constructed on
a `TransactionClient` inside `ReviewTransaction`, where a nested transaction
would be wrong.

### 5. Services stop when they lose

Every `AssetService` lifecycle path routes its guarded write through one private
`mustOwnLifecycle` helper that throws `VALIDATION_FAILED` on `null`. The stages
that follow — scanning, image processing, storage writes, minting an upload URL
— all act on an asset the call no longer controls.

`VALIDATION_FAILED`, not `INTERNAL_ERROR`: nothing is broken. The customer asked
for something that stopped being possible while it ran, and a 5xx would blame
the system for a legitimate concurrent decision. The message is fixed text
naming neither the winning writer nor the row's current state.

`retryUpload` is guarded **before** the upload URL is minted: an upload
credential for an asset being deleted is worse than a refusal.

### 6. Direct deletion converges idempotently

`AssetService.requestDeletion` on a lost CAS performs one authoritative
tenant-scoped re-read:

- deletion intent now established → return the current row, and emit **no second
  audit entry**. Deletion is idempotent by nature; a duplicate entry would
  misrepresent one decision as two in the record that exists to reconstruct
  decisions.
- missing or `DELETED` → existing `NOT_FOUND` semantics.
- still an ordinary non-deleting asset → `INTERNAL_ERROR`. The predicate refused
  something the row says should have succeeded; reporting success would claim a
  deletion that did not happen, and retrying would loop against a condition that
  already disagreed with itself. No loop.

### 7. Property removal converges too

`PropertyService.remove` calls `requestDeletion` per asset and **ignores `null`**.
Removal's requirement is that the asset stops being an ordinary active one, and
`null` means another writer already moved it that way. Failing removal over that
would refuse the customer's request for having already partly come true. Its
existing `PropertyDeleted` audit behaviour is unchanged and no per-asset audit
was added.

### 8. Review rejection rolls back

`AnalysisService.reject` writes the analysis and the asset in one
`ReviewTransaction`. The asset write is now guarded, and a `null` result throws
**inside** the transaction so the analysis decision rolls back with it.
Committing the rejection while the asset write lost would record a decision
against an asset that never received it — and if deletion won, against an asset
already on its way out.

## Consequences

- Nine writers that could erase deletion intent no longer can.
- `completeUpload` cannot resurrect a deleted asset as `READY`.
- Concurrent lifecycle writers with different targets produce one winner.
- Phase 4C-3A-2's asset row lock will observe a value that ordinary work can no
  longer corrupt.
- Callers must handle `null`. That is the intended cost: the previous signature
  made the failure invisible.

**No schema change and no migration.** `deletionRequestedAt` already existed as a
nullable column; only who may write it changed.

## Recorded for Phase 4C-3A-2

**Source identity needs `sha256`, not just `storageKey` and `mimeType`.**
`buildAssetStorageKey` is deterministic from organization, property, asset,
variant and extension — so a later normalized JPEG for the *same* asset reuses
the *same* `normalized.jpg` key while containing different bytes. Key and MIME
equality would therefore pass over a genuinely different source. The durable row
already carries `sha256` for normalized content, so claim-time validation must
compare all three, and preflight must fail closed if a supposedly executable
`READY` source has no usable content hash. The refusal code is deferred to A-2
design review.

**The asset row lock is the serialization barrier, and commit is the
linearization point.** Acquiring the lock orders the transaction against every
asset writer, but a submission licence exists only when the transaction that
holds that lock *and* performs `QUEUED -> SUBMITTING` **commits**. If the
generation CAS loses after the asset lock was acquired, submission did not win.

## Recorded for future retention work

No physical deletion exists today: `deleteObject` has zero production callers,
nothing writes `status = DELETED`, and `retentionExpiresAt` is only ever set to
null. A future deletion worker must not remove a source object while a provider
may still depend on it — and must protect **`SUBMITTING`, `PROCESSING` and
`SUBMISSION_UNKNOWN`**. The last matters most: `SUBMISSION_UNKNOWN` may
represent a request the provider accepted and billed even though acceptance
cannot be proven locally, so deleting its source would destroy recovery safety.
`MediaAsset` has no relation to `SceneGeneration`, so that worker must check
generation state explicitly; the database will not stop it.

## Alternatives rejected

**Optimistic version/`updatedAt` CAS on every mutation.** Catches all lost
updates, not only deletion, but converts every asset write into a retry-or-fail
contract and forces a policy decision at eleven call sites in one change.
Larger blast radius than the invariant needs.

**Replacing `update` with narrow semantic transition methods.**
Architecturally right, and how `SceneGenerationExecutionRepository` is built, but
a rewrite of the property write surface that this milestone does not require.

**Leaving `requestDeletion` unconditional and only guarding readers.** Cannot
work: an unconditional write cannot lose, so two deletion requests would produce
two different durable timestamps with no defined winner.
