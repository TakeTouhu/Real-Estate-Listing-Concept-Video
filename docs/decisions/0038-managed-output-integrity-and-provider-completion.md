# ADR-0038: A provider finishing, a copy landing and bytes being proved are three different facts

- Status: Accepted
- Date: 2026-09-08
- Phase: 4C-3B-2H-1
- Extends: ADR-0036 and ADR-0037, which decided how an attempt reaches and leaves
  the provider boundary; this ADR decides what happens to it afterwards
- Relates to: ADR-0035 (the submission-certainty axis), ADR-0016 (provider
  references are internal), ADR-0024 (the row is the queue), and the Phase
  4C-3B-2F-1 lock order this phase joins unchanged

## Context

By the end of Phase 4C-3B-2G-2 an attempt could be `PROCESSING + ACCEPTED`: a
provider had admitted to taking the work, a prediction reference was on file, and
a customer's unit was reserved against it. Nothing could record what happened
next. The provider would finish, or fail, or produce an output nobody copied, and
the row would say `PROCESSING` forever.

Filling that gap is mostly a matter of resisting three collapses, each of which
is convenient and each of which costs money or trust.

**"The provider finished" is not "we have the video."** A provider's output lives
at a temporary URL on someone else's infrastructure, typically for hours. An
attempt that records success and stops has recorded a fact that expires. If the
copy is treated as an implementation detail of the same transition, then the
moment a copy fails there is no state left to describe the situation — the row
says the platform has an output it does not have.

**"We have the video" is not "we have proved it is the video."** A copy that
transfers 80% of an object and stops leaves a real key pointing at a real object
of the wrong length. Nothing about the storage API distinguishes that from
success. Without a digest and a byte count taken deliberately, `OUTPUT_VERIFIED`
is a label an application bug can apply to a row describing nothing.

**A copy failing is not the provider failing.** This is the expensive one. When
the platform's own storage write fails, the provider has already run the GPU job
and will bill for it. Recording that as a provider failure puts an internal fault
into the provider's reliability record, and — because a failure is terminal —
throws away an output that is still sitting there, retrievable, under a key the
attempt could re-derive. The platform would pay twice for one render and blame
the vendor for its own bug.

## Decision

### 1. Five states, and they mean five different things

```text
PROCESSING + ACCEPTED
  → PROVIDER_SUCCEEDED + ACCEPTED       the provider finished
  | FAILED_RETRYABLE   + ACCEPTED       it accepted, then failed; retry allowed
  | FAILED_TERMINAL    + ACCEPTED       it accepted, then failed; retry pointless

PROVIDER_SUCCEEDED → OUTPUT_INGESTING   a copy into managed storage is under way
OUTPUT_INGESTING   → OUTPUT_VERIFIED    the bytes have been hashed and counted
```

Every edge is the committed attempt state machine's; no second transition table
exists anywhere in this phase, and the repository teaches the domain nothing.

That dependency is **load-bearing rather than documentary**, in two layers.

The completion write names a closed landing type:

```ts
type ProviderCompletionLandingState =
  "PROVIDER_SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_TERMINAL";
```

The wide `GenerationAttemptState` made `CompletionWrite` a general-purpose
state-setter: a caller holding a session could construct
`{ orchestrationState: "OUTPUT_INGESTING" }` and move a `PROCESSING` attempt
straight past `PROVIDER_SUCCEEDED` — recording that a copy is under way for work
nothing says finished. The closed type makes that unspellable.

And the persistence boundary consults the committed table before any SQL, because
a type is not a runtime guarantee at a boundary reachable with a cast:

```text
applyCompletion         canTransitionAttempt("PROCESSING", write.orchestrationState)
applyBeginIngestion     canTransitionAttempt("PROVIDER_SUCCEEDED", "OUTPUT_INGESTING")
applyOutputVerification canTransitionAttempt("OUTPUT_INGESTING", "OUTPUT_VERIFIED")
```

A refusal is `INTERNAL_ERROR` and loud. The last two check edges that always hold
today, which is the point: if either is ever removed from the committed table,
this phase fails immediately and visibly rather than continuing to perform a
transition the domain no longer permits.

