# ADR-0043: The durable managed-output sink publishes through an S3 multipart upload against the canonical key, and stays dormant

- Status: Accepted
- Date: 2026-09-15
- Phase: 4C-3B-2H-3B-3
- Implements: ADR's `ManagedOutputStagingSink` (declared in Phase 2H-3B-1 with no
  durable implementation); consumed by ADR-0041's streaming transfer core
- Relates to: ADR-0041 (the streaming transfer core and its first-publish-wins
  contract), ADR-0042 (the fal streaming byte source and the mid-stream retry
  signal), ADR-0031 (application-owned error vocabulary, no external text),
  Phase 2H-1 (the managed-output integrity receipt authority)

## Context

Phase 2H-3B-1 shipped a concrete streaming transfer core and Phase 2H-3B-2 the
concrete fal byte source, but the third piece — a durable
`ManagedOutputStagingSink` — existed only as a deterministic test fake. This
phase adds the first real one, backed by Amazon S3, while keeping the whole
pipeline dormant: nothing in production constructs it, no `S3Client` is built,
and no bucket credential exists.

## Decision 1 — S3 multipart upload *is* the invisible staging, targeting the canonical key directly

The staging contract requires two properties: writing bytes must not touch the
canonical destination until commit, and the first writer to publish a key wins
and is never overwritten. The S3 multipart lifecycle gives both without inventing
a second temporary object and copying:

- `CreateMultipartUpload` and `UploadPart` never expose a completed object at the
  destination key. The in-flight upload *is* the invisible staging area.
- Only `CompleteMultipartUpload` publishes the canonical object.

So the multipart upload targets the **canonical key directly** —
`org/{organizationId}/generations/{attemptId}/output`, extensionless, unchanged
from Phase 2H-1. There is no canonical-adjacent staging object and no
overwrite/copy step. A temporary-object-plus-rename design would add a second key,
a second failure mode, and a window in which two objects exist; the multipart
upload avoids all three.

## Decision 2 — Publication happens only through a conditional completion; `If-None-Match: *` is the first-publish-wins authority

`CompleteMultipartUpload` accepts an `If-None-Match: *` precondition: it publishes
only when no object exists at the key. That makes first-publish-wins atomic at the
key itself, with no read-then-write race:

```text
no canonical object   → conditional completion succeeds → PUBLISHED
key already published  → 412 Precondition Failed → this session lost
                       → best-effort abort, GET + stream-verify the winner
                       → EXISTING(winnerReceipt)
409 ConditionalRequestConflict → best-effort abort → RETRYABLE_FAILURE
```

The sink never completes without the precondition — a completion without it is an
ordinary overwrite and is never issued. There is deliberately **no** preflight
"does the object already exist?" read as the correctness mechanism: such a read
races with a concurrent publisher. Correctness comes only from the conditional
completion. A `HEAD` optimization is unnecessary and absent this phase.

## Decision 3 — ETag is not an application hash; per-part SHA-256 is required

The application integrity receipt — the SHA-256 and byte count over the exact
ordered source bytes — is computed by the streaming transfer core, and the sink
neither recomputes nor replaces it. What the sink adds:

- It partitions the same ordered bytes without modification and attaches each
  part's SHA-256 (Base64) to its `UploadPart`, with the multipart upload created
  for SHA-256 checksums. S3 validates each part's checksum.
- The multipart **ETag is never treated as an application hash.** A multipart
  ETag is a digest-of-digests with a part-count suffix, not the object's MD5 and
  certainly not the application SHA-256. It is used only to identify a part in the
  completion list.

When this session loses the race, the winner's receipt is produced by **streaming
the actual canonical bytes back and hashing them incrementally** — never by
trusting an ETag, a `Content-Length`, or object metadata. `Content-Length` is a
preflight bound only; the streamed byte count is authoritative, and the 512 MiB
ceiling (`MAX_MANAGED_PROVIDER_OUTPUT_BYTES`, reused, never duplicated) is enforced
during the read-back. A winner that cannot currently be read or fully verified —
a failed GET, a body that rejects mid-stream, an absent body, an over-ceiling or
zero-byte object — is `RETRYABLE_FAILURE`, never an unverified `EXISTING`.

## Decision 4 — A storage write interruption is a retryable acquisition failure, not a defect

