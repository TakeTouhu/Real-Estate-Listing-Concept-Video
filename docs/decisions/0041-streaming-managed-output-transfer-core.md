# ADR-0041: Bytes are streamed, staged, hashed and published once — and the first publish wins

- Status: Accepted
- Date: 2026-09-14
- Phase: 4C-3B-2H-3B-1
- Implements: ADR-0039's `ManagedOutputTransferPort`, which was declared as a
  port with no implementation
- Relates to: ADR-0008 (`LocalObjectStorage` is a development adapter),
  ADR-0038 (managed output integrity is measured, never reported), ADR-0039
  (at-least-once transfer, no transaction across external I/O), ADR-0040
  (control-plane HTTP reads bodies into strings)

## Context

Phase 2H-2 declared `ManagedOutputTransferPort` — "copy this locator to this
key and tell me the digest" — and shipped nothing behind it. Phase 2H-3A added
the control-plane adapter that produces the locator. This phase adds the core
that would consume it: the part that pulls bytes, bounds them, hashes them,
stages them and makes them canonical.

It does so **without a real byte source and without a real object store**. The
two things the core needs in order to act do not exist in the repository; the
only implementations of either contract are deterministic fakes under
`@app/storage/testing`. That is deliberate in the same way Phase 2H-2 was: the
properties that are expensive to get wrong — bounded memory, bounded size,
exactly-once cleanup, first-publish-wins, receipt recovery after a crash — are
all decidable without a network, and settling them first means the eventual
fal source and durable store are written against a core whose behaviour is
already proved.

## Why neither existing piece is reused

**The provider `HttpClient` reads a response into a string.** That is the right
shape for a status poll — a few hundred bytes of JSON, read once, parsed once —
and the wrong shape for a generated video that may be half a gigabyte.
Extending it to stream would put a data-plane concern inside a control-plane
client whose entire contract is "one request, one string body, no retries".
The two planes get separate, narrow contracts: `ProviderCompletionStatusSource`
asks a question; `ProviderOutputByteSource` opens a stream.

**`LocalObjectStorage` takes a whole `Uint8Array` and keeps it in process
memory.** ADR-0008 already records that it is a development adapter. Adapting it
into a staging sink would mean buffering a complete video to hand it a complete
array — the exact thing a streaming core exists to avoid — and would put a
non-production adapter one import away from the generated-video path. It is
left untouched, still serving customer photos, still refusing to run in
production.

## Decision

### 1. `ManagedGenerationOutputKey` is branded, and the helper is its only constructor

While no writer existed, a plain `string` alias documented provenance well
enough. A real writer needs the type to *enforce* it. The key is now
`string & { [brand]: "ManagedGenerationOutputKey" }`, produced only by
`managedGenerationOutputKey(organizationId, attemptId)`, and consumed by the
transfer input and the staging sink. It remains assignable wherever an ordinary
string is required — the database column, an object-store call — so nothing
downstream changes; what changes is that a string cannot become a transfer
destination without an explicit, greppable cast. The shape is unchanged:
`org/{organizationId}/generations/{attemptId}/output`, no extension, no MIME.

### 2. The byte source is a pull-based stream with a declared size it is not trusted about

`ProviderOutputByteSource.open(locator)` yields `OPEN { stream }` or
`RETRYABLE_FAILURE`, and a thrown value means the adapter itself failed. The
stream is an `AsyncIterable<Uint8Array>`, a `declaredSizeBytes` that is `null`
or a positive safe integer, and a `close()`.

Pull, not push. The consumer iterates, and the source produces a chunk only when
asked. That is what makes backpressure a property of the loop that reads rather
than a feature the source has to implement, and it is what a `for await` over a
body awaiting `session.write` gives for free.

The declared size is a preflight optimization and nothing more. Over the limit,
it refuses the transfer before staging anything. Under the limit, it proves
nothing: the actual streamed bytes decide both the count and the limit. A
`Content-Length` is a claim, and the platform records what it measured.

### 3. 512 MiB is the ceiling, and the configured limit is refused rather than clamped