`OUTPUT_VERIFIED` is **not** delivery. The logical request is not `DELIVERED`,
the scene is not `READY`, the job is not `SCENES_READY`, and no deliverable is
reachable by a customer. Those are review-gated decisions belonging to later
phases, and reaching them from here would publish AI output without the human
approval the product rules require.

### 2. Certainty never moves after acceptance

The recurring negative, and the reason the write type has exactly one field:

```ts
interface CompletionWrite { readonly orchestrationState: ProviderCompletionLandingState; }
```

No branch can write `submissionCertainty`, the provider reference or the
acceptance instant, because no branch can name them.

A post-acceptance execution failure lands on `FAILED_RETRYABLE` or
`FAILED_TERMINAL` with the certainty **still `ACCEPTED`**. Rewriting it to
`DEFINITIVELY_REJECTED` would be the single most expensive mistake available in
this phase: `DEFINITIVELY_REJECTED` is the one certainty the Safety Guard
classifies at zero cost, so a provider that took the work, ran it and failed
would be recorded as having declined it — and the platform would forget a charge
it owes, in exactly the incident where cost matters most.

The classification this phase relies on already existed and was not modified:

```text
PROCESSING | PROVIDER_SUCCEEDED | OUTPUT_INGESTING  + ACCEPTED → IN_FLIGHT
OUTPUT_VERIFIED | FAILED_RETRYABLE | FAILED_TERMINAL + ACCEPTED → SETTLED_ESTIMATED
```

No state this phase can reach is ever classified `NONE`.

### 3. The completion evidence contract is closed and provider-neutral

```ts
type ProviderCompletionObservation =
  | { kind: "SUCCEEDED" }
  | { kind: "FAILED"; retryable: boolean;
      diagnosticCode: SubmissionDiagnosticCode | null };
```

Deliberately absent: provider URL, output URL, response body, HTTP status, vendor
status string, raw error text, credential, prompt, stack trace. The success arm
carries **no payload at all** — not even a location — because a phase that cannot
name where a provider's copy lives cannot leak one. The diagnostic reuses Phase
2G-1's closed catalog unchanged and unexpanded.

**This phase contains no way to obtain one of these.** The evidence arrives as an
argument. There is no HTTP client in the dependency graph, no polling loop, no
webhook route, no storage client and no scheduler. Whatever future layer polls,
receives a webhook or takes an operator's determination normalizes its findings
into this shape first, and this layer never learns which provider produced them.

Validation follows ADR-0037's discipline exactly: the validator takes `unknown`,
refuses non-objects and arrays, matches the discriminant **by name** so an
unrecognised `kind` is refused rather than swept into `FAILED`, checks
`retryable` with `typeof === "boolean"` rather than truthiness, and checks the
diagnostic for catalog membership. Nothing throws; malformed evidence is an
answer, with zero mutation and zero events.

### 3a. The runtime shapes are closed, not merely sufficient

A validator that checks the fields it needs and ignores the rest accepts this:

```ts
{ kind: "SUCCEEDED", providerOutputUrl: "https://provider.example/tmp/abc?sig=…" }
{ sha256: …, sizeBytes: …, outputStorageKey: …, rawProviderResponse: {…} }
```

Both carry fields the contract says do not exist. Neither would be persisted
today — the write shapes have nowhere to put them and the metadata allowlist
would drop them — but "not persisted today" is a property of three separate
downstream decisions rather than of the boundary itself. The runtime trust
boundary would be wider than the documented contract, and every later spread,
log line, error report and serialization would inherit the wider one.

So an unknown key makes the value **malformed**, in both contracts:

```text
SUCCEEDED observation   exactly { kind }
FAILED observation      exactly { kind, retryable, diagnosticCode }
verification receipt    exactly { sha256, sizeBytes }
```

Refused, never sanitized: dropping the extra field and accepting the object hides
a bug at the sender, which is where it needs fixing. One shared helper implements
the check for both contracts, over **own** properties — so a field hidden from
enumeration is still caught, an inherited `Object.prototype` method is not
mistaken for a smuggled field, and a discriminant that exists only on a prototype
does not count as declared.