`ManagedOutputStagingSession.write()` returns `Promise<void>` and so has no arm to
say "not now". A dropped or throttled `UploadPart` mid-transfer is an ordinary
storage hiccup, not an adapter defect and not a provider failure. The sink catches
the SDK rejection at its seam boundary, discards it unread, and — on the write
path — throws one application-owned, secret-free signal,
`ManagedOutputStagingRetryableFailure` (a private `#marker` brand, recognized
nominally). It carries no raw SDK exception, no `cause`, no bucket, no key, no AWS
request ID, no endpoint, no credential, no provider URL, and no external message.
The transfer core recognizes it on the iteration path — narrowly, alongside the
provider stream's signal — aborts staging, and returns `RETRYABLE_FAILURE`; the
Phase 2H-2 runner leaves the attempt `OUTPUT_INGESTING` with the reservation
untouched. An unbranded error keeps its existing meaning and propagates. A
transient failure during the final-part flush or completion is expressed instead
through the commit outcome's own `RETRYABLE_FAILURE` arm.

## Decision 5 — Bounded memory and idempotent abort

`write` fills one bounded part buffer and flushes it only when it reaches the
configured part size (default 8 MiB, floor 5 MiB, validated as a safe integer no
greater than the managed-output ceiling); the final, possibly short, part is
flushed at commit, and never an empty one. Parts upload sequentially — the upload
is awaited before `write` resolves, which is the backpressure point — so at most
one part's worth of bytes is ever held. The whole output is never buffered,
concatenated, or turned into one array, and the existing-winner read-back is
likewise incremental. `abort` is idempotent, issues at most one
`AbortMultipartUpload`, is a no-op after a successful publish, and swallows its own
failure so it can never replace the primary outcome. Production S3 infrastructure
should carry an incomplete-multipart lifecycle rule as defense-in-depth cleanup
for aborted or abandoned uploads; **no infrastructure (Terraform/CDK) is added in
this phase.**

## Decision 6 — The SDK is a dependency; the sink depends on a narrow seam

`@aws-sdk/client-s3` is added to `@app/storage`. The sink itself imports none of
it: it consumes a five-method `S3MultipartClient` seam
(create/upload/complete/abort/get), injected through the constructor, so tests
drive the whole multipart lifecycle with a deterministic fake and no network. The
one place the real SDK is used is `s3-client-adapter.ts`, which maps a real
`S3Client` onto the seam — and it is constructed nowhere in production. No AWS
credential, no `S3_BUCKET`, and no change to the environment schema.

## Why this phase remains dormant

The repository now contains every real provider-output data-plane piece — the fal
byte source, the transfer core, and the S3 sink — but no production code joins or
executes them. There is no production construction of the sink, the core, the fal
source or an `S3Client`; no bucket credential; no `FAL_KEY`; no production caller
of the Phase 2H-2 runner; no scheduler, cron, daemon or worker loop; no real fal
or AWS request in any test; no paid submission, Scene delivery, Job readiness,
quota consumption, `SYSTEM_RECOVERY`, pricing or resolution change; and no
migration or schema change. The dormancy static suite asserts each.

## Deliberately deferred — media/format validation

This phase proves **byte integrity and durable atomic publication**, nothing more.
It does not add an MP4 magic-number check, ffmpeg/ffprobe, or Content-Type
inspection, and it does not claim that S3 byte integrity proves valid video. A
SHA-256 and a byte count say the object at the key is exactly the bytes that were
streamed; they say nothing about container, codec, or playability. Format
validation belongs to a later, reviewed package, and the key stays extensionless
until then.

## Consequences

- A durable managed-output sink now exists, gated behind a client, a bucket and a
  composition that do not exist. Activating it — a real `S3Client`, a bucket
  credential, a production composition, a scheduler — is a later, explicit CTO
  phase.
- A future change that drops `If-None-Match: *`, returns the loser's receipt on a
  412, trusts an ETag/Content-Length instead of streaming the winner, omits a
  part's SHA-256, lets a raw SDK rejection escape instead of the retry signal,
  buffers the whole object, or reintroduces the browser-only manual-redirect claim
  is caught by a focused test or the mutation ledger (M40–M47).
- The Node/Undici manual-redirect documentation note carried from Phase 3B-2 is
  corrected: the adapter owns redirect policy and re-validation, and production
  never relies on the transport following a redirect on its own.
