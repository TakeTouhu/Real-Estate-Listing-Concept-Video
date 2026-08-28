# ADR-0029: Prepared source identity and the executable-source digest

Status: Accepted (Phase 4C-3A-2a)
Date: 2026-08-28

## Context

Phase 4C-3A-2 needs a submission to prove that the bytes a provider will fetch
are the bytes preflight approved. Preflight already reads the asset twice — once
before signing a source URL and once after — and compares what it saw. Until now
it compared two fields: `storageKey` and `mimeType`.

**Those two fields cannot tell two different images apart.**
`buildAssetStorageKey` is deterministic in (organization, property, asset,
variant, extension), so every normalized JPEG ever produced for one asset lands
on the *same* key with the *same* MIME type. A re-processed source therefore
agrees with its predecessor on both, and the comparison passes over a genuinely
different image while a URL signed for the old bytes points at the new ones.

This is the same determinism that forced the ADR-0028 cleanup correction. It is a
property of the key scheme, not an accident.

`MediaAsset.sha256` already exists and already holds a digest of the normalized
content, so the missing check is available without a schema change. What was
missing was a decision about what to do when that column cannot be trusted.

## Decision

### 1. A domain-owned source identity, in its own module

`packages/domain/src/generation/execution-source.ts` — pure, with no repository,
storage, clock or exception in it.

```ts
export interface PreparedSourceIdentity {
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sha256: string;
}
```

Three fields and no fourth. It carries **no** signed URL, **no** expiry, **no**
`assetId`, **no** `organizationId`, **no** `requestHash` and **no** prompt.

`assetId` is absent even though including it would be convenient. The frozen
asset id lives on the `SceneGeneration` row, so Phase 4C-3A-2b's locked claim
reads it authoritatively inside its own transaction. A caller-supplied asset id
would be a way to aim a validation at a different asset than the one admitted —
the identity describes a source, it does not choose one.

The module exists rather than the logic living inside `prepareQueuedGeneration`
because A-2b's locked-row validation must reach exactly this decision procedure.
The alternative — a persistence adapter importing preflight orchestration, or
copying the status table — is how a claim ends up accepting a source preflight
would have refused.

### 2. One canonical classifier, one exhaustive status table

```ts
classifyExecutionSource(observation: ExecutionSourceObservation)
  : { kind: "USABLE"; identity } | { kind: "REFUSED"; reason }
```

The `Record<MediaAssetStatus, AssetExecutability>` moved here **unchanged** and
is still the only one in the system. The observation surface is five fields —
`status`, `deletionRequestedAt`, `storageKey`, `mimeType`, `sha256` — and
deliberately **not** a whole `MediaAsset`: A-2b will classify a row returned by a
locking `SELECT` that reads only the columns it asked for, and requiring a full
entity there would force either a second read or a half-populated object built to
satisfy a type.

Order is load-bearing:

1. **deletion intent**, which outranks status — retention can be requested while
   the row still reads `READY`, and checking it first means a deleted asset is
   never reported as "wrong format" or "changed";
2. **status**, through the exhaustive map;
3. **format** — a normalized JPEG at a non-blank key;
4. **digest usability**.

The returned `storageKey` is the durable string exactly as stored, never trimmed.
The key that gets signed must be the key the identity names; normalizing one of
them in passing would quietly make those two different strings.

### 3. The canonical digest format, pinned

`AssetService.completeUpload` produces the value with

```ts
sha256Hex(Buffer.from(processed.normalized).toString("base64"))
```

and `sha256Hex` is `createHash("sha256").update(input).digest("hex")` — an
**unprefixed lowercase hexadecimal digest, exactly 64 characters**. That producer
is left completely unchanged by this milestone: no re-hashing over raw bytes, no
migration, no backfill.

```
^[0-9a-f]{64}$
```

Null, empty, whitespace, 63 characters, 65 characters, uppercase `A-F`, a
`sha256:` prefix and any non-hex character are all refused. Pinning the exact
shape rather than accepting any non-blank string is only reasonable because the
producer is singular: a value in any other form was not written by this pipeline,
and comparing two such values would produce an equality that means nothing.

