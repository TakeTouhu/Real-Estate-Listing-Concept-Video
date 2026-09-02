# ADR-0035: Submission certainty is a returned value, not an exception

- Status: Accepted
- Date: 2026-09-02
- Phase: 4C-3B-2C-1; §7 added in 4C-3B-2C-2
- Amends: ADR-0031 — narrows what an exception from a provider adapter means,
  without changing what a `ProviderError` may contain
- Relates to: ADR-0030, which guarantees at most one *claim*; this ADR governs
  what happens after the claim, when the paid call is made

## Context

`createGeneration` is the only call that can cost money, and it reported failure
exactly like every other provider call: by throwing a `ProviderErrorException`
carrying a `ProviderError`. Two things were wrong with that.

**`retryable` describes the transport, not the provider's decision.** A 429 or a
503 is `retryable: true` because the network may work later. It says nothing
about whether the provider received the request and began billing.

**`catch` is a retry-shaped construct.** The natural handler for a thrown error
is `catch { retry() }`, and the natural handler here spends the customer's money
twice. An abstraction whose obvious use is the dangerous one is a defect.

The failure this prevents: a submission times out at 60 s. From this side that
is indistinguishable from success — the request may never have arrived, or may
be queued, executing and billable. The timeout normalizes to `retryable: true`,
an exception propagates, a retry policy re-POSTs, and one scene may be billed
twice with two prediction ids, only one tracked. Nothing distinguished that from
a request that provably never landed.

Since ADR-0033 the architecture is also multi-provider, and certainty was
expressed implicitly through WaveSpeed's HTTP status handling — nothing for a
second adapter to implement, only a shape to copy. Copying would be wrong:
providers publish different guarantees.

## Decision

### 1. Submission returns a three-armed outcome

`createGeneration` returns `ProviderSubmissionOutcome` and does not throw for
expected provider or transport failures:

- **`ACCEPTED`** — the provider took the request and named it. A prediction id
  is in hand; the work is trackable and must never be re-submitted.
- **`DEFINITIVELY_REJECTED`** — the request provably did not reach a state where
  the provider could have begun or billed work.
- **`SUBMISSION_UNKNOWN`** — everything else. The provider may hold the request,
  may be executing it, may have billed it. This process does not know.

`SUBMISSION_UNKNOWN` is the default. An adapter must positively establish
non-acceptance to say anything else. Programmer defects still throw; a
`TypeError` is not provider certainty and must not be dressed up as one.

### 2. Certainty and retryability are orthogonal

The union carries no `retryable` of its own, enforced at compile time. Both of
these are valid and mean different things:

```text
SUBMISSION_UNKNOWN + error.retryable === true    // the transport may work later
SUBMISSION_UNKNOWN + error.retryable === false   // and it may not
```

Neither authorizes a second create POST. `retryable` survives because it is
useful for scheduling and diagnostics; it answers another question.

### 3. The union is provider-neutral; each adapter owns its own evidence

No HTTP status, no vendor field, no queue concept appears on the union. A
sanitized status lives on `ProviderError.providerStatus` and decides nothing.

The mapping from vendor behaviour to these three answers is **not shared**: each
adapter must justify its own `DEFINITIVELY_REJECTED` rule from what its vendor
publishes, so the rule lives in the adapter, never in a shared layer.

**WaveSpeed** allowlists `400`, `401`, `403` and nothing else:

- `400`: the request was malformed; there is nothing to execute.
- `401` / `403`: the credential was refused, so the request never reached
  anything that could begin work.

**422 is deliberately absent**, and its previous definitive treatment is not
carried forward: the currently verified WaveSpeed contract does not establish
422 as proof of non-acceptance. That absence of proof is the entire reason — no
claim is made about what WaveSpeed does internally with a 422, because none has
been verified. The asymmetry settles the doubt: an over-narrow allowlist parks a
request a human can re-submit; an over-broad one re-POSTs work that may already
be billed.

The allowlist is a `switch` over literals with no exported backing collection.
An exported array would be a mutable object controlling a financial
classification, and any module holding the reference could widen it.

### 4. Submission is its own port

`VideoGenerationSubmissionProvider` declares `name`, `createGeneration` and
`normalizeError`. `VideoGenerationProvider` extends it, so there is exactly one
definition of what submitting costs and returns.

The split exists so an adapter can implement submission alone: the catalog
admits models whose pricing, polling and cancellation contracts are unverified
(ADR-0033), and such an adapter can declare only what it can honour rather than
invent three answers to satisfy a type. The fal / H3 Max adapter (§7) is
exactly that: submission and error normalization, nothing else. Status polling
and cancellation keep their exception behaviour; neither can incur a charge.

### 5. At most one outbound submission per call

No loop, no retry, no retry-on-timeout, no retry-on-429, no retry after a
redirect or a malformed success. Three mechanisms, not a comment:

- The shared `HttpClient` performs **exactly one `fetch` per request**, with no
  retry or backoff anywhere in the transport.
- Submission passes `redirect: "manual"`. A followed 3xx re-sends the body to a
  new URL — a second POST nobody authorized, for an operation that may bill on
  arrival — so a 3xx falls through to `SUBMISSION_UNKNOWN`.
