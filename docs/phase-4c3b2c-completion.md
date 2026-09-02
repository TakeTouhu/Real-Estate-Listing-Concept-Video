# Phase 4C-3B-2C — Whole-phase completion report

Provider submission certainty, delivered as two milestone pull requests.

| Subphase | Scope | Report |
| --- | --- | --- |
| 4C-3B-2C-1 | The contract, the WaveSpeed implementation, the Fake provider | `docs/phase-4c3b2c1-completion.md` |
| 4C-3B-2C-2 | The dormant fal / MiniMax H3 Max submission adapter | `docs/phase-4c3b2c2-completion.md` |

Decision record: ADR-0035, with §7 added by the second subphase. Both subphase
reports are immutable snapshots; this document does not restate their evidence.

## What the phase established

`createGeneration` returns a `ProviderSubmissionOutcome` — `ACCEPTED`,
`DEFINITIVELY_REJECTED`, `SUBMISSION_UNKNOWN` — rather than throwing, because
`catch { retry() }` is the natural handler for an exception and the natural
handler here charges the customer twice. Certainty and retryability are
orthogonal, and the union carries neither `retryable` nor an HTTP status.

The invocation boundary is the call to the injected transport method: mapping,
headers, serialization, request construction and resolving that method all
complete before the certainty `try` opens, so a local defect propagates rather
than becoming a financial claim.

## Provider-neutrality is now demonstrated, not asserted

This is the phase's real deliverable, and it required the second adapter.

An abstraction with one implementation proves nothing about neutrality — the
vocabulary could simply be a WaveSpeed shape wearing a general name. Two
adapters settle it, and they settle it precisely because **their
definitive-rejection evidence intentionally differs**:

| | WaveSpeed | fal / H3 Max |
| --- | --- | --- |
| Remote definitive rejection | `400`, `401`, `403` | **none** |
| `422` | `SUBMISSION_UNKNOWN` | `SUBMISSION_UNKNOWN` |
| Local refusal before invocation | none modelled | unsupported model, blank credential |
| Acceptance handle | prediction id | `request_id` only |

WaveSpeed allowlists three statuses because its published contract establishes
them. fal allowlists none, because its queue publishes nothing that establishes
non-acceptance for any status. Neither rule lives in the shared layer, and
neither adapter could have inherited the other's without inventing a certainty
its vendor never offered. That divergence is the evidence: the shared union
carries no HTTP status, no vendor field and no queue concept, and it did not
need to change to accommodate a second provider whose semantics disagree.

## Phase status

Complete as scoped. What it deliberately did **not** do remains unstarted: paid
generation is unreachable, and there is no orchestration, paid gate, submission
audit persistence, polling, output ingestion, worker execution loop, or fal
runtime enablement. `SUBMISSION_UNKNOWN` is representable but not yet persisted
or reconciled — the system cannot silently re-charge, but it cannot yet recover.
No provider was contacted in either subphase.

Outstanding work is recorded in `docs/decisions/TODO.md`; pricing contract
hardening is the next separately authorized milestone.