### 4. The storage key is derived, never accepted — at both boundaries

```text
managedGenerationOutputKey({ organizationId, attemptId })
  → org/<organizationId>/generations/<attemptId>/output
```

Application identifiers only. No provider URL, no provider file name, no
customer file name, no prompt-derived text, no external path component. Three
consequences, all load-bearing:

- **The same attempt always derives the same key.** An interrupted copy is
  retried over its own object rather than scattering partial objects, which is
  what makes ingestion resumable at all.
- **No caller can point a verification record at an object the attempt does not
  own.** The key is computed from the tenant and the attempt, so a caller-supplied
  path is not merely rejected — there is no parameter for one.
- **The key asserts no media format.** See §4a.

The second point has to hold at the *persistence* boundary, not only at the
service. `CompletionSession.applyOutputVerification` is reachable without the
service — the same property that made tenancy a CAS-level concern in Phases 2G-1
and 2G-2 — so a key parameter there would let any caller holding a session write
an arbitrary path. It has none. The repository derives the key itself, inside the
transaction, from the organization and attempt the transaction was opened for:

```ts
applyOutputVerification({ expectedVersion, outputSha256, outputSizeBytes,
                          outputVerifiedAt, context })
```

The service derives the same key independently, for the replay comparison and to
report to its own caller. The two always agree because both are pure functions of
the same two identifiers, and neither takes the value from the other.

The same reasoning applies to the integrity facts. `Sha256Digest` and
`SafePositiveByteCount` are branded types, which is a compile-time promise about
a value someone may have cast; the repository re-proves both with the domain's own
predicates before either reaches a column an audit will treat as evidence. One
rule, used twice — not a second, subtly different one.

### 4a. The key carries no media-format extension

An earlier revision ended the key `output.mp4`. Nothing in this phase verifies
that.

A receipt proves a SHA-256 digest and a byte count. It does not prove an MP4
container, a codec, a MIME type, or that the object plays at all — and this
repository has no closed generated-video format vocabulary to check one against.
A key ending `.mp4` would assert a container nothing here established, on an
object produced by a pipeline that is meant to stay provider-neutral and may one
day return something else.

So the key is extensionless. A later phase that actually validates a format may
attach or normalize one; this phase has nothing to attach and does not invent a
vocabulary in order to have something. Legacy keys that already carry a suffix
are left exactly as they are — rewriting them would be a claim about objects
nobody re-examined.

### 5. The receipt proves bytes, and carries nothing else

```ts
interface ManagedOutputVerificationReceipt {
  readonly sha256: Sha256Digest;          // exactly 64 lowercase hex
  readonly sizeBytes: SafePositiveByteCount;  // positive, integer, safe, finite
}
```

No storage key (derived), no provider URL, no raw bytes, no MIME type.

The digest is validated against `/^[0-9a-f]{64}$/` with **no silent
normalization**: uppercase is refused rather than lowercased, because accepting
two spellings of one digest is how an equality check starts reporting identical
bytes as a corrupted output — and the equality check is the entire mechanism by
which a conflicting output is detected.

The size is refused at zero, negative, fractional, `NaN`, `Infinity` and beyond
`Number.MAX_SAFE_INTEGER`. Zero is called out explicitly: a zero-byte object is
not a small video, it is a failed copy that happened to create the destination.
No maximum is invented — the platform has no evidence about how large a
legitimate output can be, and a guessed ceiling would reject real work.

### 6. Verified output metadata is immutable — and it is the application that makes it so

Three additive nullable columns join the existing `outputStorageKey`:
`outputSha256`, `outputSizeBytes`, `outputVerifiedAt`. All four are written
together, exactly once, and never again.

**Two different mechanisms, and it matters which does what.**

The database CHECK constraints establish **completeness, format and range**:

