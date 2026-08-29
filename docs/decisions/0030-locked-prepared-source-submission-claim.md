# ADR-0030: The locked prepared-source submission claim

Status: Accepted (Phase 4C-3A-2b)
Date: 2026-08-28

## Context

`claimQueuedForSubmission(generationId)` moved a row from `QUEUED` to
`SUBMITTING` — the licence to spend money on a generation exactly once — and
said **nothing about the bytes being submitted**. It took one argument, so there
was no way for it to.

ADR-0029 supplied the missing description: `PreparedSourceIdentity`, the three
fields that identify a source, with the digest as the only one that can tell two
re-processed images apart. What it did not do is order the claim against anything
else. Two writes to two different rows cannot see each other:

```
T1 (claim)      SELECT media_assets WHERE id=A     → READY, no deletion intent
T2 (deletion)   UPDATE media_assets ... WHERE id=A AND deletionRequestedAt IS NULL
T2              COMMIT
T1              UPDATE scene_generations ... WHERE id=G AND state='QUEUED'
T1              COMMIT
```

Both succeed. A plain `SELECT` takes no lock, so T1's observation is a value at
an earlier instant, not an ordering. This is the interleaving ADR-0028 first
recorded, and closing it is what A-2b exists for.

## Decision

### 1. One claim method, and no unprepared path

```ts
claimPreparedForSubmission(
  generationId: string,
  sourceIdentity: PreparedSourceIdentity,
): Promise<SubmissionClaimOutcome>;
```

`claimQueuedForSubmission` is **deleted**, not deprecated and not overloaded.
There were zero production callers, so compatibility could not justify keeping a
route to `SUBMITTING` that states no source. A one-argument alias left in place
"for tests" is exactly the route the next caller finds.

`sourceIdentity` is a description, never a credential: no signed URL, no expiry,
no prompt, no provider input. The **asset id and organization are resolved**
from the generation row and its `VideoProject`, never accepted as arguments — a
caller cannot aim this at an asset the admitted request did not name.

### 2. Three outcomes, discriminated by `kind`

```ts
type SubmissionClaimOutcome =
  | { kind: "CLAIMED";        claim: ClaimedSceneGeneration }
  | { kind: "SOURCE_INVALID"; reason: PreflightRefusalReason }
  | { kind: "NOT_CLAIMABLE" };
```

A top-level discriminant, unlike the A-1 result types where `generation.state`
already separated them. Here two of three arms carry **no generation at all**,
so there is no shared field to discriminate on. `ClaimedSceneGeneration | null`
was rejected for the reason it is always rejected: it collapses two outcomes a
caller must treat differently.

- **`SOURCE_INVALID`** means *this still-claimable `QUEUED` work cannot receive a
  licence, because the prepared source is not what preflight approved.* It
  carries one closed-vocabulary reason and nothing else — no key, digest, MIME
  type, asset id, organization id or URL. The values compared describe customer
  content; the result is meant to be safe to log whole.
- **`NOT_CLAIMABLE`** means *this caller did not obtain the `QUEUED` licence*,
  and asserts nothing about the source. Unknown id, already claimed, cancelled,
  parked, or simply lost the race — identical, because the caller's next action
  is identical and because naming the winner leaks another actor's progress.

No generic `details` bag: a payload nobody uses is how a storage key eventually
reaches a log.

### 3. `NOT_CLAIMABLE` outranks a stale source verdict

The claim reads the generation **twice**, and the second read is the subtle part.

```
1. plain read generation + VideoProject      ← no generation lock
2. state ≠ QUEUED                 → NOT_CLAIMABLE
3. SELECT … FOR NO KEY UPDATE on media_assets  ← may block
4. plain re-read generation                  ← load-bearing
5. state ≠ QUEUED                 → NOT_CLAIMABLE
6. classify locked row            → SOURCE_INVALID(reason)
7. identity equality              → SOURCE_INVALID(ASSET_SOURCE_CHANGED)
8. CAS QUEUED → SUBMITTING
9. count 0                        → NOT_CLAIMABLE
10. re-read + invariants
COMMIT                                        ← the licence exists here
```