`MAX_MANAGED_PROVIDER_OUTPUT_BYTES = 536_870_912` is an internal safety limit —
not a customer contract, not a product claim about video sizes. It bounds what
one transfer may pull through this process before anyone has verified anything.
A deployment may configure lower; a configuration asking for more, or for zero,
a fraction, `NaN` or a string, is refused at construction. Clamping would hide
the mistake behind a limit nobody chose.

### 4. Actual bytes decide everything

Every chunk is counted before it is hashed or written. The first chunk that
takes the total over the limit is neither hashed nor written; the loop returns,
which closes the iterator, which is the source's cue to stop. A body that
completes with zero bytes is refused: a zero-byte object is not a small video,
it is a failed copy that happened to create the destination, and Phase 2H-1
already refuses a zero byte count at finalization. Neither case creates a
canonical object, and neither is a provider failure.

### 5. SHA-256 is incremental, and nothing holds the body

`createHash("sha256")` is updated chunk by chunk and finalized once, after the
loop. There is no array of chunks, no `Buffer.concat`, no `arrayBuffer()`, no
read-ahead. The backpressure test proves the property behaviourally — with the
sink blocked on its first write, exactly one chunk has been pulled — and a
source-level guard refuses the obvious ways of defeating it.

### 6. Staging is invisible, and commit is the only way to the canonical key

`ManagedOutputStagingSink.begin(destinationKey)` opens an isolated session;
`write(chunk)` stages; `commit(receipt)` publishes or reports; `abort()`
discards. Nothing this core does touches the canonical destination: it writes
to a session and asks the sink to publish. Whether publication is a rename, a
multipart completion or a conditional put is the sink's business and is not
chosen here. What the core relies on is that until `commit` says `PUBLISHED`
the key is untouched, so a crash mid-copy leaves nothing a later run has to
reason about.

### 7. First publish wins, and the loser gets the winner's receipt

Phase 2H-2 permits at-least-once transfer for an attempt already
`OUTPUT_INGESTING`, so two sessions racing to one key is an expected state of
the world. The commit outcome is closed at three arms:

```text
PUBLISHED          the staged bytes are now canonical
EXISTING           something else already published; here is *its* receipt
RETRYABLE_FAILURE  not now
```

Once a canonical object exists at a key, no later session replaces it — not
with the same bytes, not with different ones. The second download may differ
for any number of reasons: provider inconsistency, a changed temporary locator,
corruption, a test mutation. Those bytes must not overwrite an object a prior
runner may already have verified.

`EXISTING` carries the canonical object's receipt because that is what makes
crash recovery work. Runner A publishes and dies before the database learns of
it; runner B resumes, downloads again, stages bytes that may differ, and
commits. B must finish the *database* against what is *actually at the key*, so
the sink hands back A's receipt and the core reports that one — not the receipt
for B's abandoned bytes. The receipt is `unknown` here and stays unknown: Phase
2H-1's finalization is the single authority on whether a digest and byte count
are real.

**No transfer lease is added.** A lease would buy a duplicate-free download at
the price of a durable lock whose holder can die, and a lease column would be a
migration. First-publish-wins gives the property that matters — one canonical
object, never overwritten — without either.

### 8. Cleanup is exactly once, best effort, and never the answer

`close()` is called exactly once after every successful open, on every path out:
success, size refusal, iteration failure, sink failure, commit failure, defect.
`abort()` is called on every failure after `begin` and never after `PUBLISHED`
or `EXISTING`, whose cleanup the sink owns. Both are best effort: a throw from
either is swallowed without being read, and never replaces the transfer's
primary result. A future HTTP source will use `close` to release its response
body; a future store will use `abort` to delete its temporary object.