```sql
-- completeness
CHECK ("orchestrationState" IS DISTINCT FROM 'OUTPUT_VERIFIED'
       OR ("outputStorageKey" IS NOT NULL AND "outputSha256" IS NOT NULL
           AND "outputSizeBytes" IS NOT NULL AND "outputVerifiedAt" IS NOT NULL))
-- format
CHECK ("outputSha256" IS NULL OR "outputSha256" ~ '^[0-9a-f]{64}$')
-- range
CHECK ("outputSizeBytes" IS NULL
       OR ("outputSizeBytes" > 0 AND "outputSizeBytes" <= 9007199254740991))
```

None of those is a historical guarantee. A CHECK evaluates one row against one
predicate; it has no memory of what the row said before, so it cannot tell a
first write from a second. A verified row whose key is replaced with a different
key still satisfies every constraint above — all four fields are still non-null,
the digest is still canonical, the size is still in range — while now pointing at
an object whose bytes nobody hashed.

Immutability is therefore an **application** property, established by closing
every mutation path:

- the Phase 2H compare-and-set writes the four facts only on
  `OUTPUT_INGESTING → OUTPUT_VERIFIED`, which a verified row can no longer match;
- the finalize decision answers a re-presented receipt with `REPLAYED` (identical)
  or `CONFLICTING_OUTPUT` (different), never a second write;
- the legacy `SceneGenerationRepository.update` — the one remaining application
  path that could set `outputStorageKey` — is scoped so that a key write matches
  only rows with `orchestrationState IS NULL` (see §6a).

The database's job is to make an *incomplete or malformed* verified row
impossible. The application's job is to make a *second* one impossible. Stating
the CHECK as the immutability mechanism would credit it with a guarantee it
cannot give, and would leave the real hole — a key-only update — looking already
covered.

**The legacy exception, stated exactly:** the completeness constraint keys on
`orchestrationState`, which is NULL on every row admitted before Phase 4C-3B-2E,
and `IS DISTINCT FROM` is null-safe — so those rows satisfy it unconditionally
and no exception logic exists. Nothing is backfilled. In particular a legacy
`state = 'SUCCEEDED'` row is **not** reinterpreted as an orchestrated
`PROVIDER_SUCCEEDED`: it is a historical fact recorded under a different
vocabulary, and inventing a digest, a size or a verification instant for it would
forge an integrity record nobody produced.

`outputSizeBytes` is `BIGINT` rather than `INTEGER` because the domain admits any
positive safe integer, and `int4` would silently overflow at roughly 2 GiB on a
value the validator had just accepted. The *upper* bound is
`Number.MAX_SAFE_INTEGER`, so the column's range and the application's range are
the same range: above 2^53-1 a `BIGINT` read into a JavaScript number is silently
lossy — a stored 9007199254740993 comes back as ...992 — and would then be
compared against a receipt as though it were what was written. The repository
refuses to narrow an out-of-range value regardless, because a constraint added by
a migration says nothing about a database that migration has not reached.

A second receipt describing different bytes is a **discrepancy to surface, not a
correction to apply**: `CONFLICTING_OUTPUT`, with the stored metadata untouched.
An exact replay returns `REPLAYED` and changes nothing. `outputVerifiedAt` is
deliberately excluded from the comparison — it records when *this platform*
verified, and requiring a replaying caller's fresh instant to equal the stored
one would make every replay after the first millisecond a conflict.

### 6a. The legacy repository has no authority over managed output keys

`SceneGenerationRepository.update` predates orchestration and can still set or
clear `outputStorageKey` on a row its tenant owns. On an orchestrated Attempt
that is a hole in the invariant above, and a quiet one: it moves the key alone —
no version bump, no transition event, no new verification, and no constraint
violation — leaving a verified row that reads as healthy and describes an object
it never verified.

So a **key write** (a string or an explicit `null`, as distinct from the absent
field that means "leave alone") may match only rows with `orchestrationState IS
NULL`. Managed output on an orchestrated Attempt belongs exclusively to the Phase
2H persistence boundary, which writes all four facts together under a
compare-and-set with an event.

Three properties of the refusal:

- **It is not silent.** The write matches nothing, so the caller gets this
  method's existing not-found answer and the row is untouched. A distinct error
  would be a new way to probe a row's orchestration status.