Acquiring the asset lock can block for as long as another writer holds it, and
in that time the generation may be claimed, cancelled or parked by someone else.
**Without step 4**, a claimant that waited and then found the source invalid
would answer `SOURCE_INVALID` — a verdict about the source of work that is no
longer anyone's to do, and one a future orchestrator might act on by parking a
row another actor already moved.

Step 4 is not redundant with step 8's compare-and-swap. The CAS closes the
window *after* step 5, and returns `NOT_CLAIMABLE` when it loses; but without
step 4 the method would return `SOURCE_INVALID` **before ever reaching the CAS**.

A plain read suffices at step 4 *because* this runs at **READ COMMITTED**, where
each statement sees the latest committed data. Prisma configures no isolation
level and PostgreSQL's default is `read committed`; under `repeatable read` the
statement would read the transaction's original snapshot and this check would
silently stop working. That is why the isolation level is stated here rather than
assumed, and why raising it is a change that must revisit this ADR.

### 4. The asset row lock, and why `FOR NO KEY UPDATE`

Prisma 5.22 exposes no fluent row-lock primitive, so this is the repository's
**first and only** production raw statement. It stays private to
`generation-execution-repository.ts`: no generic raw-SQL helper, no lock helper,
no system asset repository, no exported transaction primitive.

```sql
SELECT "id", "organizationId", "status", "storageKey",
       "mimeType", "sha256", "deletionRequestedAt"
  FROM "media_assets"
 WHERE "id" = $1 AND "organizationId" = $2
 FOR NO KEY UPDATE
```

Written as a Prisma tagged template, so both values are bound parameters. No
`Prisma.raw`, no concatenation, no interpolation.

**`FOR NO KEY UPDATE` rather than `FOR UPDATE`**, and the difference was measured
rather than reasoned about:

| Probe | Result |
| --- | --- |
| `FOR NO KEY UPDATE` vs the real `requestDeletion` write | **blocks** (lock timeout), succeeds after release |
| FK-referencing `storyboard_scenes` insert under `FOR NO KEY UPDATE` | **not blocked** |
| The same insert under `FOR UPDATE` | **blocked** |

`storyboard_scenes` has a foreign key to `media_assets(id, propertyId)`, so
inserting a scene takes `FOR KEY SHARE` on the asset row. The claim needs to
conflict with asset **writers** — `requestDeletion` and every `updateIfCurrent`
— and has no reason to stall ordinary storyboard composition for the length of a
claim. `FOR NO KEY UPDATE` conflicts with the former and not the latter.

### 5. The raw row is validated, not asserted

`$queryRaw` bypasses Prisma's model mapping, so its type parameter is an
assertion. Verified against PostgreSQL: `status` arrives as a plain **string**,
not the generated enum; `deletionRequestedAt` as `Date | null`.

`raw.status as MediaAssetStatus` would launder an arbitrary value into
`classifyExecutionSource`, where the exhaustive status map yields `undefined` and
falls through every branch — a source of unknown lifecycle treated as classified.
So every field is checked, and the status through a new guard:

```ts
export function isMediaAssetStatus(value: unknown): value is MediaAssetStatus
```

**Deliberately not a second list.** Membership is tested against the own keys of
`ASSET_EXECUTABILITY`, which is already `Record<MediaAssetStatus, …>` and already
fails to compile when a status is added. A parallel array would be a second
vocabulary that could silently disagree with it. Membership uses
`Object.prototype.hasOwnProperty.call`, not `in`: `"toString" in
ASSET_EXECUTABILITY` is `true` through the prototype chain.

A row failing these checks is an **invariant failure, not a refusal**. The column
set is schema-constrained, so a value outside it means the database and this
process disagree about what `media_assets` contains. Reporting that as a
`PreflightRefusalReason` would file a system defect as a verdict about the
customer's photo, and would durably park their work for it. The error names
nothing and is raised inside the transaction, so the claim rolls back.

### 6. One classifier, reused

The adapter calls `classifyExecutionSource` — the same function preflight uses —
and reproduces no lifecycle rule of its own. Zero locked rows is
`ASSET_NOT_FOUND`, and because `organizationId` is in the `WHERE`, a foreign
asset is never loaded: absent and foreign are indistinguishable, which is the
tenant guarantee rather than a limitation of the message.

