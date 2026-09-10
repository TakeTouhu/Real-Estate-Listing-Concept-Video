# ADR-0040: What fal said, in this application's words — and never in fal's

- Status: Accepted
- Date: 2026-09-10
- Phase: 4C-3B-2H-3A
- Implements: ADR-0039's `ProviderCompletionStatusSource`, which was declared as
  a port with no implementation
- Relates to: ADR-0016 (provider references are internal), ADR-0031 (every field
  of a diagnostic is application-owned), ADR-0035 (fal publishes no certainty
  contract), ADR-0038 (managed output integrity is measured, never reported)

## Context

Phase 4C-3B-2H-2 declared `ProviderCompletionStatusSource` — one method, taking
three persisted identifiers and returning `unknown` — and deliberately shipped no
implementation of it. This ADR records the first one: fal's asynchronous Queue
API, for the MiniMax H3 Max image-to-video route.

The claim about the repository changes here, and it is worth stating precisely
before anything else. After Phase 2H-2 it was true that **no concrete polling
implementation existed**. That is no longer true. `FalQueueCompletionStatusSource`
constructs real `https://queue.fal.run` requests and would reach fal if it were
handed a credential and called. The honest claim is now about composition:

> A concrete fal polling implementation exists. It has no production caller, no
> production composition, and no production credential.

Every dormancy statement in this ADR means that and nothing stronger.

## fal's contract, as it actually is

fal's queue publishes three lifecycle states — `IN_QUEUE`, `IN_PROGRESS`,
`COMPLETED` — and separates the lifecycle from the artifact across two
resources:

```text
GET https://queue.fal.run/{modelId}/requests/{requestId}/status
GET https://queue.fal.run/{modelId}/requests/{requestId}/response
```

The separation is not an inconvenience to paper over. It is the reason this
adapter can be correct about money: the first call establishes whether fal ran
and will bill, and the second establishes only whether we can currently reach
what it produced. Collapsing them — by using fal's `subscribe` helper, or by
treating a failed artifact fetch as a failed render — would fuse two facts with
different owners and different consequences.

## Decision

### 1. The persisted attempt names the vendor, and the compiled-in constant names the URL

`providerName` must equal `fal` and `providerModelId` must equal
`MINIMAX_H3_MAX_MODEL_ID`, checked **before a URL exists**. Neither
`VIDEO_PROVIDER`, the current default model, the routing policy nor the catalog's
present selection participates.

The URL is then built from the *constant*, never from the validated column. That
is deliberately redundant: even if the equality check were weakened or deleted by
a later change, a persisted model id still could not become a host or a path,
because `falQueueStatusUrl` takes no model argument at all. A validated value and
an unused value fail differently, and the second failure mode is the survivable
one.

`H3 2K`, Veo and WaveSpeed are all out of scope here, and an unsupported identity
is refused rather than approximated. Substituting a currently-configured model
would ask the right vendor the wrong question and believe the answer.

### 2. At most one status request, then at most one result request

No loop, no backoff, no `sleep`, no `subscribe`. Repetition belongs to Phase
2H-2's batch cadence, which is bounded, audited and interruptible; an adapter
that quietly polled until completion would hold a batch slot open for a vendor's
entire render time and hide the wait from every metric that watches the batch.

The result request is issued **only** after a `COMPLETED` status carrying no
failure. A running render has no artifact, so asking for one is a guaranteed
round trip for a body that cannot be there.

### 3. Provider success is recorded before output acquisition is even attempted

Once `/status` says `COMPLETED` with no failure, fal has run and will bill for
the render, and the adapter is committed to saying so. Every way the subsequent
`/response` call can go wrong — a throw, a local timeout, a non-2xx, unreadable
JSON, a missing `video.url`, a blank one — returns:

```ts
{ kind: "SUCCEEDED", outputLocator: null }
```

never `FAILED`, and never a throw.

This is the single most consequential decision in the phase. Output acquisition
failing must not suppress the money-relevant fact that the render happened,
because the alternative leaves a paid attempt reading as in-flight forever while
the Safety Guard counts it against the tenant's exposure. Phase 2H-2 already has
the arm for this outcome — `OUTPUT_LOCATOR_UNAVAILABLE`, recorded against a row
that is already `PROVIDER_SUCCEEDED` and re-pollable later purely to reacquire a
location.

The mirror image is just as deliberate: a failure **before** completion is known
— the `/status` call throwing, timing out, or returning something unreadable —
is never a provider failure. It throws, Phase 2H-2 maps it to
`STATUS_SOURCE_FAILED`, and the attempt is not touched. "I could not find out"
says nothing about a paid render, and recording it as a failure would convert a
gateway hiccup into a terminal state.

### 4. Failure classification comes from `error_type` alone, through a closed table

fal reports failures on a `COMPLETED` status through two fields: a
human-readable `error` and a machine-readable `error_type`. Only the second is
ever parsed.

The first is *counted* — a body claiming failure through only the prose still
claims a failure, and reading it as success would record a paid render as usable
— but it is never read, matched or classified. Prose is not a contract: it
changes without notice, it is written for humans, and it is exactly the field
most likely to contain a prompt, a file path or an account identifier.

The recognized vocabulary is closed at thirteen values, and membership is exact:
no prefix matching, no substring matching, no HTTP status as a substitute.
`runner_disconnected_v2` contains a member and is not one.

