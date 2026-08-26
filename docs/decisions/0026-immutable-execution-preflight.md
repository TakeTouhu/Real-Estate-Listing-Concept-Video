# ADR-0026: Immutable execution preflight

Status: Accepted (Phase 4C-2A)
Date: 2026-08-21

## Context

ADR-0024 made the `SceneGeneration` row the durable queue and ADR-0025 supplied
the system-scoped port that discovers and claims one. Between those two steps
sits work that has to happen *before* a row is claimed: reconstructing the
admitted request, resolving the source photo, and producing a URL the provider
can fetch.

ADR-0025 §3 already decided that this work happens **before** the claim, because
`SUBMITTING` is the state whose only honest recovery parks work for a human.
This ADR decides what that preparation is.

## Decision

### 1. Preflight changes nothing, structurally

`prepareQueuedGeneration` returns while the row is still `QUEUED`. It performs no
state transition, writes no asset, and persists nothing — and that is enforced
rather than promised, in two ways.

**No generation repository is in scope**, so nothing could move the row. A
compile-time assertion pins that the dependency type declares no `generations`,
`execution`, `provider` or `queue` key.

**Each remaining dependency is narrowed with `Pick`** to the capability
preparation uses — `assets` to `findById`, `storage` to `exists` and
`createSignedDownloadUrl`. Holding the whole `MediaAssetRepository` and
`ObjectStorage` meant only a comment said preflight would not call `update` or
`deleteObject`. `createSignedUploadUrl` is excluded deliberately: an upload URL
is a write credential. `getObject` is excluded too — preflight proves the object
exists and lets the provider fetch it, rather than pulling image bytes through
this process. Widening either back fails to compile.

Two workers may prepare the same row concurrently. That is safe and expected —
one loses the later compare-and-swap, having spent a signed URL and some
assembly, neither of which is billable.

### 2. The prepared artifact is domain-owned

`PreparedGeneration` lives in `@app/domain` and deliberately is **not**
`ProviderGenerationInput`. That type lives in `@app/video-providers`, which
depends on `@app/domain`; importing it here would invert the dependency and
create a cycle, so `packages/domain/package.json` keeps `@app/shared` as its
only dependency. The overlap is shape, not logic.

### 3. The immutable snapshot is the only request authority

The prompt and the four request settings come from the row's own snapshot
(ADR-0018) and frozen prompt (ADR-0023), through `generationRequestFactsFrom`
and `frozenExecutionPromptFrom`. Preflight never reads the current
`StoryboardScene`, the project's present `aspectRatio`, `resolution`, duration
or camera motion, never re-derives the compiled prompt, and never calls
`renderPrompt`. All of those are mutable after admission, and any of them could
change what is submitted **under a `requestHash` that still validated** — paying
for a request the customer never approved.

**The stored hash is verified, never repaired.** `computeGenerationRequestHash`
is re-run over the reconstructed facts and compared for exact equality.
Disagreement means the row was altered, and that hash is the identity that stops
a provider being paid twice — so a row whose identity is already lost is refused
(`REQUEST_HASH_MISMATCH`, terminal) rather than having a new one written over it.
Nothing recomputed is persisted.

### 4. Tenancy is proven by the ordinary scoped repository

Preflight uses the tenant-facing `MediaAssetRepository` with the
`organizationId` ADR-0025 resolved through `VideoProject`, and addresses it by
the *frozen* `assetId`. It introduces **no system-scoped asset port** and takes
no separate organization argument.

Ownership is therefore *proven*: an asset belonging to another tenant comes back
`null`, with no cross-tenant row ever loaded. A second trusted boundary here
would repeat what ADR-0025 §1 rejected — and unlike execution discovery, this
caller already knows its organization.

### 5. Capability validation is identity-only, and says so

`deps.capabilities.current()` is called exactly once, and only `providerName`
and `providerModelId` are compared against the admitted facts. A mismatch is
`PROVIDER_IDENTITY_MISMATCH`, terminal: a different model has a different price
and a different result, which is why both are inside the request hash.

**This is not a re-validation of the capability table**, and the code does not
claim to be one. `assertSettingsSupported` needs a discrete `negativePrompt`
that the snapshot does not store, and fabricating `negativePrompt: null` would
silently skip a check admission actually made. A capability edited under an
*unchanged* provider and model therefore passes here. That gap is recorded in
`docs/decisions/TODO.md` as a hard prerequisite before real provider spending.