Only two **independently usable** identities reach equality, so a MIME change
that makes the locked row non-JPEG is owned by the classifier and returns
`ASSET_FORMAT_UNSUPPORTED` rather than being forced into `ASSET_SOURCE_CHANGED`.
Equality compares `storageKey`, `mimeType` and `sha256` exactly — no trimming, no
normalization, no re-hashing.

### 7. `SOURCE_INVALID` writes nothing

Every source verdict is returned before any `scene_generations` write, so the row
is untouched down to `updatedAt`. The claim does **not** call
`failQueuedPreflight`: claiming and parking are separate decisions, and a method
that silently parked on refusal would make a lost race indistinguishable from a
policy decision. A future orchestrator may discard the `PreparedGeneration` and
attempt `failQueuedPreflight(id, reason)`, stopping if that CAS loses.

A successful claim writes **only** `state`; `updatedAt` is the database's.
Nothing else is cleared — not `normalizedErrorCode`, `providerPredictionId`,
`submittedAt`, `lastPolledAt` or `outputStorageKey`. A future explicit requeue
policy may legitimately return a row to `QUEUED` still carrying an earlier
attempt's diagnostics, and quietly erasing them here would destroy that history.

### 8. Lock order, and the linearization point

**`MediaAsset` before `SceneGeneration`**, frozen. The initial and post-lock
generation reads are non-locking, so they do not invert it.

Re-audited across every production transaction after A-2b: the two execution
methods touch only `scene_generations`; `ReviewTransaction` takes
`asset_analyses` then `media_assets`; storyboard replacement touches
`storyboard_scenes` plus an FK `FOR KEY SHARE`. **No path takes a
`SceneGeneration` conflicting lock before a `MediaAsset` one**, and
`SceneGeneration` has no FK to `MediaAsset` (`assetId` is un-foreign-keyed
provenance), so a generation `UPDATE` takes no implicit asset lock. No cycle.

The asset lock is the **serialization barrier**. The licence **linearizes at
transaction commit**, after the lock was held, the source validated, the identity
matched and the CAS won. Holding the lock is not a claim; an uncommitted
`SUBMITTING` row is not one either.

## Consequences

- No public route reaches `SUBMITTING` without stating which bytes are submitted.
- A deletion committed before the claim is seen by it; a deletion attempted
  during the claim waits, and afterwards does **not** revoke the issued licence.
  There is no post-claim cancellation.
- Two generations sharing one asset serialize on that row and both may claim.
- A claimant that waited on the lock reports `NOT_CLAIMABLE`, not a stale source
  verdict.
- The repository now contains raw SQL. Bounded to one private statement.

**No schema change and no migration.** Still production-dormant: zero production
callers, no worker loop, no paid gate, no provider call.

## Recorded

**ADR-0029 remains the authority on post-claim byte stability.** This milestone
orders the claim against concurrent writers; it does not change what may happen
to the object afterwards. That argument is still a property of today's lifecycle
and writer inventory, still pinned only by a test-only regression guard, and
still invalidated by any future in-place reprocessing feature.

**A future cancellation must carry an expected-state predicate.**
`SceneGenerationRepository.update` has none, so an unconditional write landing
after this transaction commits will overwrite `SUBMITTING` regardless of any lock
taken here. Already recorded in `docs/decisions/TODO.md`; unchanged by A-2b.

## Alternatives rejected

**Keeping `claimQueuedForSubmission` as a deprecated overload.** Zero production
callers meant no migration cost to avoid, and the only thing it would preserve is
the ability to spend money without naming a source.

**`FOR UPDATE`.** Strictly stronger and simpler to justify, but measured to block
FK-referencing storyboard inserts for the duration of every claim, for no safety
gain over `FOR NO KEY UPDATE`.

**Locking the generation row too.** Would make step 4 unnecessary, at the cost of
a second conflicting lock in the opposite order from `ReviewTransaction`'s asset
lock — the shape that produces deadlocks. The plain re-read is sufficient at READ
COMMITTED and takes no lock.

**Parking the row on `SOURCE_INVALID` inside the claim.** Convenient, and it
would merge two decisions that must stay separate: this method reports what it
found, and whether that becomes a durable failure is a policy question with its
own compare-and-swap.