| `error_type` | Retryable | Diagnostic |
| --- | --- | --- |
| `request_timeout` | yes | `TIMEOUT` |
| `startup_timeout` | yes | `TIMEOUT` |
| `runner_connection_timeout` | yes | `CONNECTION_RESET` |
| `runner_disconnected` | yes | `CONNECTION_RESET` |
| `runner_connection_refused` | yes | `CONNECTION_RESET` |
| `runner_connection_error` | yes | `CONNECTION_RESET` |
| `runner_incomplete_response` | yes | `CONNECTION_RESET` |
| `runner_scheduling_failure` | yes | none |
| `runner_server_error` | yes | none |
| `internal_error` | yes | none |
| `client_disconnected` | no | none |
| `client_cancelled` | no | none |
| `bad_request` | no | `LOCAL_CONFIGURATION` |

Retryable follows *who failed*: everything describing fal's own infrastructure
is retryable, because the request itself was never shown to be wrong. The three
`false` entries are the ones where repeating is pointless or already our
decision. This governs whether a later phase may admit a new `SYSTEM_RECOVERY`
attempt — it is not an instruction to this adapter, which retries nothing.

The diagnostic column reuses Phase 2G-1's closed three-member catalog,
**unexpanded**. Most entries are therefore `null`, and `null` is the honest
answer rather than a gap: inventing `RUNNER_FAILURE` to make the table look
complete would put a vendor's taxonomy into a field ADR-0031 requires this
application to own. The `error_type` itself is never persisted — it selects a
code from our catalog and stops at the boundary.

### 5. An unclassifiable failure fails closed

If a `COMPLETED` status claims a failure whose `error_type` is missing, blank,
wrongly typed or simply unknown, the adapter throws. It does not guess a
retryability, and it does not default to either value.

Both guesses are unrecoverable in opposite directions: guessing retryable spends
a customer's unit again on a request that may fail identically, and guessing
terminal abandons a render that would have succeeded. Refusing leaves the attempt
`PROCESSING` and is recovered by adding the value to the table — a code change
with a review, which is what discovering a new vendor failure mode should cost.

The thrown error carries fixed application-owned text. The unrecognized
`error_type`, the prose and the body are all absent from it, because a
diagnostic is read by far more people than the row it describes.

### 6. Provider-returned URLs are never routing authority

fal's status body offers `status_url`, `response_url` and `cancel_url`. None is
followed. The result resource is derived from the same frozen host and constant
model id as the status resource.

A provider-supplied URL is a provider-chosen host, and a request that follows one
carries our `Authorization: Key …` header to an audience fal's response body got
to pick. The same reasoning closes redirects: both calls use `redirect: "manual"`,
so a 3xx arrives as an ordinary non-2xx and is refused rather than transparently
re-issued somewhere else.

### 7. The persisted request id is encoded as exactly one path component

`encodeURIComponent` neutralizes `/`, `?`, `#`, `%` and control characters. It
does **not** neutralize dots, so a segment consisting only of dots is refused
outright — `…/requests/../status` addresses a different resource, and there is no
legitimate fal request id that shape could be.

Refusal never rewrites the database. The persisted id is historical identity and
stays exactly as fal issued it; the encoding decides only whether a URL may be
built from it.

### 8. Nothing about the provider's result is persisted

No schema change and no migration. Not the fal status, not `error_type`, not
`error`, not the logs, not the metrics, not `response_url`, not the output URL,
not `file_name`, not `content_type`, not the provider-reported `file_size`.

Phase 2H-1's managed-output verification remains the only authority for the
SHA-256, the verified byte count, the managed storage key and `outputVerifiedAt`
— and it measures the bytes the platform actually stored rather than believing
what the vendor said about them. The `?logs=1` query parameter is deliberately
never sent: provider log text is outside the approved audit surface and may
contain anything the model was given.

### 9. The adapter may create a locator; it still may not read one

`TransientProviderOutputLocator.fromUnknown` is called here, which is new — the
concrete adapter is the first thing authorized to *construct* a locator from a
vendor's URL. It gains no ability to read one back. There is still no accessor,
and none is added in this phase: dereferencing is a network capability and will
be reviewed together with the managed-output transfer adapter that needs it.

## Consequences

**Accepted.** A fal render whose artifact endpoint is unavailable produces a
`PROVIDER_SUCCEEDED` attempt with no output until a later poll succeeds. That is
the intended trade: an attempt that is visibly stuck in a recoverable state is
better than one that is invisibly billed and reads as running.

**Accepted.** A fal failure mode not in the table stalls the attempt in
`PROCESSING` rather than resolving it. This is a deliberate cost, paid in
operator attention, to avoid paying it in customer credits.

**Accepted.** The status timeout is 15s against submission's 60s. A status poll
has no ambiguous window — it changes nothing and the next pass re-reads for free
— so waiting a minute for one would hold a batch slot for no gain.

**Not addressed here.** The managed-output transfer adapter, the production
composition that would call either runner, the fal credential wiring, and the
provider-contract reverification that must precede Paid Provider Activation. fal's
current documentation may differ from earlier frozen pricing and resolution
assumptions; this phase changes neither, and that reconciliation is explicitly
deferred to the activation review.