The rule extends to a source that answered *outside* its contract, and the
first revision of this phase got that half wrong. If a malformed open result is
at least `{ kind: "OPEN", stream: <object> }`, the stream candidate is closed
once, best effort, before the defect is raised — **whether or not the stream
itself is well formed.** The original selection released a candidate only when
the stream was malformed, which is backwards: a valid stream inside a wrapper
carrying an extra key is exactly the handle most likely to be holding a real
response body. Which defect is raised is a separate question, decided by the
stream's own validity: a valid stream in a bad wrapper is
`BYTE_SOURCE_OPEN_RESULT_MALFORMED`; a malformed stream is
`BYTE_SOURCE_STREAM_MALFORMED`; a non-OPEN result gets no cleanup at all. And
*obtaining* `close` is inside the best-effort guard, not just invoking it: a
hostile handle with a throwing `close` getter must not replace the fixed defect
with its own error, and the domain predicate that inspects a stream is total
for the same reason.

### 9. Expected failures return; defects throw; nothing is a provider failure

Source unavailable, declared or actual oversize, empty body, sink busy — each
returns `RETRYABLE_FAILURE`, and Phase 2H-2 leaves the attempt
`OUTPUT_INGESTING`. A malformed open result, a non-bytes chunk, a commit result
outside the closed union — each throws `ManagedOutputTransferDefect` with fixed
text and a closed code, and Phase 2H-2 records `TRANSFER_SOURCE_FAILED` with the
same non-mutation. The defect carries no value, no `cause`, no message from the
adapter: a malformed commit result may be a raw storage response with a signed
URL in it.

That boundary holds against a hostile *object*, not only a hostile *shape*.
The sink's commit result is read exactly once, under a guard, into a fresh
plain object — `parseStagingCommitOutcome` — and the raw value is never
consulted again. A `kind` getter that throws is `null` there, and the core
raises `STAGING_COMMIT_RESULT_MALFORMED` after aborting staging; a getter that
answers once and throws on a second read never gets a second read, because the
dispatch runs on the materialized copy. The predicate
`isWellFormedStagingCommitOutcome` is total for the same reason. Without this,
the second revision let an adapter-controlled exception escape the predicate —
after the `commit` guard had already passed, so the staging abort was skipped
as well — and replace the fixed defect with the adapter's own text.

The same discipline reaches one boundary further down. An `EXISTING` receipt
travels to Phase 2H-1 as `unknown`, so Phase 2H-1's own receipt authority must
be total and materializing too — it now is (ADR-0038, amendment of
2026-09-14). A sink receipt whose `sha256` or `sizeBytes` getter throws is the
closed `RECEIPT_MALFORMED` there and `TRANSFER_OUTCOME_MALFORMED` from the
orchestration, with the attempt left ingesting and nothing of the getter in any
result, row or event. The third revision had closed this class at the commit
boundary and left it open at the receipt boundary; there is no second receipt
validator in the core or the runner, because the fix belongs to the authority.

Totality has to begin one step earlier than any of those guards. Every parser
and predicate above asks the shared `isPlainRecord` first, *before* opening its
own `try`, and that helper's `Array.isArray` is a question the runtime itself
can refuse to answer: a revoked `Proxy` still says `"object"` to `typeof` and
then throws a `TypeError` from `IsArray`. The fourth revision left that path
unguarded, so a revoked Proxy escaped every boundary ahead of the guard each
one had just been given. The fix is in the helper, once — `isPlainRecord` is
total, and a value that cannot be asked whether it is an array is not a record
— rather than a revoked-Proxy catch copied into each parser.

Where such a value can arrive in this pipeline is narrower than "anywhere an
adapter answers", and the tests say so rather than pretending otherwise. A
revoked Proxy cannot cross an `await`: promise resolution reads `.then` on the
value, and that read throws *inside the adapter's own promise*, so a whole open
result or a whole commit result that is a revoked Proxy never reaches the core
as a value — it reaches the core as the adapter's throw, which is handled as
every adapter throw is (abort staging if begun, close the source if opened,
propagate; `TRANSFER_SOURCE_FAILED` from the orchestration). What does cross
an `await` intact is a revoked Proxy held as a *property* of an answer: the
`stream` inside an `OPEN` result, or the receipt inside `EXISTING`. Those are
the reachable arrival points, and at each the result is the existing closed
outcome with nothing of the runtime's text in it: `BYTE_SOURCE_STREAM_MALFORMED`
from the core (its candidate cleanup was already guarded), and
`RECEIPT_MALFORMED` from Phase 2H-1 → `TRANSFER_OUTCOME_MALFORMED` from the
orchestration, attempt left ingesting.

