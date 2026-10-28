# ADR-0096 — The legacy executor leaves orchestrated attempts alone, and the gate moves only the source it locked, audited

Status: Accepted (GS-7c-1, 2026-10-28). Third of five pull requests for row GS-7
of the generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`). GS-7c is split in two:
this pull request fixes the boundary an orchestrated attempt crosses, and
GS-7c-2 sends it.
Builds on: ADR-0029 (the prepared source identity), ADR-0030 (the legacy claim
locks the source asset and compares it to the prepared one), ADR-0091 (the gate
reads revenue on its own session), ADR-0095 (the launch commit admits each
scene's first attempt `QUEUED`), and the Phase 4C-3B-2E compare-and-set the gate
arms with.

## Context

An orchestrated attempt is admitted `QUEUED` in its orchestration state and
keeps the legacy `state` column at its default, `QUEUED`, for life: no
orchestration writer moves that column. The legacy executor discovers, claims
and parks by that column alone, so were it run it would claim an orchestrated
attempt and send it outside the paid-submission gate (`docs/decisions/TODO.md`,
*Stop the legacy executor's discovery from offering orchestrated attempts*).

The gate decides `QUEUED → SUBMITTING` under the cost-admission lock, but it
never looked at the attempt's photo. Preparation signs a URL for the source it
observed; a deletion request or a re-processing committed after that, and
before the move, would be sent anyway. And nothing audits the paid call: the
admission's `generation.requested` entry is written after the row
(ADR-0024 §4), so a failed audit sink leaves executable work with no entry
(*The milestone that adds provider submission MUST audit the paid call
itself*).

## Decision 1 — The legacy executor is legacy-only

`findNextQueuedForPreparation`, `claimPreparedForSubmission` and
`failQueuedPreflight` act only on a row whose `state` is `QUEUED` **and** whose
`orchestrationState` is null:

- discovery filters on both, so an orchestrated attempt is never offered and the
  legacy row behind it is;
- the claim refuses an orchestrated row before it locks the asset, again after
  the asset lock, and in its compare-and-swap predicate. It answers
  `NOT_CLAIMABLE` and writes nothing, and does not wait on an orchestrated
  attempt's asset;
- the park's compare-and-swap names both columns and answers `null` for an
  orchestrated row, writing nothing.

The check is in all three places because each reads at a different instant. An
attempt's orchestration columns are written at admission and never cleared (the
all-or-none check constraint), so today a row cannot become orchestrated while a
claim works on it; the tests make one so underneath the application, to prove
the later checks hold on their own.

## Decision 2 — The gate locks the source and finds it the one prepared

`AuthorizePaidSubmissionInput` gains `source`, the `PreparedSourceIdentity`
preparation signed a URL for. After the pure gate permits the move, and before
the compare-and-set, the session locks the attempt's asset and its project's
Property, in one statement (`lockSource`):

```text
cost-admission advisory lock (organization, cycle)
  -> GenerationReservation            FOR SHARE
  -> facts, revenue, the instant, the pure gate
  -> MediaAsset (the attempt's)       FOR NO KEY UPDATE
     Property (its project's)         FOR SHARE
  -> SceneGeneration                  compare-and-set QUEUED -> SUBMITTING
  -> AuditLog                         insert
  -> commit
```

The asset is found through the attempt's project in the caller's organization,
and it and the Property must be that organization's too. The locked asset is
read through the same conversion the legacy claim uses and judged by the same
classifier preparation uses (`classifyExecutionSource`), so the gate cannot
accept a source preparation would refuse. Then:

| Found | Answer |
| --- | --- |
| no such asset in the organization | `SOURCE_INVALID` `ASSET_NOT_FOUND` |
| the project's Property deleted | `SOURCE_INVALID` `PROPERTY_DELETED` |
| deletion requested, not ready, upload failed, unrecoverable, not the normalized JPEG, or no usable digest | `SOURCE_INVALID` with the classifier's reason |
| usable, but its key, MIME type or digest not the prepared source's | `SOURCE_INVALID` `ASSET_SOURCE_CHANGED` |
| the prepared source | the compare-and-set |

A deleted Property is answered before the asset is judged. A Property is
deleted in one statement and its photos are asked to be deleted after it, one
statement each, so a photo can read usable under a deleted Property while the
deletion runs, and for good if it stops part way. The start and the launch
refuse a deleted Property's project under the same `FOR SHARE` (ADR-0088,
ADR-0095); the gate, the last check before money is spent, refuses it too.

`FOR NO KEY UPDATE` on the asset is the lock the legacy claim takes (ADR-0030),
and `FOR SHARE` on the Property is the lock the start and the launch take. A
deletion committed before the lock is seen and refused; one in flight is
waited for and then seen; one made after the lock waits for the gate's commit.
Neither lock conflicts with the `FOR KEY SHARE` a storyboard scene or an
analysis row takes for its foreign key on the asset, or with another reader's
`FOR SHARE` on the Property.

A deletion requested after the gate's commit does not stop the attempt: the
move has committed, and the send follows it. This is the race ADR-0030
accepted for the legacy claim, now as narrow as one commit to one request.

The source is locked last, after every refusal that needs no lock, so a gate
that will refuse on price or revenue never holds a customer's photo. A
refusal writes nothing, as every gate refusal does.

**The lock order.** No transaction that holds an asset or a Property lock
waits for the cost-admission lock, a reservation or an attempt: every asset
write is one statement or its transaction's last lock (the analysis review
writes the analysis, then the asset), the Property deletion is one statement,
the Property assignments take nothing the gate holds after the Property, and
Transactions F, H, K and L, the
settlements, the launch commit and media recovery lock no asset. So the gate's
order adds no cycle. It does bind every later transaction: none may lock an
asset or a Property and then wait for the cost-admission lock. A preparation
refusal parked under that lock (GS-7c-2) takes the lock first.

## Decision 3 — The paid call's audit entry commits with the move

When the compare-and-set moves the attempt, the session writes one audit entry
in the same transaction: action `generation.submission_started`, resource
`scene_generation` and the attempt id, the caller's actor, and as metadata only
internal ids (`generationJobId`, `requestKind`, `pricingSnapshotId`,
`correlationId`). No provider, model, prompt, storage key or price: an audit
trail may one day be shown to the customer.

So no attempt the gate moves reaches `SUBMITTING`, the only state from which
anything is sent, without its entry, and no entry describes a move that did not
commit. A failed audit insert rolls the move back. The action is fixed in the
service, not supplied by the caller, as the event type is; it joins
`generation.requested` in the generation audit vocabulary.

The attempt repository's own `armProviderBoundary` also moves an attempt to
`SUBMITTING`, with no lock, source check or audit entry. Integration tests use
it to build fixtures. A static test allows no caller of it in production, and
no caller of the within-transaction form other than the gate's session and that
method.

## Not decided here

- **Sending** (GS-7c-2): the discovery of `QUEUED` orchestrated attempts, the
  preparation and its signed URL, the URL's freshness checked before the call,
  the gate, the one POST, and the answer recorded.
- **Parking a preparation refusal** (GS-7c-2). The legacy park now leaves
  orchestrated attempts alone; a terminal refusal of an orchestrated attempt
  must end it in its orchestration state, under the cost-admission lock taken
  first, and a retryable one leave it `QUEUED`.
- **An attempt the gate refuses for good** (GS-7d). A deleted Property, a photo
  deleted or unrecoverable, or a permanently ineligible price leaves the attempt
  `QUEUED`, holding its Unit; what ends it, and releases the reservation, is not
  decided (`docs/decisions/TODO.md`). A photo changed but still usable is
  prepared again and is not such a case.

## Consequences

- `@app/domain`: `AuthorizePaidSubmissionInput.source`, the session's
  `lockSource` with `LockedPaidSubmissionSource`, the arm's `audit`, the
  outcome `SOURCE_INVALID` with `SourceAuthorizationFailure`,
  `PAID_SUBMISSION_AUDIT_ACTION` and `GenerationAuditAction.SubmissionStarted`.
- `@app/database`: the gate's session locks and reads the source and its
  Property and writes the audit entry; the legacy executor's discovery, claim
  and park are legacy-only.
  `toExecutionSourceObservation` and its row type are exported within the
  package for the gate and stay unpublished.
- No migration. Nothing outside tests constructs the gate or the legacy
  executor, so no path a customer or a worker reaches changes.
