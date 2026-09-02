# ADR-0035: Submission certainty is a returned value, not an exception

- Status: Accepted
- Date: 2026-09-02
- Phase: 4C-3B-2C
- Amends: ADR-0031 (provider diagnostic sanitization) — narrows what an
  exception from a provider adapter is allowed to mean, without changing what a
  `ProviderError` may contain
- Relates to: ADR-0030 (locked prepared-source submission claim), which
  guarantees at most one *claim*; this ADR governs what happens after the claim,
  when the paid call is actually made

## Context

`createGeneration` is the only call in this system that can cost money, and
until now it reported failure exactly like every other provider call: by
throwing a `ProviderErrorException` carrying a `ProviderError`.

That put the most expensive decision the platform makes — *may this request be
sent again?* — behind the most naturally misread signal available. Two things
were wrong with it:

1. **`retryable` describes the transport, not the provider's decision.** A 429
   or a 503 normalizes to `retryable: true` because the network may well work
   later. It says nothing about whether WaveSpeed received the request, queued
   it, and began billing for it. A caller reading `retryable` as "safe to send
   again" would be reading the right field for the wrong question.
2. **`catch` is a retry-shaped construct.** The natural handler for a thrown
   error is `catch { retry() }`, and the natural handler here spends the
   customer's money twice. An abstraction whose obvious use is the dangerous one
   is a defect in the abstraction.

The concrete failure this prevents: a submission times out at 60s. The request
was delivered; WaveSpeed is generating video and will bill for it. The timeout
normalizes to `TIMEOUT` with `retryable: true`, an exception propagates, a retry
policy re-POSTs, and the customer is charged twice for one scene — with two
prediction ids for one `SceneGeneration` row, only one of which is tracked.

A second pressure made the same decision urgent. ADR-0033 established that this
platform will have more than one provider. Certainty had been expressed
implicitly, through WaveSpeed's HTTP status handling, so there was nothing for a
second adapter to implement — only a shape to copy. Copying it would have been
wrong: WaveSpeed and fal publish different guarantees.

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

`SUBMISSION_UNKNOWN` is the default, not the exceptional case. An adapter must
positively establish non-acceptance to say anything else.

Programmer defects still throw. A `TypeError` is not provider certainty and must
not be dressed up as it.

### 2. Certainty and retryability are orthogonal

The union carries no `retryable` of its own, and this is enforced at compile
time. Both of these are valid and mean different things:

```text
SUBMISSION_UNKNOWN + error.retryable === true    // the transport may work later
SUBMISSION_UNKNOWN + error.retryable === false   // and it may not
```

Neither authorizes a second create POST. `retryable` survives because it is
genuinely useful for scheduling and operator diagnostics; it simply answers a
different question.

### 3. The union is provider-neutral; each adapter owns its own evidence

No HTTP status, no vendor field, no queue concept appears on the union. A
sanitized status lives on `ProviderError.providerStatus` as a diagnostic and
decides nothing.

This matters because the mapping from vendor behaviour to these three answers is
**not shared**. Each adapter must justify its own `DEFINITIVELY_REJECTED` rule
from what its vendor actually publishes.

**WaveSpeed** uses an allowlist — `400`, `401`, `403` — and nothing else:

- `400`: the request was malformed; there is nothing to execute.
- `401` / `403`: the credential was refused, so the request never reached
  anything that could begin work.

**422 is deliberately not on that list**, and its previous definitive treatment
is not carried forward. "Unprocessable entity" describes a request the server
understood and declined to process *as given*, which on a generation API can be
a moderation or model-level refusal reached after the request was accepted and
possibly after work began. Semantic rejection is not proof that nothing
happened. The asymmetry justifies the caution: an over-narrow allowlist parks a
request a human can re-submit; an over-broad one re-POSTs work already being
billed.

**fal treats no remote status as definitive at all.** Its queue documents client
and model errors — 422 among them — that can be raised after a request has been
accepted and GPU work has begun, and it publishes nothing that establishes
non-acceptance. Copying WaveSpeed's allowlist would have been inventing a
certainty contract fal has not offered. fal's only definitive rejections are
local refusals raised *before* the HTTP method is invoked, where nothing left
this process.