The same *validate-then-reuse* gap that made the staging commit outcome and the
receipt boundaries into materializing parsers existed at three more `unknown`
boundaries, and the sixth revision closes them the same way rather than with
scattered `try/catch`. Each returns `unknown` by contract, each was checked by a
predicate, and each was then **re-read** by its consumer *outside* the `await`
that produced it — so a live Proxy whose `.then` is harmless (it crosses the
await) but whose `kind` getter or `ownKeys` trap throws would escape as a raw
adapter error, and a getter that answered validly during validation and
differently on a second read would pass the predicate and then act on a value
nobody validated:

- **The transfer outcome.** `parseManagedOutputTransferOutcome` reads `kind`
  once, the own keys once, and the `VERIFIED` receipt once, into a fresh object;
  the runner acts on that copy and never re-reads the raw port result. The
  receipt reference is carried through untouched — its contents remain Phase
  2H-1's question.
- **The poll observation.** `parseProviderPollObservation` reads `kind`, the own
  keys, `outputLocator`, `retryable` and `diagnosticCode` once each, into a
  fresh object; the orchestrator dispatches on that copy several times without
  returning to the raw source value. The already-constructed
  `TransientProviderOutputLocator` is preserved by reference — never rebuilt,
  stringified or inspected — and a malformed observation is `null`, never read
  as `FAILED`, because that would manufacture a paid attempt's terminal state
  from a value nobody defined.
- **The byte-source open result and stream.** The predicates were total against
  *immediate* getter failures but stayed predicates, so the core re-fetched
  `stream.declaredSizeBytes`, `stream.body` and `stream.close` from the raw
  handle during use. `parseProviderOutputByteStream` now reads each once and
  returns a captured stream: `body`'s async-iterator capability is looked up
  once and re-exposed as a plain method bound to the original body, so a
  `for await` never re-reads a hostile `[Symbol.asyncIterator]`; `close` is
  captured as a function and invoked against its original receiver, so an
  inherited method still sees the right `this`. No bytes are buffered and
  backpressure is unchanged. Class instances remain supported: exact own keys
  are required of the wrapper, never of the handle. The Revision 2 malformed-OPEN
  cleanup is untouched — an OPEN-shaped wrapper carrying a closable stream
  candidate is still best-effort closed before the fixed defect, and cleanup
  failure never replaces it.

### 10. The locator is passed through, still unread

The core hands the opaque locator to the source and does not look at it. There
is no accessor to call — `TransientProviderOutputLocator` still has no raw
getter, and none is added — and the core does not need one: which bytes the
locator names is the source's problem, and which bytes arrived is the only thing
the core measures. The dereference capability remains deferred to the concrete
fal byte-source phase, and is reviewed with it.

### 11. Media format is still unverified

The receipt proves a SHA-256 digest and a byte count. It does not prove an MP4
container, a codec, a resolution, a duration, playability or a MIME type. No
`ftyp` box is inspected, no `ffprobe` runs, no MIME is persisted, no extension is
appended. Media validation remains a delivery-readiness prerequisite for a later
phase, and the key stays extensionless until something actually verifies a
format.

## Consequences

**Accepted.** Two concurrent transfers of one attempt both download the full
output; only one publishes. The duplicate is bandwidth, not money, and it is the
cost of not adding a lease.

**Accepted.** A source that lies about its size in the *downward* direction is
caught by the actual count and costs a full download before refusal. The
alternative — trusting the header — is worse in every case that matters.

**Accepted.** `EXISTING` is reported as `VERIFIED` with a receipt the core did
not compute. Phase 2H-1 validates it; a sink that returned nonsense produces
`RECEIPT_MALFORMED` there, and the attempt stays ingesting.

**Not addressed here.** The concrete fal byte source, a durable staging sink
against a real object store, media-format validation, the production
composition that would construct any of this, and the provider-contract
reverification that must precede Paid Provider Activation.
