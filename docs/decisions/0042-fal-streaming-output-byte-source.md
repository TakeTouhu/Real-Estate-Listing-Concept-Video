# ADR-0042: The fal output byte source reads a signed URL through one narrow door, over a fail-closed policy, and stays dormant

- Status: Accepted
- Date: 2026-09-14
- Phase: 4C-3B-2H-3B-2
- Implements: ADR-0039's `ProviderOutputByteSource`, declared as a port with no
  implementation; consumed by ADR-0041's streaming transfer core
- Relates to: ADR-0016 and ADR-0038 (a transient provider output location is a
  bearer credential and is never persisted), ADR-0040 (control-plane HTTP reads
  bodies into strings; the fal queue status source), ADR-0041 (the streaming
  transfer core and its single-inspection open-result boundary), ADR-0031
  (application-owned error vocabulary, no external text)

## Context

Phase 4C-3B-2H-3B-1 shipped a concrete streaming transfer core with no real
byte source to feed it: `ProviderOutputByteSource` was a port, and the
`TransientProviderOutputLocator` it consumes had, by design, **no way to read
its raw value back**. This phase makes the first real byte source — the thing
that actually dereferences a signed fal media URL and streams the video — while
keeping the whole pipeline dormant, and it closes one deferred defect on the way.

Four decisions in this ADR belong together because they are one boundary: the
point where an opaque, credential-bearing location becomes a real network
request.

## Decision 1 — The malformed-OPEN cleanup no longer re-reads the raw result

Revision 6 of Phase 3B-1 materialized the *success* paths of the open-result
boundary but left a time-of-check/time-of-use gap on the *malformed* path: after
`parseProviderOutputByteSourceOpenResult` returned `null`, the core called a
second helper that re-read the raw `opened.kind` / `opened.stream`. A stateful
top-level getter could answer once during inspection and then throw or change on
that second read, losing the cleanup candidate and leaking a response body.

The parse-then-reinspect split is replaced by a single authority,
`inspectProviderOutputByteSourceOpenResult`, that reads every top-level property
(`kind`, `stream`) exactly once, inspects the stream once (capturing its `close`
capability first, before validating anything else), and returns either a
materialized `VALID` result or a `MALFORMED` verdict carrying the fixed defect
reason and a captured cleanup capability. The storage core acts only on that
inspection and never returns to the raw value. `close` is captured early enough
that a later validation failure — a bad body, a bad declared size, a throwing
`[Symbol.asyncIterator]`, an `ownKeys` trap — cannot lose the ability to
release; a throwing `close` getter yields no capability and does not escape.
Revision 2's semantics are unchanged: a valid stream in a bad wrapper is closed
once then `BYTE_SOURCE_OPEN_RESULT_MALFORMED`; a malformed-but-closable stream is
closed once then `BYTE_SOURCE_STREAM_MALFORMED`. `openStreamCandidate` is gone.

## Decision 2 — Locator read-back is a single subpath-gated capability with a closed return channel

The security model is stated as exactly what the implementation enforces, no
stronger:

- **`#raw` prevents ordinary structural and read access.** A `#` private field is
  invisible to spread, `JSON.stringify`, `Object.keys` and enumeration, and the
  class has no getter, `toString`, `toJSON` or inspect path that returns it.
- **The dedicated subpath is a deliberate friend capability.**
  `withTransientProviderOutputLocatorForByteSource` is installed from a `static {}`
  block inside the class — the one scope where `#raw` is legible to a helper — and
  exported **only** from `@app/domain/provider-output-byte-source-access`, never
  the `@app/domain` root.
- **Repository static guards authorize exactly one production importer** of that
  subpath: the fal byte-source adapter.
- **The callback return channel is closed.** The capability takes
  `use: (rawLocation: string) => Promise<void>` and itself returns
  `Promise<void>`, so it cannot hand the raw string back out through its own
  result — it is not a general-purpose unwrap function. A `@ts-expect-error`
  regression proves a direct-extraction callback (`async raw => raw`) is a type
  error; a mutation that restores a generic `<T>` result channel is killed by
  that failing typecheck.

