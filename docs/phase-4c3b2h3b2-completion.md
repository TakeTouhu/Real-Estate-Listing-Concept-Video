# Phase 4C-3B-2H-3B-2 — Dormant fal streaming output byte source

- Base: `7ff3fe66b3adf35337a3bde37f87c3b3911f3d87` (merge commit of PR #61)
- Decision record: ADR-0042
- Migration: **none**
- Paid provider activation: **still blocked**

## What this phase adds

One bundled provider-output acquisition boundary, in four parts:

1. **The deferred Phase 3B-1 malformed-OPEN cleanup P2 is closed.** The
   parse-then-reinspect split in the streaming core is replaced by a single
   authority, `inspectProviderOutputByteSourceOpenResult`, that reads each raw
   top-level property once and carries a captured cleanup capability on the
   malformed arm. The core never returns to the raw `opened` value.
2. **A narrow locator-read capability with a closed return channel.**
   `withTransientProviderOutputLocatorForByteSource(locator, use)` takes
   `use: (rawLocation: string) => Promise<void>` and itself returns
   `Promise<void>`, so it is not a general-purpose unwrap function — the raw
   string cannot be returned back out through the capability, proved by a
   compile-time `@ts-expect-error` regression. Exported only from
   `@app/domain/provider-output-byte-source-access` and, in production, imported
   only by the authorized fal adapter. The security model is stated honestly:
   `#raw` blocks structural access and the subpath gates the friend capability,
   but the language cannot confine the string once the trusted adapter has been
   handed it.
3. **A fal output URL authority**, fail-closed to signed `https://fal.media`
   artifact URLs, applied both in the fal result mapping and again immediately
   before every request.
4. **`FalProviderOutputByteSource`** — the first concrete production
   `ProviderOutputByteSource`: GET-only, no credential, manual re-validated
   redirects, a streaming body that never buffers, an idempotent close.

## The dormancy claim, precisely — as it now stands

The one thing that changed: a concrete fal `ProviderOutputByteSource` exists.

| Claim | How it is held |
| --- | --- |
| Exactly one production file implements `ProviderOutputByteSource` — the fal adapter | Static scan over `apps/*`, `packages/{database,video-providers,storage,domain}` production source |
| Nothing in production constructs the fal byte source | The same scan finds no `new FalProviderOutputByteSource` outside the adapter and its package root export |
| Nothing in production constructs the transfer core | The same scan, `new StreamingManagedOutputTransfer` |
| No durable staging sink exists | The same scan finds no production `implements ManagedOutputStagingSink` |
| The Phase 2H-2 runner has no production caller | The same scan, all three entry points |
| No `FAL_KEY` or storage credential exists | Absent from the environment schema |
| Only the authorized adapter reads the locator | Access-guard test: exactly one production importer of the byte-source-access subpath |
| No real network in tests | Both the adapter and the end-to-end test drive an injected fetch seam |

**A concrete fal output byte source exists, but no production code constructs
it, no durable managed-output staging sink exists, and no production composition
can execute the transfer path.**

## The deferred P2, closed

| Property | Held by |
| --- | --- |
| Raw `kind` read at most once | `inspectProviderOutputByteSourceOpenResult` reads `value.kind` into a local; the core acts only on the inspection |
| Raw `stream` read at most once | The same inspection reads `value.stream` into a local once; no `openStreamCandidate` re-read remains |
| Stream `body` / `[Symbol.asyncIterator]` / `declaredSizeBytes` / `close` each read at most once | `inspectProviderOutputByteStream` reads each once; the captured stream re-exposes the iterator factory as a plain method and invokes the captured close against its original receiver |
| Cleanup preserved through a later validation failure | `close` is captured **first**, before body/size/iterator validation; a bad body, size, iterator or `ownKeys` trap still yields the captured cleanup |
| A throwing `close` getter yields no capability and does not escape | The capture is guarded; the getter's error becomes "no cleanup", never a thrown value |
| Fixed defect classifications preserved | Valid stream in a bad wrapper → `BYTE_SOURCE_OPEN_RESULT_MALFORMED`; malformed-but-closable stream → `BYTE_SOURCE_STREAM_MALFORMED`; no adapter/runtime text, no `cause` |
| Stateful top-level getter trap never sprung | A top-level `kind` or `stream` getter that answers once then throws is read once; the observed stream is still closed exactly once |

## The fal output URL authority

Accepted: absolute `https:`, host exactly `fal.media` or ending `.fal.media`, no
userinfo, no explicit port, no fragment, path under `/files/`. Query string
allowed and never rewritten. Refused: `http:`, `fal.media.evil.example`,
`evilfal.media`, `fal-media.example`, `user:password@fal.media`,
`fal.media@evil.example`, an explicit port, `/not-files/`, loopback,
`localhost`, `file://`, a fragment, a query that merely names fal on another
host. Applied in `parseFalH3MaxOutputUrl` (unauthorized → `SUCCEEDED` +
`outputLocator: null`) and again before every byte-source request.

## The byte source

| Rule | How it is held |
| --- | --- |
| The signed URL is the only authorization | GET carries no `Authorization`, no `FAL_KEY`, no cookie; the fetch seam accepts only a URL |
| No buffering | One chunk pulled per consumer iteration; never `.text()`, `.json()`, `.arrayBuffer()`, `Buffer.concat`, or a whole-body array |
| Backpressure preserved | The generator pulls the next chunk only when asked; the end-to-end test holds the sink at its first write and shows exactly one chunk pulled |
| Manual, re-validated redirects | At most three; each `Location` resolved and re-checked against the same policy before the next request; a non-fal target refused before dialing |
| Every failure is retryable | Non-200, network rejection, missing/over-budget redirect, null body → `RETRYABLE_FAILURE`, never a provider failure, never a throw carrying URL text |
| A mid-stream read interruption is retryable, never truncated | A `read()` that rejects after a good status is converted to `ProviderOutputByteStreamRetryableFailure`; the core discards the partial bytes and returns `RETRYABLE_FAILURE` (see Correction 2) |
| `Content-Length` is a hint | A positive safe integer or `null`; the actual streamed count overrides it |
| `close()` releases and is idempotent | Cancels the underlying response once; early termination or a mid-stream interruption releases through the same guard |

## End-to-end dormant proof

`tests/dormant-fal-output-data-plane.test.ts` composes the real
`FalProviderOutputByteSource`, an injected fake fetch, the real
`StreamingManagedOutputTransfer` and the fake staging sink — no network, no
object store — and proves: opaque locator → controlled access → authorized fal
URL → streaming fake body → incremental hash and count → staging publish →
`VERIFIED` receipt; the canonical object holds exactly the streamed bytes; the
locator and its signature never reach the outcome; the actual count overrides a
smaller declared size; with the sink blocked on its first write exactly one
chunk has been pulled; and a body that fails mid-stream after a good status is
reported as `RETRYABLE_FAILURE` with nothing published and no secret text
surviving (Correction 2).

## Correction 2 — a mid-stream interruption is a retryable acquisition failure, never a truncated output

The first byte-source implementation mapped a failed *open* to
`RETRYABLE_FAILURE`, but an output body can fail *after* a good HTTP status — a
CDN drop, a socket reset, a `read()` that rejects with the download only partly
delivered. That was propagating as a raw throw → the transfer core rethrew it →
the runner recorded `TRANSFER_SOURCE_FAILED`, treating a transient acquisition
failure as an adapter defect; and a read interruption must never be mistaken for
clean end-of-stream and published as a short, corrupt output.

The fix (ADR-0042, Decision 5) adds one application-owned control signal,
`ProviderOutputByteStreamRetryableFailure`, in the provider-output byte-source
domain contract, referenced by both the fal adapter and the transfer core. It is
nominal (a private `#marker` brand with a static `is()` guard) and carries
nothing — no error object, `cause`, URL, signature, host, IP, exception text,
provider message, or serialized rejection.

| Rule | How it is held |
| --- | --- |
| The fal adapter converts a body-read rejection to the signal | `body.read()` is wrapped in `try/catch`; a rejection throws `new ProviderOutputByteStreamRetryableFailure()`, and the caught value is discarded unread — never inspected, logged, `cause`-attached, stringified, or serialized |
| A read interruption never becomes clean EOF | `null` remains real EOF; a non-`Uint8Array` chunk is still passed through to the core's malformed-chunk authority; a rejection is the signal, distinct from both |
| The transfer core returns `RETRYABLE_FAILURE`, not a rethrow | The iteration-failure path recognizes the signal nominally, aborts staging (discarding all partial bytes), and returns the transient arm; it never hashes, commits, publishes, or produces a receipt for the partial bytes |
| Recognition is narrow | Only the branded signal is converted; a malformed chunk, a sink write refusal, an adapter-contract defect, or any unbranded throw keeps its existing meaning and propagates |
| The runner is unchanged | A transfer `RETRYABLE_FAILURE` already maps to `TRANSFER_RETRYABLE_FAILURE`, leaving the attempt `OUTPUT_INGESTING` — no provider-failure transition, no reservation/quota change, no finalization |

Proven at four levels: the fal adapter unit tests (read rejection on the first
and on a later read yields exactly the signal, the secret-bearing rejection never
survives, the response is cancelled once, no HTTP retry, no credential added);
the transfer-core tests (one chunk then the signal → exactly `RETRYABLE_FAILURE`,
staging aborted, nothing published, no receipt, source closed once — plus a
regression that an ordinary iterator exception is still a propagated throw, not a
retry); the dormant data-plane end-to-end test (real fal source + real core, body
interrupted mid-stream → `RETRYABLE_FAILURE`, nothing canonical, no secret text,
one request, one cancel); and a live-PostgreSQL runner regression (real stack,
interrupted → the attempt stays `OUTPUT_INGESTING`, reservation `RESERVED`,
nothing published, no secret persisted).

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — all projects |
| `pnpm lint` | Pass — 0 problems |
| `pnpm test` | **3887 passed**, 118 files (was 3875 before Correction 2) |
| `pnpm test:db` (live PostgreSQL) | **756 passed**, 23 files (was 755; adds the mid-stream runner regression) |
| `pnpm build` | Pass |
| Prisma drift | `No difference detected` |
| 2F-1 / 2G-1 / 2G-2 / 2H-1 / 2H-2 / 2H-3A / 2H-3B-1 regressions | Pass |

**No migration and no schema change; `packages/database` untouched.**

## Mutation ledger

**40 mutations, 40 killed, no survivors.** The Phase 3B-1 ledger carries forward
(with M21, M22, M23 and M31 re-aimed to the single inspection authority); six were
added when the byte source landed (M32–M37); and Correction 2 adds M38 and M39.
M11 and M35 were re-aimed onto the code Correction 2 reshaped (the pump-catch and
the stream iterator). The mutation harness itself was rebuilt after a container
re-clone discarded the scratchpad copy — every anchor was re-verified present and
unique against the working tree before the ledger ran.

| # | Defect | Killed by |
| --- | --- | --- |
| **M38** | A fal body-read rejection is rethrown raw instead of converted to the retry signal | the fal-adapter mid-stream tests (thrown value must be the signal, not an `Error`) and the dormant data-plane interruption test |
| **M39** | The transfer core rethrows the retry signal instead of returning `RETRYABLE_FAILURE` | the transfer-core "one chunk then signal → RETRYABLE" test and the mid-stream data-plane test |
| **M37** | The locator-access capability restores a generic arbitrary-return channel | the compile-time direct-extraction regression (`@ts-expect-error` on `async raw => raw` becomes unused → domain typecheck fails) |
| **M32** | The malformed-OPEN cleanup re-reads raw `opened.stream` after inspection | the stateful top-level stream/kind getter core tests |
| **M33** | Redirect targets are dialed without validating them against the fal output policy | the non-fal-host, loopback and scheme-downgrade redirect tests |
| **M34** | The raw locator read-back is re-exported from the `@app/domain` root | the access-guard test asserting the root exposes no reader |
| **M35** | The fal output body is buffered whole instead of streamed (re-aimed onto the new iterator) | the lazy-pull adapter test and the end-to-end backpressure test |
| **M36** | An `Authorization` header carrying the fal key is attached to the output GET | the adapter's credential source-scan test |
| M11 | Staging is not aborted after a write or iteration failure (re-aimed onto the new pump-catch) | the iterator-throw and write-throw abort tests |
| M21 | The open result is trusted without validating its exact keys (re-aimed) | the OPEN-wrapper-with-extra-key tests |
| M22 | A valid stream inside a malformed OPEN wrapper is not closed (re-aimed) | the close-once wrapper tests |
| M23 | The stream close capture reads the getter outside its guard (re-aimed) | the throwing-close-getter tests |
| M31 | The stream inspection returns the raw handle uncaptured (re-aimed) | the stateful stream-getter core and unit tests |

## Not done, on purpose

- **No production composition.** No route, worker loop, bootstrap or scheduler
  constructs the fal byte source, the transfer core, or calls the runner.
- **No durable staging sink.** No S3, R2, Azure Blob, GCS or production
  filesystem; `ManagedOutputStagingSink` has no production implementation.
- **No credential or paid activation.** `FAL_KEY` unwired; no real fal request;
  no paid submission; no Scene delivery, Job readiness, quota consumption,
  `SYSTEM_RECOVERY`, pricing or resolution change.
- **No media validation.** Format, codec, duration and playability remain
  unproved; the key stays extensionless.
