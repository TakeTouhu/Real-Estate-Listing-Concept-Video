# ADR-0026: Immutable execution preflight

Status: Accepted (Phase 4C-2A)
Date: 2026-08-19

## Context

ADR-0024 made the `SceneGeneration` row the durable queue and ADR-0025 supplied
the system-scoped port that discovers and claims one. Between those two steps
sits work that has to happen *before* a row is claimed: reconstructing the
admitted request, resolving the source photo, and producing a URL the provider
can fetch.

ADR-0025 §3 already decided that this work happens **before** the claim, not
after, because `SUBMITTING` is the state whose only honest recovery parks work
for a human. This ADR decides what that preparation actually is.

## Decision

### 1. Preflight changes nothing

`prepareQueuedGeneration` returns while the row is still `QUEUED`. It performs no
state transition, writes no asset, and persists nothing.

This is structural rather than disciplinary: `ExecutionPreflightDeps` carries an
asset repository, object storage and a capability provider, and **no generation
repository at all**. There is no object in scope that could move the row. A
compile-time assertion pins that the dependency type declares no `generations`,
`execution`, `provider` or `queue` key.

Two workers may prepare the same row concurrently. That is safe and expected —
one loses the later compare-and-swap, having spent a signed URL and some
assembly, neither of which is billable.

### 2. The prepared artifact is domain-owned

`PreparedGeneration` lives in `@app/domain` and deliberately is **not**
`ProviderGenerationInput`.

That type lives in `@app/video-providers`, which depends on `@app/domain`.
Importing it here would invert the dependency and create a cycle, so
`packages/domain/package.json` keeps `@app/shared` as its only dependency. The
overlap between the two types is shape, not logic: the adapter boundary builds
the provider-shaped request, and this is the domain's description of what such a
request must be made of.

### 3. Every value is frozen or freshly derived — never current

The prompt and the four request settings come from the row's own immutable
snapshot (ADR-0018) and frozen prompt (ADR-0023). Nothing reads the current
storyboard scene, the project's present `aspectRatio`/`resolution`, or the
asset's real dimensions. All three are mutable after admission, and any of them
could change what is submitted **under a `requestHash` that still validated** —
paying for a request the customer never approved.

The source URL is the exact opposite: derived at preparation time and never
persisted, because a stored credential outlives the reason it was issued
(ADR-0018 §6).

**The stored hash is verified, not trusted.** `computeGenerationRequestHash` is
re-run over the reconstructed facts and compared with the stored value. They are
written together at admission and nothing may edit them afterwards, so
disagreement means the row was altered — and that hash is the identity that
stops a provider being paid twice.

### 4. Tenancy is proven by the ordinary scoped repository

Preflight uses the tenant-facing `MediaAssetRepository` with the
`organizationId` ADR-0025 resolved through `VideoProject`. It does **not**
introduce a system-scoped asset port.

Ownership is therefore *proven* rather than asserted: an asset belonging to
another tenant comes back `null` from the scoped read, with no cross-tenant row
ever loaded. A second trusted boundary here would repeat exactly what ADR-0025
§1 rejected — and unlike execution discovery, this caller already knows its
organization, so it has no reason to hold one.

### 5. Refusals are classified, and none of them can mean "we were charged"

Failures raise `PreflightRefusalError` carrying a machine-readable
`PreflightRefusalReason` from a closed set. Phase 4C-2B maps those to durable
states and Phase 4C-3 decides what a worker does next; both need something
stable to switch on, and matching on prose is how a refusal quietly changes
meaning under a reworded string.

Every reason uses `INTERNAL_ERROR`. Nothing a customer submits reaches preflight
— a worker is reading rows nobody asked it about — so surfacing any of this as a
422 would be a lie about whose mistake it was, the same argument
`assertTransition` already makes.

**`retryable` does not mean "leave it `QUEUED` and try again".** Both
dispositions park the work. The flag records whether a later, explicit retry
policy *could* legitimately re-queue the row, and the split is by whether the
world could change — a processing asset may become `READY`, a missing frozen
prompt never appears. An automatic loop reading this flag would be inventing the
policy rather than reading it.

### 6. The source URL has its own TTL

`PREFLIGHT_SOURCE_URL_TTL_SECONDS = 600`, deliberately separate from
`DOWNLOAD_URL_TTL_SECONDS = 300`. The latter is sized for a human clicking a
link; this one must cover preparation, the claim, the submission POST **and the
provider's own fetch of the image**. `sourceUrlExpiresAt` is returned so a
submitter can refuse a stale URL rather than pay for a request whose image
cannot be fetched.

## Consequences

**A window remains between the asset check and the signed URL.** An asset can
move to `DELETION_PENDING` after preflight reads its status and before the URL
is signed, so a URL may be issued for an asset whose deletion has just been
requested. This is accepted rather than closed: re-reading after signing narrows
the window without eliminating it, and the failure mode is a fetch that returns
nothing rather than a wrong image being generated. Checks are ordered so that
nothing is signed for an asset already known to be unusable.

**Full capability re-validation is not possible from the snapshot.** Preflight
verifies that the deployment still serves the admitted `providerName` and
`providerModelId`, but cannot re-run `assertSettingsSupported`, because that
needs a discrete `negativePrompt` and the snapshot stores only the opaque
compiled prompt. A capability table edited under an unchanged model id would
therefore go unnoticed here. Recorded in `docs/decisions/TODO.md`.

**Nothing calls this yet.** Production-dormant by design, like Phase 4C-1b.

## Alternatives rejected

**Claim first, then prepare** — see ADR-0025 §3. Widens the `SUBMITTING` window
from one provider call to an entire preparation sequence.

**Import `ProviderGenerationInput` into the domain** — see §2. A dependency
cycle, in exchange for avoiding a type that describes something genuinely
different.

**A system-scoped asset port** — see §4. Unnecessary, because the tenant is
already resolved, and it would widen the trusted surface for no gain.

**Returning a nullable result instead of throwing** — a refusal carries a reason
that a later milestone must act on, and `null` would collapse nine distinct
dispositions into one.