What this design does **not** claim, and an earlier draft wrongly did: that a
trusted callback keeps the raw string confined to its lexical lifetime. It
cannot. The authorized adapter is ordinary code, and once it has intentionally
been handed the string, JavaScript cannot prevent it writing the value into
outer mutable state. The enforceable guarantee is narrower and honest — the
authorized adapter is the only production code that ever receives the string at
all, and the capability itself is not a channel for pulling it out — not that
the language provides runtime information-flow isolation after disclosure.

## Decision 3 — fal output routing is fail-closed to signed `fal.media`

`isAuthorizedFalOutputUrl` accepts only an absolute `https:` URL whose host is
exactly `fal.media` or ends in `.fal.media`, with no userinfo, no explicit port,
no fragment, and a path under `/files/`. Query parameters — where the signed
credential lives — are allowed and never rewritten. Every look-alike is refused:
`fal.media.evil.example`, `evilfal.media`, `fal.media@evil.example`, a
`user:password@` authority, an explicit port, a scheme downgrade, a loopback IP.
The verdict is a boolean; the candidate URL is never logged or returned.

The policy is applied **twice**, on purpose. First in the fal result mapping:
`parseFalH3MaxOutputUrl` returns `null` for an unauthorized `video.url`, so an
unauthorized location becomes `SUCCEEDED` with `outputLocator: null` — provider
execution success is still recorded, never a failure. Second in the byte source:
the raw locator is re-validated immediately before every request, including the
first and every redirect target, because a locator that was authorized when
constructed is not assumed to be safe network authority now.

## Decision 4 — The output GET carries no key, and redirects are manual

The signed URL **is** the authorization, so the GET carries no `Authorization`
header, no `FAL_KEY`, no cookies. Adding one would send our submission
credential to a media host that does not need it. The existing string-body
`HttpClient` is not reused: it reads a whole response into a `string`, right for
a status poll and catastrophic for a video. The byte source streams through a
narrow, injectable fetch seam — one chunk pulled per consumer iteration, nothing
read ahead, the whole body never held — and never calls `.text()`, `.json()` or
`.arrayBuffer()`.

Redirects are followed manually, at most three, each `Location` resolved against
the current URL and re-validated against the same fal output policy *before* the
next request. A redirect to any other host is refused before a byte leaves. A
non-200 final response, a network rejection, a missing or over-budget redirect,
or a body that cannot be read is `RETRYABLE_FAILURE` — this source has no
evidence a fetch failure is permanent, and provider success is a separate,
already-recorded fact. `Content-Length` is read only as a preflight hint and is
`null` unless it is a positive safe integer; the transfer core's count of the
bytes that actually arrive remains authoritative.

The default fetch seam, backed by the runtime `fetch`, exists for a future
wiring to inject but is never constructed in production here. It asks for
`redirect: "manual"` so that the *adapter* owns redirect policy and
re-validation, never the transport. How a runtime surfaces a manual-redirect
response is a runtime detail this code does not depend on — Node's global fetch
(Undici) exposes the real redirect status and `Location`, while a browser fetch
returns an opaque `status: 0` response — and either way production must never
rely on the transport following a redirect on its own. The redirect routing is
exercised through an injected seam that exposes the real status and `Location`,
and that seam is the test authority.

## Decision 5 — A good HTTP status is not the end of acquisition: a mid-stream interruption is retryable, never a truncated output

The open path already maps a failed *open* to `RETRYABLE_FAILURE`. But a byte
source can open cleanly — a 200, the first chunks flowing — and then have its
body fail: a CDN drops the connection, a socket resets, `read()` rejects with the
download only partly delivered. Left unhandled, that rejection propagates out of
the stream iterator, the transfer core rethrows it, and the Phase 2H-2 runner
records `TRANSFER_SOURCE_FAILED` — treating a transient acquisition failure as an
adapter defect. Worse, if such a read were ever mistaken for clean end-of-stream,
the partial bytes already staged would be hashed and published as a short, corrupt
output. Both are wrong: an interrupted download is the same transient condition
`open` reports, discovered later, and it must be retryable and must discard the
partial bytes.