- **It is scoped to the key.** Every other field this method has always been able
  to update on an orchestrated row still updates. Blocking them would break the
  legacy execution path for no invariant's sake.
- **Legacy rows keep the old behaviour exactly.** They predate the managed-output
  contract, nothing else writes their keys, and their keys may still carry a
  historical `.mp4` suffix — which is left alone rather than rewritten.

### 7. An interrupted copy stays interrupted

The committed state machine does permit `OUTPUT_INGESTING → FAILED_*`. **This
phase does not use it, for an ingestion failure.**

There is no transition that turns a storage fault into a provider failure, and
the omission is structural rather than conventional: the completion precondition
requires `PROCESSING`, so no completion decision can land on a failure from
`OUTPUT_INGESTING` at all. An interrupted ingestion simply stays
`OUTPUT_INGESTING` — which is exactly what makes it recoverable, since the key is
deterministic, finalization is idempotent, and resuming re-POSTs nothing and
creates no new attempt.

Provider evidence that *contradicts* an in-flight copy is a different matter and
is surfaced as `CONFLICTING_COMPLETION`, not silently applied.

### 8. `FAILED_RETRYABLE` does not retry anything

A retryable post-acceptance failure records that a retry is *permissible*. It
creates no replacement attempt, and there is no `SYSTEM_RECOVERY` request kind to
create one with. Spending a second unit of provider capacity is a decision for
the recovery path, made deliberately, not a side effect of writing down what
happened to the first.

### 9. Customer entitlement is untouched, everywhere, on every path

No reservation is read for its state, locked, or written by any operation in this
phase. The absence is structural: there is no reservation handle in the
persistence module to misuse.

Specifically: no `RESERVED → CONSUMED`, no `RECONCILIATION_HOLD → CONSUMED`, no
unit decrement, no release, no charge. **A unit is not released because an
accepted execution later failed** — the provider ran the job and will bill for
it, and handing the customer's unit back would mean absorbing that cost silently
while the record showed nothing was spent. Consumption belongs with delivery,
which this phase does not reach.

The organization + billing-cycle advisory lock is still taken, on Phase 2F-1's
key and at Phase 2F-1's acquisition point, because a completion *does* move the
organization's cycle exposure between `IN_FLIGHT` and `SETTLED_ESTIMATED`. An
authorization reading exposure while a completion lands would decide on a total
that is mid-flight. Sharing one key across the four phases is also what keeps
them from deadlocking against each other.

### 10. Tenancy is proved at the mutation, with both clauses

Identical to ADR-0037 §9a and for the identical reason: `applyCompletion`,
`applyBeginIngestion` and `applyOutputVerification` are all reachable without
`loadFacts`, so a tenant-scoped read is an optional boundary rather than a real
one. The compare-and-set carries the organization predicate itself, together with
the expected state, the expected certainty and the expected `stateVersion`.

Both clauses must hold — the denormalized `videoProjectId` and the ownership
chain `Attempt → Request → Scene → Job → VideoProject`. A row whose column and
chain disagree is **frozen rather than writable by whichever tenant the
corruption happens to favour**, and that is the intended outcome: a row nobody
can move is a problem to investigate, whereas a row two tenants can move is a
breach. A cross-tenant call is answered exactly as a missing one.

### 11. One clock, read once, after the lock

`outputVerifiedAt` is the service's single post-lock instant, carried into the
write as a value. It is never caller-supplied, and the persistence layer contains
no unparameterized wall-clock read — converting an explicit validated instant,
`new Date(write.outputVerifiedAt)`, is the only permitted form, and a static
guard enforces it. A second read inside the repository would stamp the
verification with a time no lock was held for.

### 12. Four event types, and no location in any of them

```text
ATTEMPT  PROVIDER_COMPLETION_SUCCEEDED
         PROVIDER_COMPLETION_FAILED
         OUTPUT_INGESTION_STARTED
         OUTPUT_VERIFIED
```

Service-owned, never caller-chosen. Metadata carries the digest, the byte count
and the verification instant — a content digest and a number are neither customer
content, a credential, nor a location.