### 6. Source-asset classification

One criterion decides all ten `MediaAssetStatus` values:

> Can this **same** `MediaAsset` identity become an executable `READY`
> normalized source later, without changing the admitted generation's `assetId`?

It deliberately says nothing about whether that happens on its own.

| Statuses | Reason | Disposition |
| --- | --- | --- |
| `READY` | — | executable, subject to the checks below |
| `PENDING_UPLOAD`, `UPLOADED`, `SCANNING`, `PROCESSING` | `ASSET_NOT_READY` | RETRYABLE |
| `FAILED` | `ASSET_UPLOAD_FAILED` | RETRYABLE |
| `QUARANTINED`, `REJECTED`, `DELETION_PENDING`, `DELETED` | `ASSET_UNRECOVERABLE` | TERMINAL |

**None of the recoverable statuses resolves by itself.** `PENDING_UPLOAD` may be
waiting on a customer's client; `FAILED` moves only when someone calls
`AssetService.retryUpload`. Both can reach `READY` under the same id, which is
the whole test. Review of this milestone found `FAILED` grouped with deleted and
quarantined assets, which would have permanently failed an attempt whose photo
was one customer action away.

`ASSET_UNRECOVERABLE` is named for what it means rather than for deletion:
quarantined and rejected content still exists. A non-null `deletionRequestedAt`
overrides the status to unrecoverable, because retention can be requested before
the status catches up.

**One `Record<MediaAssetStatus, AssetExecutability>` in production is the whole
classification** — the only exhaustive map of these states anywhere. Adding a
status fails to compile until it is classified; the tests keep no copy, because
a second map could drift from the first while both stayed green.

### 7. A `READY` asset still has to be a usable source

After `READY` is proven, two invariants:

- **`mimeType` is exactly `image/jpeg`.** The media pipeline normalizes every
  accepted upload to JPEG, so a `READY` asset that is not one is not the
  normalized master. The original upload object and `thumbnailKey` are both
  excluded — the thumbnail is a downscaled derivative, and paying to animate it
  would be a silent quality substitution.
- **`storageKey.trim()` is non-empty**, because a blank key is not addressable.

Either failure is `ASSET_FORMAT_UNSUPPORTED`, terminal, and it happens **before**
storage is touched at all.

### 8. Existence is asked, not assumed

`storage.exists` is called with the exact validated key. `false` is
`ASSET_OBJECT_MISSING`, terminal, and nothing is signed — a `READY` asset whose
object is gone is otherwise found by the provider, after the charge. A rejected
call is `STORAGE_UNAVAILABLE`, retryable: that says something about storage, not
about the asset.

### 9. The signed URL is validated before it is handed over

Signing uses the exact validated key and `PREFLIGHT_SOURCE_URL_TTL_SECONDS`. The
result is then checked: the URL must parse, its protocol must be exactly
`https:`, its hostname must be non-empty, and `expiresAt` must be a `Date` whose
time is finite. Anything else is `SIGNED_SOURCE_URL_UNUSABLE`, retryable —
storage is trusted to sign, not to be correct, and each of these would otherwise
be discovered by the provider after the request was paid for.

**Freshness is deliberately not checked here.** Whether the URL is still valid
*now* is only meaningful immediately before the paid POST; Phase 4C-3 owns it.

`expiresAt` is propagated exactly as storage returned it, never computed, so it
cannot drift from what was actually issued. Neither the URL nor the expiry is
persisted. `LocalObjectStorage` is unchanged by this milestone.

### 10. The source URL TTL

`PREFLIGHT_SOURCE_URL_TTL_SECONDS = 600`, deliberately separate from
`DOWNLOAD_URL_TTL_SECONDS = 300`. The latter is sized for a human clicking a
link; this must cover preparation, the claim, the submission POST **and the
provider's own fetch**. **Provisional** until Phase 4C-3's paid-call review
measures it against a real submission.

### 11. Sign, then look again

The last thing preparation does is read the asset a **second** time, with the
same authoritative `organizationId` and the same frozen `assetId`, reusing the
same classification. The full order is:

```
QUEUED → facts → frozen prompt → verify hash → capability once → identity
     → asset read #1 → classify → READY → JPEG + non-blank key
     → storage.exists → sign → validate URL and expiry
     → asset read #2 → classify → same key and MIME → return
```

Signing takes time, and an asset can change during it. Returning immediately
after signing would hand a caller a credential for a source already deleted or
replaced. On the second observation: `null` is `ASSET_NOT_FOUND`; a non-`READY`
classification produces the same reason it would have on the first read; and a
`READY` asset whose `storageKey` or `mimeType` differs from the validated ones is
`ASSET_SOURCE_CHANGED`, terminal — the bytes behind the admitted id were
replaced, and the URL just signed points at what the old key held.

The already-signed URL is not revoked. It is discarded: never persisted, never
logged, and it expires on its own.

### 12. Refusals are classified, and none can mean "we were charged"

Thirteen reasons in a closed set, each `INTERNAL_ERROR`. Nothing a customer
submits reaches preflight — a worker is reading rows nobody asked it about — so
a 422 would be a lie about whose mistake it was, the same argument
`assertTransition` makes.

**Disposition is derived, never supplied.** One exhaustive
`Record<PreflightRefusalReason, PreflightDisposition>` is the canonical answer,
exposed through `preflightDispositionFor`. There is no `retryable` boolean, no
second retryable list and no terminal list: two sources would disagree
eventually, and the one deciding whether customer work is permanently failed is
the wrong place to find that out.

`RETRYABLE` means exactly one thing: a later *explicit* policy could try this
generation again once the world has changed. Phase 4C-2B parks a retryable
refusal in `FAILED_RETRYABLE` and a terminal one in `FAILED_TERMINAL`; **both are
parked.** No automatic loop, no timer, no leaving the row `QUEUED`.

### 13. A refusal is safe to log whole

`PreflightRefusalError` accepts **no cause**, so a raw infrastructure error can
never ride along inside it — storage SDK errors routinely carry request URLs,
keys and credentials in their messages. Every message is fixed text chosen at
the throw site, and the only detail is the reason. No signed URL, storage key,
credential, prompt, compiled prompt, request hash, organization id, asset id or
provider payload is retained.

**Only the expected fail-closed refusal is translated.** `generationRequestFactsFrom`
and `frozenExecutionPromptFrom` refuse legacy rows with `AppError` /
`INTERNAL_ERROR`, detected by type and code — never by matching message text. A
`TypeError`, `RangeError` or any other programmer error escapes unchanged, because
relabelling it `LEGACY_SNAPSHOT_MISSING` would tell a future durable mapper to
permanently fail customer work over a defect in this code.

## Consequences

**A residual asset race remains, and this milestone does not close it.** The
guarantee is precisely: *at the final asset observation before
`PreparedGeneration` is returned, the source is still the same usable `READY`
source that was signed.* Nothing stronger. This sequence is still possible:

```
PreparedGeneration returns → deletion is requested → QUEUED → SUBMITTING claim
    → generation.submission_started audit → provider POST
```

Phase 4C-2A does **not** close deletion atomically, deletion does **not**
necessarily make the signed URL return 404, and the second read alone does
**not** make a paid provider POST safe. Closing this is a hard Phase 4C-3
paid-call prerequisite, recorded in `docs/decisions/TODO.md`.

**Capability re-validation is identity-only** (§5). A capability table edited
under an unchanged provider and model is not detected here.

**Nothing calls this yet.** Production-dormant, like Phase 4C-1b. Preflight holds
no authority over generation state; Phase 4C-2B maps refusals to durable states.

## Alternatives rejected

**Claim first, then prepare** — ADR-0025 §3. Widens the `SUBMITTING` window from
one provider call to an entire preparation sequence.

**Import `ProviderGenerationInput` into the domain** — §2. A dependency cycle.

**A system-scoped asset port** — §4. Unnecessary, and it would widen the trusted
surface for no gain.

**Sign and return immediately** — §11. Cheap to check again; the check is the
difference between narrowing the window and ignoring it.

**A `retryable` boolean on the error** — §12. It invited "retry now", and a
second list beside the canonical map is a second answer waiting to disagree.

**Fabricating `negativePrompt: null` to re-run `assertSettingsSupported`** — §5.
Would silently skip a real check and report full revalidation that did not happen.
