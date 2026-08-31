# ADR-0032: Paid submission certainty is explicit, not inferred

- Status: Accepted
- Date: 2026-08-31
- Phase: 4C-3B-2
- Builds on: ADR-0031 (provider diagnostics are safe structured data)

## Context

`createGeneration` is the one call that spends money. Before this milestone it
returned a `ProviderGenerationRef` and threw for everything else, so from the
caller's side a rate limit, a 500, a socket reset and a validation rejection all
arrived as the same shape: a rejected promise carrying a `ProviderError`.

Two of those mean the provider certainly did nothing. Two of them mean a
prediction may already exist and already be billed. The natural handler for a
thrown error — catch, inspect `retryable`, retry — is exactly wrong for the
second pair, and `retryable: true` is precisely what a 429 and a 5xx carry.

WaveSpeedAI's own documentation is explicit that a disconnected submission
response may correspond to a prediction that was accepted and billed, that
submission POSTs must not be blindly retried, and that the retry-safe operation
is the result-query GET. There is no idempotency-key contract to fall back on.

## Decision

### 1. Certainty is a returned value, not an exception

```ts
type ProviderSubmissionOutcome =
  | { kind: "ACCEPTED";              ref: ProviderGenerationRef }
  | { kind: "DEFINITIVELY_REJECTED"; error: ProviderError }
  | { kind: "SUBMISSION_UNKNOWN";    error: ProviderError };
```

`createGeneration` returns this. The arms are structurally disjoint: only
`ACCEPTED` carries a `ref`, so a caller cannot reach a prediction id without
discriminating first, and the compiler enforces that rather than a comment.

A union rather than an exception subclass because the failure this milestone
prevents is **conflation**. `catch (e) { retry() }` compiles and reads fine; a
union makes the three-way distinction unignorable, and `never`-exhaustiveness
turns a forgotten arm into a build error. The same reasoning produced
`SubmissionClaimOutcome` (ADR-0030) and `ExecutionSourceClassification`
(ADR-0029), for the same reason.

### 2. Certainty is not derivable from retryability

They answer different questions. `retryable` asks "would this request plausibly
succeed if repeated"; certainty asks "is it safe to repeat it at all". For a
paid POST those diverge, and the divergence is the point:

| Status | `ProviderError.retryable` | Submission certainty |
| --- | --- | --- |
| 429 | `true` | `SUBMISSION_UNKNOWN` |
| 500 | `true` | `SUBMISSION_UNKNOWN` |

The diagnostic mappings from ADR-0031 are **unchanged**. A future orchestrator
must read the discriminant and must never infer certainty from `kind`,
`retryable`, an HTTP status, or whether something was thrown.

### 3. The definitive-rejection allowlist is exactly 400, 401, 403

Everything else is `SUBMISSION_UNKNOWN`: every 1xx, every 3xx, 402, 404, 405,
406, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 421, **422**, 423,
424, 425, 426, 428, **429**, 431, 451, every 5xx, and any status nobody has
considered.

An allowlist, not a blocklist, because the costs are asymmetric: wrongly calling
something ambiguous costs a human reconciliation; wrongly calling something
definitive costs a duplicate charge. A status is safe only once someone
deliberately wrote it down.

**422 is not carried forward** merely because `normalizeHttpStatusError` maps it
to `INVALID_INPUT`. That mapping is a diagnostic category, not evidence about
billing, and generic HTTP semantics are not enough to widen a money-path
allowlist. The three that qualify are documented WaveSpeedAI submission
rejections, each decided before the request could create work.

The list lives in exactly one place, `isDefinitiveRejectionStatus`, and a test
walks every integer from 100 to 599 to prove nothing else joins it.

### 4. Acceptance is a usable prediction id, not a 2xx

A 2xx alone proves nothing. `ACCEPTED` requires an id that is a string, non-empty,
and unchanged by `trim()`. Padding is rejected rather than trimmed: the trimmed
form is an identifier the provider never sent, and this id is what later polling
and reconciliation depend on being exact.

Resolution order is `data.id` — the documented location — then a top-level `id`,
retained as a legacy compatibility path that existing tests pin. No third
location, and an id is never recovered from message text.

Everything else after a 2xx is `SUBMISSION_UNKNOWN`: unparseable JSON, an empty
body, `{}`, a missing `data`, a missing/empty/whitespace/padded/non-string id, a
truncated response. `findUsablePredictionId` returns `undefined` rather than
throwing, because after a 2xx an unreadable id is an ambiguous *submission*, not
a local fault, and an exception would force it into the rejection channel.

