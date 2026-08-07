# ADR-0016: Scene generation state, local idempotency, and ambiguous provider submission

Status: Accepted (Phase 4A-1)
Date: 2026-08-07

## Context

Phase 4 generates the first real scene through a video provider. Every earlier
phase moved only our own data; this one spends money on someone else's API, and
the failure modes are different in kind rather than degree.

Three facts about the merged repository shaped this decision.

**Storyboard scenes are ephemeral.** `StoryboardService.compose` writes through
`replaceForProject`, which deletes every scene row for a project and re-inserts
them with freshly generated ids. Recomposition is a routine operation — a
reviewer corrects a room, approves another photo, and composes again. So a
storyboard scene row is not a stable anchor for anything that must outlive it.

**A generation attempt may already have been paid for.** Once a submission POST
leaves the process, the money may be spent whether or not we learn the outcome.
That makes a generation record a *financial* record, not merely a workflow row.

**The provider cannot promise exactly-once submission.** WaveSpeedAI explicitly
warns against blindly retrying generation submissions: a connection failure can
occur *after* the prediction was accepted and billed. No idempotency key is
exposed that would make a retry provably safe.

## Decision

### 1. Scene generation is a persistent attempt and history entity

One row per attempt to generate one scene, persisted in Phase 4A-2. It records
what was requested, what happened, and — from Phase 4D — where the managed
output landed. It is not a cache and not a transient work item.

### 2. No foreign key to `StoryboardScene`

Because recomposition deletes scene rows, an FK would force a choice between
two unacceptable outcomes: `onDelete: Cascade` silently destroys the record of a
paid external call, and `onDelete: Restrict` makes recomposition fail whenever
any generation exists, blocking a routine product operation. `SetNull` is
unavailable because the composite-FK form the Phase 3C tenant model uses would
have to null a required column too.

Referential integrity is the wrong tool for a row the system deliberately
deletes on a normal operation. There is no FK.

### 3. The scene id is provenance only

The field is named `sourceStoryboardSceneId` so its non-relational meaning is
unmistakable at every call site. It records which composition the attempt came
from; it is not dereferenced, not joined, and not required to exist.

Alongside it the attempt carries the minimum facts that make it understandable
without that scene: `assetId`, `sourceAnalysisRevision`, `requestHash`,
`providerName`, `providerModelId`. That is a provenance record, not a scene
snapshot and not an event-sourced log — position, room type, and duration are
not copied, because `requestHash` already fixes everything that decides what
would be generated.

### 4. Tenant ownership comes through `VideoProject`

`VideoProject` is persistent and already carries `organizationId`, so reads
scope through the relation exactly as `StoryboardScene`'s do. No
`organizationId` column is denormalized onto the generation row, and in
particular none is added to compensate for the absent scene FK.

### 5. Local identity is `(videoProjectId, requestHash)`

`requestHash` digests exactly the facts that decide what would be generated:
`assetId`, `compiledPrompt`, `durationSeconds`, `cameraMotion`, `aspectRatio`,
`resolution`, `providerName`, `providerModelId` — as a fixed-order tuple,
`JSON.stringify`d and SHA-256'd, returned as `sha256:<hex>`, following the
`computeCompositionFingerprint` discipline.

Deliberately excluded, each for a reason:

| Excluded | Because |
| --- | --- |
| scene position | reordering does not change the media generated from a photo |
| `sourceAnalysisRevision` alone | a refresh yielding the same prompt is the same request |
| `storyboardSceneId` | recomposition changes it while the request is unchanged |
| timestamps, tenant and user ids | the identity is already scoped by `videoProjectId` |
| prediction id, temporary output URL | outputs of a request, not inputs to it |

`compiledPrompt` means the persisted canonical structure, compared textually.
No semantic prompt equivalence is attempted, and no renderer-versioning
framework is built. If Phase 4B finds that a renderer change can alter what
reaches the provider while the stored prompt is byte-identical, Phase 4B may add
a narrowly justified request-version fact to this contract.

### 6. Active identity includes `FAILED_RETRYABLE` and `SUBMISSION_UNKNOWN`

The states that still hold the identity are:

```
QUEUED · SUBMITTING · PROCESSING · FAILED_RETRYABLE · SUBMISSION_UNKNOWN
```

`FAILED_RETRYABLE` is active because it can return to `QUEUED`; releasing the
identity there would let a second job be created alongside one that is still
going to submit — the exact duplicate-submission path this design exists to
prevent. `SUBMISSION_UNKNOWN` is active because the provider may already hold a
billed prediction for that request.

Terminal states — `SUCCEEDED`, `FAILED_TERMINAL`, `CANCELLED` — release the
identity, so a deliberate later regeneration can create a new job. Whether an
identical request against a `SUCCEEDED` job should reuse that output rather than
start a new attempt is application policy for Phase 4B, not a database
invariant.

