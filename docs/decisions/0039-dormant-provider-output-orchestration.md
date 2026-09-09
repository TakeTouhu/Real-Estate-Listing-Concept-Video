# ADR-0039: The attempt says which provider to ask, and a transient location is never written down

- Status: Accepted
- Date: 2026-09-09
- Phase: 4C-3B-2H-2
- Extends: ADR-0038, which decided what an attempt's post-acceptance record looks
  like; this ADR decides who fills it in
- Relates to: ADR-0016 (provider references are internal), ADR-0024 (the row is
  the queue), ADR-0037 (candidate discovery is advisory), and the Phase
  4C-3B-2F-1 lock order it deliberately stays outside of

## Context

Phase 4C-3B-2H-1 defined every state an accepted attempt can reach afterwards —
`PROVIDER_SUCCEEDED`, `FAILED_*`, `OUTPUT_INGESTING`, `OUTPUT_VERIFIED` — and
made each transition safe, tenant-scoped and replayable. Nothing calls it. The
evidence arrives as an argument, and the layer that would produce that evidence
does not exist.

This phase writes the layer that *decides which call to make*, still without
making a single network request. That sounds like an odd thing to build in
isolation, and the reason is worth stating: the sequencing decisions here are the
ones that are expensive to get wrong, and they are all decidable without a
transport. Four of them, in the order they bite.

**Asking the wrong provider.** An attempt was admitted against a specific vendor
and model, and holds a prediction id only that vendor issued. Configuration
changes: a default provider is switched, a model is retired, a routing policy is
rewritten. If the poller reads *today's* configuration, it asks the wrong vendor
about an identifier that vendor never issued — a lookup that fails, or, on a
bad day, one that succeeds against something unrelated.

**Losing a paid render because the download link is stale.** A provider's output
lives behind a signed URL that expires. Waiting to record "the provider
succeeded" until the platform has that URL in hand means a transient acquisition
problem suppresses a money-relevant fact indefinitely: the attempt sits in
`PROCESSING`, the Safety Guard counts it as in-flight forever, and nobody can
tell an unfinished render from an unreachable one.

**Blaming the vendor for the platform's own storage.** A copy that fails is not a
render that failed. Recording it as a provider failure puts an internal fault in
the vendor's reliability record and — because failure is terminal — throws away a
render already paid for.

**Holding a database lock across a vendor's response time.** The natural way to
write this is to open a transaction, read the attempt, poll, and write. That puts
a network timeout inside a lock, which stalls a tenant's whole pipeline behind
the slowest thing on the internet.

Each of those is a *shape* problem, and shape is exactly what can be settled
before a transport exists.

## Decision

### 1. The persisted attempt is the only source of provider identity

```ts
interface ProviderPollingContext {
  organizationId; attemptId;
  orchestrationState: "PROCESSING" | "PROVIDER_SUCCEEDED" | "OUTPUT_INGESTING" | "OUTPUT_VERIFIED";
  submissionCertainty: "ACCEPTED";
  providerName; providerModelId; providerPredictionId;
}
```

Read from the attempt row, tenant-scoped through the ownership chain. Never from
`VIDEO_PROVIDER`, the default model, the catalog's current selection, the routing
policy, or the caller. A static test asserts the module names none of those, and
a live test moves a row onto a retired vendor and proves the lookup follows the
row.

Only three of those fields reach the status source:

```ts
interface ProviderStatusLookupRef { providerName; providerModelId; providerPredictionId; }
```

No organization, no attempt id, no prompt, no request hash, no pricing. A vendor
asked "what became of prediction X" has no use for any of it, and a field that
travels is a field the far side can log.

**Blank identity is refused, not repaired.** `ATTEMPT_CONTEXT_INVALID`, with no
outbound call. Both available repairs are worse than refusing: substituting
today's default asks the wrong vendor, and rewriting the row invents history.

The context is **advisory**. It says what was true at read time and authorizes
nothing — every write goes back through Phase 2H-1's compare-and-set, which
re-reads under lock and may well disagree.

### 2. Provider truth is recorded before output acquisition is attempted

The mandatory ordering:

```text
poll → SUCCEEDED
     → recordProviderCompletion({ kind: "SUCCEEDED" })   ← always, first
     → COMMIT
     → locator? no  → OUTPUT_LOCATOR_UNAVAILABLE  (attempt is PROVIDER_SUCCEEDED)
     → locator? yes → beginOutputIngestion → COMMIT → transfer → finalize
```