Response `code` and `message` are **not** acceptance conditions. Optional
metadata being absent or malformed does not revoke an acceptance the id proves.

### 5. The invocation boundary decides what may throw

`createGeneration` may throw only for a failure proven to occur **before**
invocation. Request mapping, body serialization, header construction and
`submittedAt` all happen above the `http.request` line; from that line onward
every exit is a `ProviderSubmissionOutcome`.

Reading `submittedAt` early matters: every value needed to describe an
acceptance is in hand before acceptance can happen, so no avoidable local throw
can occur while holding a prediction id we would then lose.

The `catch` around the call returns `SUBMISSION_UNKNOWN` without trying to
determine whether bytes left the process. An injected client can fail before the
socket connects, and the boundary cannot tell that apart from a reset in flight.
Guessing toward "definitely not sent" is what pays twice, so it fails closed.

### 6. Transport hardening, scoped to the paid POST only

`HttpRequest` gains `redirect?: "follow" | "manual"` and `timeoutMs?: number`.
Both are omitted by default, so `getStatus` and `cancelGeneration` are untouched.

**`redirect: "manual"` on create.** `fetch` follows redirects itself, and a 307
or 308 replays the method *and body* against the `Location` host — a second POST
of the same paid request that no application code asked for — while 301, 302 and
303 silently downgrade the submission to a GET. This was the only automatic
re-POST vector in the system. Any observed 3xx is `SUBMISSION_UNKNOWN`; the
`Location` is not followed manually.

**60 000 ms on create**, against the client's unchanged 30 000 ms default. The
submission timeout is an *ambiguity* budget, not a latency budget: aborting does
not stop the provider, it only destroys our evidence, so a short budget
manufactures `SUBMISSION_UNKNOWN` rows a human must resolve. Create therefore
waits **longer**, matching WaveSpeedAI's documented submission examples. No
environment variable is introduced.

**Exactly one POST.** No application retry of any kind — not on network failure,
timeout, 429, 5xx, or redirect. Asserted at the provider seam by call count and
at the fetch seam with a mocked global `fetch`.

### 7. Diagnostics stay under ADR-0031

Every new outcome carries a `ProviderError` built from fixed application text.
The ambiguous-2xx diagnostic keeps the code `WAVESPEED_MISSING_PREDICTION_ID`
and records the real 2xx in `providerStatus`; no body bytes, no raw cause, no
arbitrary provider message. The fake provider's configurable outcomes select a
**discriminant only** — their errors are constructed internally, and no message,
code, cause or body can be supplied by a caller.

## WaveSpeedAI evidence (2026-08-31)

Submission is `POST /api/v3/{model_id}`. Submission POSTs must not be blindly
retried; a disconnected response may correspond to a prediction that was
accepted and billed; result-query GETs are the retry-safe operation. Official
submission examples use a 60-second maximum. The submission response identifies
the prediction through `data.id`. Documented submission errors include 400, 401,
403, 429 and 500.

No idempotency-key contract exists, and none is assumed. `requestHash` remains
internal identity and is not sent as a header (ADR-0031).

`preset` is now a documented optional OpenVideo parameter — the earlier comment
calling it undocumented is stale and has been corrected. It is still not sent,
for a different reason: the provider defaults it, nothing here selects one, and
sending an unchosen value would change paid output on the vendor's terms.
Exposing it is a request-mapping decision for its own milestone.

## Consequences

- More outcomes require a human. A 429 or a 5xx now parks a submission as
  unknown rather than as a retryable failure. That is the intended trade:
  reconciliation is cheaper than a duplicate charge.
- `createGeneration`'s contract diverges from the other three provider methods,
  which still throw. The asymmetry tracks a real difference — the others are
  idempotent and free.
- **The provider reports certainty; it does not persist it.** No
  `SceneGeneration` transition happens here. Mapping outcomes onto
  `PROCESSING` / `FAILED_*` / `SUBMISSION_UNKNOWN` belongs to a later
  orchestration milestone.
- Production remains dormant: `createGeneration` has zero production callers,
  and there is no paid gate, submission audit, worker loop or provider POST.

## Still blocking paid generation

**The paid gate may not be enabled until the WaveSpeedAI pricing contract is
resolution-aware and verified.** Official pricing is 480p $0.02/s, 720p $0.04/s,
1080p $0.06/s, billed to a maximum of 20 seconds. The one-dimensional
`costPerSecondMinor` placeholder cannot represent it, so every reserved credit
amount derived from `estimateCost` is wrong for 480p and 1080p. Unchanged here,
and no `verified` boolean was added — a flag does not make the contract correct.