**What the digest is, stated precisely.** SHA-256 is a *collision-resistant*
content digest, not an injective function — no hash over arbitrary-length input
can be injective. Two different images agreeing on this value is not impossible,
it is computationally infeasible to arrange. The digest is therefore practical
evidence of content identity: strong enough to **detect** that a source changed,
and never a proof that bytes cannot change. (Base64 encoding before hashing is
itself deterministic and one-to-one, so it neither adds nor removes collisions;
it is simply what the current producer does.)

### 4. A fourteenth refusal reason

```ts
"ASSET_SOURCE_UNIDENTIFIABLE"   // TERMINAL → FAILED_TERMINAL
```

The vocabulary was thirteen from ADR-0026 through Phase 4C-2B and is now
fourteen. The single exhaustive reason → disposition `Record` is preserved — no
second list of terminal reasons — and the two-entry disposition → state `Record`
is untouched, so the new reason reaches `FAILED_TERMINAL` by derivation rather
than by being told to. `normalizedErrorCode` persists it verbatim through the
Phase 4C-2B contract, unchanged.

Two existing reasons were considered and rejected:

- **`ASSET_FORMAT_UNSUPPORTED`** is about MIME type and storage key. A missing
  digest is neither, and the durable code would send whoever reads it to the
  wrong question.
- **`ASSET_UNRECOVERABLE`** is defensible on the same-identity criterion — §6
  below shows a `READY` asset genuinely cannot gain a digest later — but its
  durable code is indistinguishable from quarantined or rejected **customer
  content**. This is a defect in our own pipeline, which writes `sha256` in the
  same statement that sets `READY`. Filing it under a content-policy code hides a
  bug behind a customer's file.

Terminal because nothing brings the digest back: a `READY` asset has no
production route into re-processing (§6), so a row lacking a canonical digest
will still lack one on every later attempt.

### 5. Preflight: first observation owns the identity

The first tenant-scoped read is classified in full — status, deletion intent,
format **and** digest usability — **before storage is touched**. A `READY` row
whose digest is missing or malformed causes:

- no `storage.exists` call,
- no `createSignedDownloadUrl` call,
- no second observation,
- no `PreparedGeneration`.

This is a durable source-integrity refusal, not a storage one, and nothing about
it becomes clearer by asking storage. Above all, no credential is minted for a
source that cannot be identified: the signed URL would name bytes nothing can
later prove are the ones preparation saw.

The identity from that first observation is the one carried on the returned
`PreparedGeneration`, because it names the exact source the URL was signed for.

The second read goes through the **same** classifier, so a row that became
deletion-pending, went back into processing, or lost its digest during signing is
refused with *that* reason rather than flattened into "changed". Only a row that
is independently usable is compared, and the comparison requires all three fields
to match. Any difference is `ASSET_SOURCE_CHANGED` — including the case this
milestone exists for: **same key, same MIME type, different valid digest.**

The returned identity is the **first** one, never rebuilt from the second. The
equality check proves the two agree, so both carry the same values — but the one
that belongs on the artifact is the one the URL was minted against, and returning
the later object would make that a coincidence rather than the contract.

**One behaviour change worth naming.** A second observation that is a valid but
non-JPEG source previously refused as `ASSET_SOURCE_CHANGED`; it now refuses as
`ASSET_FORMAT_UNSUPPORTED`, because it is classified on its own terms first. It
is not a different *usable* source, it is not a submittable source at all. Both
reasons are `TERMINAL`, so where the row parks is unchanged; only the durable
reason is more precise.

### 6. Post-claim source bytes are stable — under today's code, and only that

A claim proves source identity at claim time. That is worth nothing if a
production path can overwrite the same normalized object before the provider
fetches it. Inspection of the merged baseline says none can, and the argument is
closed over the writer inventory:

- The normalized object is written by **exactly one** production statement:
  `putObject(normalizedKey, …)` inside `completeUpload`.
- The only other production `putObject` is the signed-upload route, whose key
  comes from an HMAC-verified token — and both production
  `createSignedUploadUrl` sites mint tokens for the **`original`** variant. No
  upload credential can ever target the normalized key.
- `completeUpload` and `retryUpload` both accept only `PENDING_UPLOAD` and
  `FAILED` on entry.
