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
the compare-and-set, the session locks the attempt's asset (`lockSource`):

```text
cost-admission advisory lock (organization, cycle)
  -> GenerationReservation          FOR SHARE
  -> facts, revenue, the instant, the pure gate
  -> MediaAsset (the attempt's)     FOR NO KEY UPDATE
  -> SceneGeneration                compare-and-set QUEUED -> SUBMITTING
  -> AuditLog                       insert
  -> commit
```

The asset is found through the attempt's project in the caller's organization,
and must be that organization's too. The locked row is read through the same
conversion the legacy claim uses and judged by the same classifier preparation
uses (`classifyExecutionSource`), so the gate cannot accept a source preparation
would refuse. Then:

| Found | Answer |
| --- | --- |
| no such asset in the organization | `SOURCE_INVALID` `ASSET_NOT_FOUND` |
| deletion requested, not ready, upload failed, unrecoverable, not the normalized JPEG, or no usable digest | `SOURCE_INVALID` with the classifier's reason |
| usable, but its key, MIME type or digest not the prepared source's | `SOURCE_INVALID` `ASSET_SOURCE_CHANGED` |
| the prepared source | the compare-and-set |

`FOR NO KEY UPDATE` is the lock the legacy claim takes (ADR-0030). A deletion
request committed before it is seen here and refused; one made after it waits
for the gate's commit. It does not conflict with the `FOR KEY SHARE` a
storyboard scene or an analysis row takes for its foreign key.

The source is locked last, after every refusal that needs no lock, so a gate
that will refuse on price or revenue never holds a customer's photo. Nothing
that writes an asset waits for the cost-admission lock or a reservation, so the
order adds no cycle. A refusal writes nothing, as every gate refusal does.

## Decision 3 — The paid call's audit entry commits with the move

When the compare-and-set moves the attempt, the session writes one audit entry
in the same transaction: action `generation.submission_started`, resource
`scene_generation` and the attempt id, the caller's actor, and as metadata only
internal ids (`generationJobId`, `requestKind`, `pricingSnapshotId`,
`correlationId`). No provider, model, prompt, storage key or price: an audit
trail may one day be shown to the customer.

So no attempt reaches `SUBMITTING`, the only state from which anything is sent,
without its entry, and no entry describes a move that did not commit. A failed
audit insert rolls the move back. The action is fixed in the service, not
supplied by the caller, as the event type is.

## Not decided here

- **Sending** (GS-7c-2): the discovery of `QUEUED` orchestrated attempts, the
  preparation and its signed URL, the URL's freshness checked before the call,
  the gate, the one POST, and the answer recorded.
- **Parking a preparation refusal** (GS-7c-2). The legacy park now leaves
  orchestrated attempts alone; a terminal refusal of an orchestrated attempt
  must end it in its orchestration state, under the cost-admission lock, and a
  retryable one leave it `QUEUED`.
- **An attempt the gate refuses for good** (GS-7d). `SOURCE_INVALID` and a
  permanently ineligible price leave the attempt `QUEUED`, holding its Unit;
  what ends it, and releases the reservation, is not decided
  (`docs/decisions/TODO.md`).

## Consequences

- `@app/domain`: `AuthorizePaidSubmissionInput.source`, the session's
  `lockSource`, the arm's `audit`, the outcome `SOURCE_INVALID` with
  `SourceAuthorizationFailure`, and `PAID_SUBMISSION_AUDIT_ACTION`.
- `@app/database`: the gate's session locks and reads the source and writes the
  audit entry; the legacy executor's discovery, claim and park are legacy-only.
  `toExecutionSourceObservation` and its row type are exported within the
  package for the gate and stay unpublished.
- No migration. Nothing outside tests constructs the gate or the legacy
  executor, so no path a customer or a worker reaches changes.