The contract gains exactly one application-owned control signal,
`ProviderOutputByteStreamRetryableFailure`, living in the provider-output
byte-source domain module where both the fal adapter and the streaming transfer
core can reference the same type. It is nominal (a private `#marker` brand,
recognized by a static `is()` guard) and deliberately empty: it carries **no**
provider or network error object, no `cause`, no raw URL, no query signature, no
host or IP, no runtime exception text, no provider-controlled message, and no
serialization of the original rejection. It is not a general error transport — it
means exactly "expected retryable source-stream interruption" and nothing else.

- **The fal adapter** wraps `body.read()` in a `try/catch`. A rejection throws
  `new ProviderOutputByteStreamRetryableFailure()`; the caught value is discarded
  unread at that boundary — never inspected, logged, attached as a cause,
  stringified, or serialized into the signal. A `null` is still real end of
  stream, and a non-`Uint8Array` chunk is still passed through for the core's
  malformed-chunk authority to reject — a partial read is never allowed to
  masquerade as clean completion. The idempotent close still releases the
  response exactly once on this path as on every other.
- **The transfer core** recognizes the signal nominally on the iteration-failure
  path: it aborts the staging session (discarding every partial byte), then
  returns `{ kind: "RETRYABLE_FAILURE" }` — it does **not** rethrow the signal and
  does **not** hash, commit, publish, or produce a receipt for the partial bytes.
  Recognition is narrow: every other error — a malformed chunk, a sink write
  refusal, an adapter-contract defect, any unexpected throw without the brand —
  keeps its existing meaning and propagates unread.
- **The runner** needs no change: it already maps a transfer `RETRYABLE_FAILURE`
  to `TRANSFER_RETRYABLE_FAILURE`, leaving the attempt `OUTPUT_INGESTING` with no
  provider-failure transition, no reservation or quota change, and no
  finalization. A later run resumes against the same deterministic key.

## Why this phase remains dormant

The dormancy claim narrows in exactly one respect: a concrete fal
`ProviderOutputByteSource` now exists. Everything else holds. Nothing in
production constructs the fal byte source or the transfer core; no durable
`ManagedOutputStagingSink` exists; no composition joins byte source, transfer
and sink; the Phase 2H-2 runner has no production caller; there is no `FAL_KEY`
in the environment schema, no scheduler, no cron, no daemon, no worker loop, no
real fal request in any test, no paid submission, no Scene delivery, no Job
readiness transition, no quota consumption, no `SYSTEM_RECOVERY`, no pricing or
resolution-contract change, and no migration. The static suites assert each of
these rather than describing them.

## Consequences

- The deferred Phase 3B-1 malformed-OPEN cleanup P2 is closed.
- The repository now contains code that would GET an already-issued fal output
  URL and stream it, gated behind a credential and a composition that do not
  exist. Activating it — real `FAL_KEY`, a durable sink, a production
  composition, a scheduler — is a later, explicit CTO phase.
- A future change that widens the fal output host family, follows a redirect
  without re-validation, attaches a credential to the GET, buffers the body, or
  exposes locator read-back from the domain root is caught by a focused test or
  the access guard, and gets the review it needs.
- A mid-stream interruption of an already-open body is now a retryable
  acquisition failure rather than a provider failure or a truncated publish. A
  future change that rethrows the raw network error across the fal boundary, or
  that lets the transfer core rethrow the retry signal instead of returning
  `RETRYABLE_FAILURE`, is caught by the fal-adapter, transfer-core, dormant
  data-plane, and live-PostgreSQL runner regressions (mutations M38 and M39).