### 4. Submission is its own port

`VideoGenerationSubmissionProvider` declares `name`, `createGeneration` and
`normalizeError`. `VideoGenerationProvider` extends it, so there is exactly one
definition of what submitting costs and returns.

The split exists so an adapter can implement submission alone. The fal adapter
has no verified pricing, polling or cancellation contract, so it declares none.
Forcing it through the full seam would have meant inventing three answers to
satisfy a type — the same fabrication ADR-0033 refused for unverified catalog
entries.

Status polling and cancellation keep their exception behaviour. Neither can
incur a charge, so neither needs the certainty vocabulary.

### 5. At most one outbound submission per call

Every implementation must invoke its submission transport no more than once per
call: no loop, no retry, no retry-on-timeout, no retry-on-429, no retry after a
redirect or a malformed success.

Three mechanisms hold this up rather than a comment:

- The shared `HttpClient` performs **exactly one `fetch` per request**, with no
  retry or backoff anywhere in the transport.
- Submission passes `redirect: "manual"`. A transparently-followed 3xx re-sends
  the body to a new URL — a second POST nobody authorized, to a host nobody
  chose, for an operation that may bill on arrival. A 3xx therefore falls
  through to `SUBMISSION_UNKNOWN`.
- Submission passes an explicit `timeoutMs` separate from the client-wide
  default, because abandoning a paid submission does not cancel it: it converts
  a knowable answer into the most expensive state this system has.

Every adapter is structured with an explicit invocation boundary. Above the
`http.request` line a failure proves nothing was sent; from that line onward it
does not.

## Consequences

### What this makes possible

A future orchestrator can distinguish "re-submit" from "investigate" without
guessing. `DEFINITIVELY_REJECTED` can fail an attempt and release its credit
reservation; `SUBMISSION_UNKNOWN` must not, because a reservation released
against work the provider is billing produces an unfunded charge.

### What it does not do

This milestone changes a boundary and nothing behind it. It does not make paid
generation reachable, add orchestration, add a paid gate, persist submission
audit records, add polling or output ingestion, or enable fal.

### What is still owed

`SUBMISSION_UNKNOWN` is currently only *representable*. Nothing yet persists it,
reconciles it against the provider, or holds a credit reservation open while it
is unresolved. Until that exists, the guarantee is that the system cannot
silently re-charge — not that it can recover. Recorded in
`docs/decisions/TODO.md`.

### The dormant adapter

The fal adapter is tested production code that no configuration can reach:
`VIDEO_PROVIDER` accepts only `fake` and `wavespeed`, there is no `FAL_API_KEY`
in the environment schema, `createVideoProvider` has no fal branch, and the
class cannot be constructed without a credential nothing in production supplies.
Its credential is constructor input rather than an environment read, so it
cannot be armed by configuration alone.

It exists now, dormant, because a provider-neutral abstraction with one
implementation is an assertion. With two, the neutrality is demonstrated — and
the two disagree about the thing that matters, which is the proof that the
vocabulary is not a WaveSpeed shape wearing a general name.

### Rejected alternatives

**A richer `ProviderError` with a `submissionCertainty` field.** Smaller change,
but it leaves the answer optional: existing `catch` sites keep compiling and
keep being wrong. The return type change is what makes the compiler enumerate
every caller.

**An exception subclass per certainty.** Still an exception, so `catch` is still
the natural handler and `catch (e) { retry() }` still compiles. The whole point
is to stop the dangerous handler from being the obvious one.

**Adopting `@fal-ai/client` as the submission transport.** Its retry behaviour
is not part of its public contract and could change in a patch release, moving
the exactly-one-POST guarantee into a dependency where it cannot be audited from
this repository. fal documents direct queue submission over plain HTTP, so the
seam stays here where a test can count invocations. The SDK may be reconsidered
for non-submission operations once its retry behaviour is separately proven
safe.