**`outputStorageKey` is deliberately not on the allowlist.** Where the object
lives is answered by the row. Transition history is the most widely read table in
an incident — dumped into tickets, pasted into chat, exported to whoever is
debugging — and putting a storage location into it is exactly the broadening the
allowlist exists to prevent. The sanitizer drops unknown keys silently, so the
allowlist itself is asserted directly by test rather than only its effect.

The completion diagnostic lives **only** in the event metadata. The attempt's own
`normalizedErrorCode` belongs to the original submission observation, and
overwriting it with a later execution finding would erase why the attempt reached
the provider boundary in the state it did.

### 13. Discovery is advisory and bounded

`findCompletionCandidates({ stage, limit })` returns `{ organizationId,
attemptId }` and nothing else, for one of three stages
(`AWAITING_PROVIDER_COMPLETION`, `AWAITING_OUTPUT_INGESTION`,
`RESUMABLE_OUTPUT_INGESTION`). No locks, no provider reference, no prompt, no
output location, deterministic order, and every candidate goes back through the
single-attempt service which re-reads the row under lock.

Candidates are filtered to `ACCEPTED` attempts. An unaccepted row surfacing here
would not itself be a state error — the service re-checks everything — but every
candidate is a row a worker will pick up, and a worker picking up an attempt
whose submission is still unresolved is a worker about to ask a provider about a
job that may never have been sent. The filter is what keeps the reconciliation
path and the completion path from reaching for the same row.

The limit is validated by ADR-0037's canonical validator, reused rather than
restated, with the same bound (100) and the same refusal-rather-than-clamping
rule. Two bound rules is how a limit one boundary rejects reaches the database
through the other.

There is **no scheduler, daemon, cron, interval, timer or background loop** in
this phase. Discovery is a query a future runner may call.

## Consequences

- An attempt's post-acceptance life is fully recorded, and each of the five
  states answers a question the others cannot.
- A verified managed output carries a self-contained integrity record: enough to
  re-verify the object later without trusting any other system.
- A storage fault costs one retry of a copy, never a re-render and never a false
  entry in a provider's reliability record.
- Duplicate deliveries — a re-run poll, a re-delivered webhook, a resumed worker
  — are ordinary replays at every stage, and disagreements are surfaced rather
  than silently resolved in the last writer's favour.
- Nothing is delivered, published or charged. Those remain later, review-gated
  phases, and the states this phase writes are exactly the evidence they will
  need.

## Alternatives considered

**One transition from `PROCESSING` straight to a verified output.** Simpler, and
it makes a copy failure indescribable: the row would say the platform holds an
output it does not hold, with no state in which to resume.

**Recording an ingestion failure as `FAILED_RETRYABLE`.** It reuses an existing
edge and reads naturally. It also discards a paid, still-retrievable render on an
internal fault and attributes the platform's bug to the vendor.

**Storing the provider's output URL "just for debugging."** Rejected in ADR-0016
and again here. It expires, so it is worthless as a record; it is a credential in
URL form while it lives; and once persisted it is one join away from a customer
response.

**Accepting the storage key from the caller.** Would have let the ingestion layer
own its own naming. It also means any caller can point a verification record at
any object, and the derived key is what makes a resumable retry land on the same
object rather than a new one.

**Letting a later receipt correct an earlier one.** Tempting for operability. It
makes `OUTPUT_VERIFIED` mean "the last thing anyone said", which is not a proof,
and it erases the disagreement that is the only signal something is wrong.

**A database trigger to enforce immutability.** Considered once the CHECK was
shown not to give it. Rejected because the mutation path it would have guarded —
the legacy repository's key write — can be closed in the application, where the
rule is visible to the people who have to keep it, and a trigger would have made
the wording stronger without making the system safer. If a future path cannot be
closed that way, this is the decision to revisit.

**Keeping `.mp4` on the key "because it will be MP4 anyway".** Probably true
today, of the one provider currently wired. It is still an assertion this phase
does not verify, on a boundary whose entire purpose is to stay provider-neutral,
and the cost of being wrong is a key that lies about its object.