Phase 4A-2 enforces this with a partial unique index on
`(videoProjectId, requestHash)` over exactly that active set. Prisma cannot
express a partial index, so it is hand-written SQL under the discipline
established in Phase 3B-1a, and a test pins the domain's exported active set so
the SQL predicate cannot drift away from it silently.

### 7. `SUBMISSION_UNKNOWN` is first-class and forbids automatic POST retry

A submission that times out, is reset, is dropped before a prediction id is
obtained, or returns a response from which acceptance cannot be ruled out, is
**not** an ordinary retryable error. It becomes `SUBMISSION_UNKNOWN`, which has
**no automatic outgoing transition at all** — not to `QUEUED`, not to
`SUBMITTING`, and not to `PROCESSING`, because asserting a prediction id we
never received would be worse than stopping.

This is why the failure vocabulary is not one `FAILED_RETRYABLE` bucket. The
four ways a submission ends are distinct because their financial consequences
are distinct:

| Situation | State | Automatic retry |
| --- | --- | --- |
| failed before any POST | stays `QUEUED` | yes, no provider risk |
| positive evidence the POST was **not** accepted | `FAILED_RETRYABLE` | yes, via `QUEUED` |
| acceptance cannot be ruled out | `SUBMISSION_UNKNOWN` | **never** |
| provider rejected it terminally | `FAILED_TERMINAL` | no |

Once a prediction id is known the job is `PROCESSING`, and a failing status GET
is retried in place rather than becoming a state change — GET is idempotent, so
there is deliberately no edge from `PROCESSING` that could tempt anyone into
resubmitting.

### 8. Local idempotency is not provider exactly-once

What this architecture guarantees:

- one active **local** job per generation request identity;
- database-enforced local concurrency protection (Phase 4A-2);
- no automatic duplicate POST from an ambiguous submission;
- provider polling only after a prediction id is known.

What it cannot guarantee is that the provider is charged exactly once, because
the external API offers no idempotency mechanism that would make a retry
provably safe. No comment, document, or report in this repository claims
otherwise.

### 9. Prediction ids and temporary provider URLs are internal-only

`providerPredictionId` is persisted for polling and support; the temporary
output URL is deliberately **not** persisted at all — Phase 4D copies the output
into managed storage on completion rather than storing a URL that expires.
Neither appears in a customer-facing DTO, and neither is logged. This continues
the response-hygiene discipline Phase 3 applied to storage keys, fingerprints,
and compiled prompts.

### 10. Webhook is deferred; bounded polling is the Phase 4 completion path

WaveSpeedAI documents polling as a supported task-completion mechanism, so
bounded polling is sufficient for the shortest sellable path. Authenticated
webhook support is not implemented and no milestone is reserved for it. It is
reconsidered only if the provider requires it, polling limits make it
operationally unsuitable, scale or cost make it materially beneficial, or a
product latency requirement cannot be met by polling.

### 11. Ambiguity may need a human

Because `SUBMISSION_UNKNOWN` has no automatic exit **and** holds the identity, a
single network failure during submission blocks that scene from being generated
again until someone resolves it. That is deliberate — never automatically
duplicate a possibly-billed call — but it is a real operability cost, not a free
safety property. The resolution path is operator reconciliation against the
provider, recorded in `docs/decisions/TODO.md` and not implemented here.

### 12. No credit ledger in Phase 4A

There is no credit system to settle against, and none is invented. Phase 4A
provides duplicate-paid-call protection, which is a different thing from billing
settlement. Credit accounting remains Phase 6 unless the architecture later
proves it must move earlier.

## Consequences

- A generation record survives recomposition, re-analysis, and correction, so
  the history of what was actually sent to a provider is never quietly lost.
- A recompose that does not change the request facts does not manufacture a new
  request identity, so it cannot cause a second charge.
- Two colleagues asking for the same scene at the same moment produce one job:
  the loser of the race gets a unique violation from PostgreSQL rather than a
  second POST.
- An ambiguous submission stops the line for that scene until a human looks. We
  accept a stalled scene over a duplicate charge.
- Terminal states cannot be revived, so "regenerate" always means a new row and
  the previous attempt's record stays intact.

## Scope

Phase 4A-1 implements the state vocabulary, the transition contract, the
active/terminal sets, and `computeGenerationRequestHash`. It adds no schema, no
migration, no repository, no provider call, no queue, no worker, and no HTTP or
UI surface.

The production model is **not** selected here. Which WaveSpeedAI model the
product ships on — and whether it can satisfy the aspect-ratio, negative-prompt,
and duration contracts — is Phase 4B's provider-fit review.