A provider can be conclusively finished while the platform cannot currently
obtain a usable download location. That is a fact about *acquisition*, and it must
not suppress the separate, durable, money-relevant fact that the render happened
and will be billed. So `outputLocator` is nullable, and a null one is reported
*after* the success is persisted.

### 3. A lookup failure is not a provider failure. A transfer failure is not either.

```text
statusSource.poll throws   → STATUS_SOURCE_FAILED        no write
observation malformed      → STATUS_OBSERVATION_MALFORMED no write
transfer throws            → TRANSFER_SOURCE_FAILED       attempt stays OUTPUT_INGESTING
transfer RETRYABLE_FAILURE → TRANSFER_RETRYABLE_FAILURE   attempt stays OUTPUT_INGESTING
transfer outcome malformed → TRANSFER_OUTCOME_MALFORMED   attempt stays OUTPUT_INGESTING
```

"I could not find out" says nothing about the provider. Recording it as a
provider failure converts a network blip into a terminal state for a paid render.
The same asymmetry applies at the other end: `OUTPUT_INGESTING → FAILED_*` exists
in the committed state machine and this phase never uses it, because the render
is still there, the key is deterministic, and a later run picks it up.

Thrown values are never inspected, logged or persisted. A vendor's error object
can hold a signed URL, a request body and an authorization header, often all
three.

### 4. Recorded provider reality is immutable

Once the platform has written down what the provider did, a later poll cannot
revise it:

```text
recorded success + poll FAILED      → PROVIDER_REALITY_CONFLICT (no write)
recorded success + poll IN_PROGRESS → PROVIDER_REALITY_CONFLICT (no write)
```

A late failure report is a discrepancy for a human, not an instruction to erase a
success and with it a charge the Safety Guard is counting. A late in-progress
report cannot move an attempt backwards; there is no such edge, and inventing one
would un-finish work that finished.

### 5. The transient output locator is opaque and unreadable

```ts
class TransientProviderOutputLocator {
  readonly #validated: true;
  readonly #raw: string;
  private constructor(raw: string) { … }
  static fromUnknown(value: unknown): Result<TransientProviderOutputLocator>
}
```

A provider's output location is a bearer credential with an expiry, arriving as
external text. So it lives in a `#` private field with **no way to read it
back** — no getter, no `toString`, no `toJSON`, no enumeration, no spread. All
three stringification hooks are overridden to return a redaction marker, so a
value interpolated into a log line prints `[redacted provider output locator]`
rather than `[object Object]` (or, after some future refactor to a plain object,
the credential itself).

Nominal, not structural: `#validated in value` is true only for objects this
class constructed. That matters at the observation boundary, where **a raw string
URL is refused**. If a string were accepted, a vendor's response text would
travel through the orchestrator as an ordinary value — spreadable, loggable,
serializable — and locator secrecy would rest on nobody ever doing any of those
things by accident. Making the adapter build the opaque type moves the guarantee
from a convention to a type.

**The extraction capability a real transfer adapter will need is deliberately
absent.** Dereferencing a locator is a network capability, and it will be added
and reviewed *together with* the adapter that needs it rather than sitting here
unused and available. The consequence, stated plainly: this phase can carry a
locator from a status source to a transfer port and prove it never leaks, but
cannot itself fetch anything with it. That is the intended shape of a dormant
phase.

The locator never enters PostgreSQL, a transition event, an audit record, safe
metadata, a result union, a batch report, or a log line — asserted by tests that
search real persisted rows for the actual signature string, not for a
placeholder.

### 6. No database transaction is open across external I/O

```text
short tenant-scoped read   → close
  → statusSource.poll      (no lock held)
  → short authoritative Phase 2H-1 mutation → close
  → transferAndVerify      (no lock held)
  → short authoritative Phase 2H-1 finalization → close
```

This is structural rather than disciplinary: the reader returns a plain value and
the ports are separate awaited calls, so there is no transaction handle in scope
to hold. Two live tests prove the property from the outside — while a fake blocks
inside `poll` (and again inside `transferAndVerify`), an independent connection
runs a real Phase 2H-1 mutation on the same attempt, taking the same
organization+cycle advisory lock, and it commits. A runner holding that lock
would make it queue instead.

### 7. Transfer is at least once, and that is the contract

Two runners can both find an attempt already `OUTPUT_INGESTING`, both reacquire a
locator, and both copy. That is accepted, not tolerated:

- the destination key is deterministic, so both write the same object;
- the future object write must be replacement-safe for identical content;
- Phase 2H-1's finalization is compare-and-set protected, so exactly one applies
  and the other replays;