- Submission passes an explicit 60 s `timeoutMs`, separate from the client-wide
  default, because abandoning a paid submission does not cancel it.

The boundary is the **invocation of the injected transport method**, and the
rule has three cases rather than two:

| Case | Result |
| --- | --- |
| An **explicitly recognized** local validation refusal, before invocation | `DEFINITIVELY_REJECTED` |
| An unexpected programmer or invariant defect | **throws** |
| Any failure from the moment invocation begins | the provider-specific certainty rule |

Being before the boundary is therefore necessary for a definitive rejection but
not sufficient: a defect is not evidence about a provider, and catching one to
call it `DEFINITIVELY_REJECTED` converts an unknown bug into a financial claim.
No such refusal is modelled today; when one is, it must arrive through a closed
refusal contract or another nominal mechanism, never a catch-all.

The boundary is drawn in code as widely as JavaScript requires: mapping, header
construction, body serialization and **resolving the transport method itself**
all complete before the certainty `try` opens, since every one executes before
the call. A throwing `request` getter is a defect, not an unknown fate.

### 6. Malformed provider success is a classified outcome, not an exception

A 2xx whose prediction id cannot be recovered is `SUBMISSION_UNKNOWN`: the
provider answered with success and may hold the request, and what failed is this
side's ability to name it.

`parsePredictionId` is therefore **total** over arbitrary parsed JSON, returning
`string | null`. It previously asserted its argument into an envelope type and
read a property off it — an assertion is a compile-time claim and validates
nothing — so a body of exactly `null` raised a `TypeError`. The guard is now a
runtime check, and a valid identifier is normalized by trimming.

Its diagnostic says only that no usable prediction id was present. It must not
say the submission was accepted: acceptance is precisely the fact this outcome
exists because nobody can establish it.

## Consequences

A future orchestrator can distinguish "re-submit" from "investigate" without
guessing. `DEFINITIVELY_REJECTED` may fail an attempt and release its credit
reservation; `SUBMISSION_UNKNOWN` must not, because releasing a reservation
against work the provider is billing produces an unfunded charge.

This subphase changes a boundary and nothing behind it: no paid generation, no
orchestration, no paid gate, no submission audit persistence, no polling or
output ingestion, and no second adapter.

`SUBMISSION_UNKNOWN` is only *representable*: nothing persists it, reconciles it,
or holds a reservation open while unresolved, so the guarantee is that the
system cannot silently re-charge, not that it can recover. Recorded in
`docs/decisions/TODO.md`.

## 7. The fal / H3 Max adapter (added in 4C-3B-2C-2)

A provider-neutral abstraction with one implementation is an assertion. This
adapter is the evidence, and it earns that only by **disagreeing** with
WaveSpeed where the vendors' published contracts differ.

**No remote status is definitive.** WaveSpeed allowlists 400/401/403 because its
contract establishes them; fal's queue publishes nothing that establishes
non-acceptance for any status, and a 422 there may follow work already admitted
and billable. Inheriting WaveSpeed's rule would invent a certainty fal never
offered. Every post-invocation result without a valid `request_id` — 3xx, any
4xx, any 5xx, transport failure, timeout, malformed JSON, empty body, or a 2xx
whose id is missing, non-string, empty or whitespace — is `SUBMISSION_UNKNOWN`.

**Acceptance requires a named request.** Only fal's documented `request_id`
counts, trimmed. `response_url`, `status_url`, `cancel_url` and
`gateway_request_id` are deliberately not consulted: an adjacent or derived
identifier would let a body that never named the work look trackable. The HTTP
seam exposes no response headers, so `x-fal-request-id` is not reachable either
— and widening the seam to reach it would reopen the raw-header channel
ADR-0031 closed.

**Only two local refusals are definitive:** an unsupported model id and a blank
credential, both raised before any HTTP invocation, so each proves nothing was
sent. There is no catch-all: an unexpected pre-invocation defect propagates.
Local error text is a closed set of fixed helpers — no helper accepts a
caller-supplied `messageSanitized`, because that parameter is an open channel
into a field ADR-0031 requires to be application-owned.

**Raw HTTP, not `@fal-ai/client`.** The exactly-one-POST guarantee must stay
auditable in this repository; the SDK's retry behaviour is not part of its
published contract and could change in a patch release. That guarantee is about
*this application*: fal's own durable-queue retries are provider-internal
processing of a request it has already accepted, and are **not** an application
re-POST — which is why `X-Fal-No-Retry` is not sent. Suppressing fal's internal
recovery to satisfy an application-side rule would trade reliability for a
property the application already holds.

**Dormant, and unpriced.** `VIDEO_PROVIDER` still accepts only `fake` and
`wavespeed`, no fal key exists in the environment schema, `createVideoProvider`
has no fal branch, and nothing in production constructs the class. The catalog
entry keeps `pricing: null`: no fal price is transcribed, and cost estimation,
orchestration, polling, persistence and paid execution are all out of scope.

## Rejected alternatives

**A `submissionCertainty` field on `ProviderError`.** Leaves the answer
optional: existing `catch` sites keep compiling and keep being wrong. The return
type change is what makes the compiler enumerate every caller.

**An exception subclass per certainty.** Still an exception, so `catch (e) {
retry() }` still compiles and is still the obvious handler.