- Out of `READY`, the only production transitions are `→ REJECTED`
  (`AnalysisService.reject`) and `→ DELETION_PENDING` (`requestDeletion`). Both
  are dead ends: neither is in either entry guard.
- ADR-0028's expected-status predicate means a stale in-flight writer cannot
  reassert ownership of a row that has moved on.
- The only production `deleteObject` caller is ADR-0028's derivative
  compensation, reachable only from `completeUpload`'s losing final write.
- No physical deletion worker exists, and nothing hard-deletes a `Property` or
  `MediaAsset` row, so the cascade never fires.

**Therefore a `READY` asset cannot re-enter the upload pipeline, and its
normalized object is neither rewritten nor removed.**

Two limits are stated rather than glossed:

- **The digest does not supply this.** Immutability comes from the lifecycle and
  writer inventory above. The digest lets preflight — and A-2b's locked claim —
  *detect* that a source changed. Writing "SHA-256 makes the bytes immutable"
  would be false.
- **This proves byte stability, not object availability.** A future retention
  worker could still delete the object out from under a `SUBMITTING` generation.
  That prerequisite is unchanged and still recorded (ADR-0028).

Because this is a property of today's code rather than a schema theorem, it is
pinned by a **test-only** regression guard: a `READY` asset must be refused by
both `completeUpload` and `retryUpload`, with no scan, no image processing, no
second normalized write, and no upload credential minted. `AssetService`
production code is unchanged.

### 7. Source identity is execution-time proof, not admission identity

`requestHash` is **unchanged**: the same eight facts, in the same order.
`sha256` is deliberately **not** a ninth. No schema column, no snapshot field, no
change to the partial unique index, no change to `computeGenerationRequestHash`
or `generationRequestFactsFrom`.

The two answer different questions. `requestHash` asks *which request is this*,
and two admissions of the same request are the same request even if the photo was
re-uploaded between them — that is what stops a provider being paid twice.
`PreparedSourceIdentity` asks *are these still the bytes we approved*, at the
moment of spending. Folding the digest into the hash would make every re-upload a
new billable request, which is a pricing change disguised as a safety fix.

The identity is ephemeral: not persisted, not written to `SceneGeneration`, not
in a request snapshot, and not in any audit entry, log line or error payload.

## Consequences

- A re-processed source under an unchanged deterministic key is now detected.
- A `READY` asset whose own metadata cannot identify it is refused terminally
  instead of being submitted.
- The refusal vocabulary is fourteen; the retryable set is unchanged at four.
- One classifier serves both preflight observations today and A-2b's locked row
  tomorrow, so the two cannot drift.
- No schema change and no migration.

## Recorded for Phase 4C-3A-2b

This milestone is **not** the claim. It supplies the identity the claim will
validate and the classifier the claim will call. Asset row locking, the
`QUEUED → SUBMITTING` compare-and-swap under that lock, the claim outcome union
and the raw `SELECT … FOR NO KEY UPDATE` all remain A-2b's work, and
`claimQueuedForSubmission` is untouched here.

## Recorded as a future invalidation risk

The §6 stability proof is a statement about the current implementation. Any
future feature that, for the **same** `MediaAsset` identity, permits:

- `READY → upload / retry / reprocess`;
- replacing normalized content in place;
- overwriting the deterministic normalized key;
- physical deletion while a generation may still need the source;

invalidates it, and must re-review paid-submission safety **before** shipping.
Possible remedies at that point include versioned or content-addressed normalized
keys, stronger retention ownership, or an explicit source lease. None is
implemented now, and none should be added speculatively.

## Alternatives rejected

**Hashing the object bytes at preflight time.** Would prove content directly
rather than trusting the row, but pulls every source image through this process
on every preparation — and `ExecutionPreflightDeps` deliberately does not hold
`getObject`, precisely so preparation cannot become a data path.

**Accepting any non-blank digest.** Cheap, and worthless: it would let two
meaningless values compare equal and report a source as verified.

**Changing the producer to hash raw bytes.** Tidier, and out of scope. It would
invalidate every digest in the database and require a backfill this milestone has
no reason to run. The current value is a deterministic function of the normalized
bytes, which is all the comparison needs.