- verified metadata is immutable, so a disagreement surfaces as a conflict rather
  than an overwrite;
- **no paid provider generation is repeated** — the duplicate is bandwidth, not
  money.

A database lease would buy exactly-once I/O at the price of a durable mechanism
with its own expiry, renewal and crash semantics — a lock whose holder can die.
That trade is not worth making for a duplicate download.

The cheap half is still taken: a runner that starts from `PROCESSING` or
`PROVIDER_SUCCEEDED` transfers **only if its own `beginOutputIngestion` returned
first-application**. Losing that race answers `INGESTION_ALREADY_CLAIMED` and
stops. That removes the common duplicate without a lease.

`OUTPUT_INGESTING` is the exception and the reason the state exists: an attempt
already there does **not** re-claim the transition, because for it the transition
is not something to win but something already true. That is the crash-recovery
path.

### 8. Polling is observational, not an append-only heartbeat

An `IN_PROGRESS` poll writes nothing: no event, no version bump, no timestamp, no
progress percentage. `IN_PROGRESS` is the most common answer a poller will ever
get, and recording each one would turn the transition log — the table an operator
reads during an incident — into a heartbeat feed with the real transitions buried
in it.

For the same reason there is no poll-history table and no transfer-attempt table.
Neither is needed to make a decision, and both would grow without bound in
proportion to how often a future runner happens to be scheduled.

### 9. One pass is one pass

`runProviderOutputBatchOnce` discovers bounded candidates for the three
orchestrated stages and runs each once. It does not loop, sleep, schedule itself,
own a timer, back off or retry. Discovery is Phase 2H-1's query, reused rather
than reimplemented — a second one would be a second place for the certainty
filter and the 1..100 limit rule to drift apart. `OUTPUT_VERIFIED` is not a
candidate: it is finished, and polling it would be an outbound call with nothing
to learn and a locator to leak.

Batch results carry only closed result kinds. A batch report is the thing most
likely to be logged wholesale, so it must not be able to carry a provider error, a
storage diagnostic or a locator.

### 10. The legacy WaveSpeed `getStatus` path is not wired here

The repository already contains `VideoGenerationProvider.getStatus` and a real
WaveSpeed HTTP implementation. It is deliberately not this phase's polling
contract, for reasons that are about *contract maturity* rather than code
quality:

- its status mapping is provisional candidate infrastructure, written before the
  provider-neutral certainty and completion axes existed, and adopting it here
  would freeze it as the paid-orchestration contract by accident;
- it is provider-specific, while this boundary must be answerable by a webhook, a
  poll or an operator's manual determination equally;
- importing `@app/video-providers` into `@app/domain` or `@app/database` to reuse
  the seam would put an HTTP client behind a domain interface, where no test
  would think to look for one.

A future infrastructure implementation of `ProviderCompletionStatusSource` may
route on the **persisted** `providerName` and may well call that adapter
underneath. That is a decision for the phase that writes it, with the contract
already fixed.

## Consequences

- The orchestration is complete and dormant: it decides everything and reaches
  nothing. Nothing in any application, worker or adapter source calls either
  entry point, asserted by a static test.
- The eventual network adapters plug into a contract that already refuses their
  worst habits — provider payloads smuggled beside a discriminant, raw URLs used
  as values, error text carried in result arms.
- No migration, no schema change, no new column. Phase 2H-1 already persists
  everything this phase needs.
- The at-least-once transfer semantic is now a documented contract that the real
  storage adapter must satisfy, rather than an accident it might violate.

## Alternatives considered

**Read the provider from current configuration.** Simpler, and wrong the first
time a default changes — which is the only interesting case.

**Record provider success only once a download location is in hand.** Reads
naturally as "don't record a success you can't act on". It converts a transient
acquisition problem into a permanently in-flight paid attempt.

**A database lease for exactly-once transfer.** Buys a duplicate-free download at
the price of a durable lock whose holder can die, with expiry and renewal to get
wrong. The duplicate costs bandwidth; the lease costs a class of stuck attempts.

**A branded string for the locator.** Cheaper than a class. A brand is erased at
runtime, so it is a string in every log line, spread and `JSON.stringify` — which
is precisely where a signed URL must not appear.

**Recording a transfer failure as `FAILED_RETRYABLE`.** Reuses an existing edge
and reads sensibly. It attributes the platform's storage problem to the vendor
and discards a render already paid for.

**Emitting an event per poll.** Tempting for operability. It buries real
transitions under heartbeats and grows the most-read table in an incident in
proportion to scheduling frequency.
