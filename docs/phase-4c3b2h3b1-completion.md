# Phase 4C-3B-2H-3B-1 — Dormant Streaming Managed Output Transfer Core

- Base: `07ac915f4fbdd9f171527f33aa84ccc766ec5b28`
- Decision record: ADR-0041
- Migration: **none**
- Paid provider activation: **still blocked**

## What this phase adds

One concrete implementation of Phase 2H-2's `ManagedOutputTransferPort` —
`StreamingManagedOutputTransfer` in `@app/storage` — and the two contracts it
consumes: a provider-neutral `ProviderOutputByteSource` in the domain, and a
`ManagedOutputStagingSink` in storage. Neither contract has a real
implementation. The core is proved against deterministic fakes, and the static
suite asserts nothing in production constructs it.

## The dormancy claim, precisely

The core is concrete: it really hashes, stages and publishes. What keeps it
dormant is not that it cannot act but that nothing gives it the two things it
needs to act on, and nothing constructs it.

| Claim | How it is held |
| --- | --- |
| Nothing in production constructs the core | Static scan over every `apps/*`, `packages/database`, `packages/video-providers`, `packages/storage` and `packages/domain` source, excluding tests and `testing/` |
| No production byte source exists | The same scan finds no `implements ProviderOutputByteSource` |
| No production staging sink exists | The same scan finds no `implements ManagedOutputStagingSink` |
| The Phase 2H-2 runner still has no caller | The same scan, for all three entry points |
| No storage or provider credential exists | `FAL_KEY`, AWS, R2, Azure and GCS variables absent from the environment schema |
| No test reaches a network or an object store | Both fakes are in-memory; the core imports only `@app/domain`, `@app/shared` and `node:crypto` |
| The fakes are not on the package root | `@app/storage` exports the core; the fakes live only under `@app/storage/testing` |

**A concrete streaming transfer core exists. It has no production byte source,
no production staging sink, no production composition, and no credential.**

## Why the existing pieces were not reused

| Existing piece | Its contract | Why not |
| --- | --- | --- |
| Provider `HttpClient` | One request, one **string** body, no retries | Right for a status poll; wrong for half a gigabyte. Control plane and data plane get separate narrow contracts; `http.ts` is unchanged and still string-bodied |
| `LocalObjectStorage` | Whole `Uint8Array`, in process memory, non-production | Adapting it would mean buffering a complete video to hand it an array. Unchanged, still serving photos, still refusing production |

## What one transfer does

```text
open the source                  RETRYABLE_FAILURE → return it; throw → propagate
check the declared size          over the limit → RETRYABLE_FAILURE, no staging
begin an isolated staging write
for each chunk, one at a time    count → limit check → hash → write (backpressure)
zero bytes                       abort → RETRYABLE_FAILURE
commit with the computed receipt
  PUBLISHED                      VERIFIED with the computed receipt
  EXISTING                       VERIFIED with the canonical object's receipt
  RETRYABLE_FAILURE              abort → RETRYABLE_FAILURE
close the source                 always, exactly once
```

| Property | Held by |
| --- | --- |
| **Bounded memory** | `for await` over a pull-based body, awaiting each `write`; one chunk in hand at a time. With the sink blocked on its first write, exactly one chunk has been pulled |
| **Bounded size** | 512 MiB hard ceiling; configured limit refused (never clamped) if invalid or higher. Declared size is preflight only; every actual byte is counted before it is hashed or written |
| **Incremental SHA-256** | `createHash("sha256")` updated per chunk, finalized once after the loop; no concatenation anywhere |
| **Zero bytes refused** | Never a canonical object, never `VERIFIED`, never a manufactured size |
| **Staging isolation** | The canonical key is untouched until `commit` says `PUBLISHED`; asserted at every write |
| **First publish wins** | A second session, same or different bytes, receives `EXISTING`; the canonical object is never overwritten |
| **Receipt recovery** | `EXISTING` carries the canonical object's receipt, and the core reports *that* — not the receipt for the bytes it just abandoned |
| **Cleanup exactly once** | `close()` once on every path out of a successful open; `abort()` on every failure after `begin`, never after a success; both best effort, neither ever the answer |
| **Cleanup on a malformed open** | An OPEN-shaped malformed result with an object `stream` is closed once, best effort, **whether or not the stream is valid** — the wrapper being defective does not make a valid handle less worth releasing. The defect raised follows the stream's validity: valid stream → the wrapper's defect; malformed stream → the stream's. Obtaining `close` is inside the guard, so a throwing getter cannot replace the fixed defect (Revision 2) |
| **The sink's answer cannot surprise the core** | The commit result is read once, under a guard, into a fresh plain object; a throwing `kind` or `receipt` getter is `null` → abort → `STAGING_COMMIT_RESULT_MALFORMED` with fixed text and no `cause`; a getter that answers once then throws is never read twice (Revision 3) |
| **The sink's receipt cannot surprise Phase 2H-1 either** | `parseVerificationReceipt` reads own keys, `sha256` and `sizeBytes` once each inside one guard and returns a fresh plain object; the decision uses that copy and never re-reads the raw receipt. A throwing or stateful getter is the closed `RECEIPT_MALFORMED` → `TRANSFER_OUTCOME_MALFORMED`, attempt still ingesting, nothing written, nothing escapes (Revision 4) |
| **Totality starts at the shared record check** | Every boundary parser asks `isPlainRecord` before opening its own guard, and its `Array.isArray` throws on a revoked `Proxy`. The helper is now total — the one throwing question is answered under a guard, once, for every boundary. A revoked Proxy cannot cross an `await` (promise resolution reads `.then` and throws inside the adapter's own promise), so it reaches this pipeline only as a *property* of an answer: as the `stream` it is `BYTE_SOURCE_STREAM_MALFORMED`; as the `EXISTING` receipt it is `RECEIPT_MALFORMED` → `TRANSFER_OUTCOME_MALFORMED`, attempt left ingesting, nothing of the runtime's text anywhere (Revision 5) |
| **The transfer outcome cannot surprise the runner** | `parseManagedOutputTransferOutcome` reads `kind`, the own keys and the `VERIFIED` receipt once each into a fresh object; the runner acts on that copy and never re-reads the raw port result. A throwing `kind`/`ownKeys` or a stateful getter is the closed `TRANSFER_OUTCOME_MALFORMED`, attempt still ingesting, no finalization; the receipt reference travels to Phase 2H-1 untouched (Revision 6) |
| **The poll observation cannot surprise the orchestrator** | `parseProviderPollObservation` reads `kind`, the own keys, `outputLocator`, `retryable` and `diagnosticCode` once each into a fresh object; the orchestrator dispatches on that copy several times without returning to the raw source. A hostile or stateful getter is `STATUS_OBSERVATION_MALFORMED` with no write — never read as `FAILED` — and the opaque locator is preserved by reference, never rebuilt or inspected (Revision 6) |
| **The byte-source stream cannot surprise the core after validation** | `parseProviderOutputByteStream` reads `body`, `declaredSizeBytes` and `close` once each and returns a captured stream: the async-iterator capability is looked up once and re-exposed as a plain method, and `close` is invoked against its original receiver. The core uses the capture, so no getter on the raw handle is read twice; a stateful getter that answers once then throws never strikes. No bytes buffered, backpressure unchanged, class instances still supported, the Revision 2 malformed-OPEN cleanup intact (Revision 6) |
| **Failures never blame the provider** | Every expected condition returns `RETRYABLE_FAILURE`; every adapter defect throws fixed text; Phase 2H-2 leaves the attempt `OUTPUT_INGESTING` in both cases |
| **Locator unread** | Passed to the source by reference; no accessor exists, none was added, and the core does not look |

## Crash after publish, before finalization

Runner A publishes the canonical object and dies before
`finalizeOutputVerification`. Runner B resumes the `OUTPUT_INGESTING` attempt,
downloads again — the bytes differ — stages, and commits. The sink answers
`EXISTING` with A's receipt; the core reports A's receipt; Phase 2H-1 finalizes
the row against A's object. Canonical bytes are A's. Proved at the unit level
and against live PostgreSQL through the real runner.

No transfer lease was added. A lease would buy a duplicate-free download at the
price of a durable lock whose holder can die, and a lease column would be a
migration. First-publish-wins gives the property that matters without either.

## What remains unverified, on purpose

The receipt proves a digest and a byte count. It does **not** prove MP4, WebM,
a codec, a resolution, a duration, playability or a MIME type. No `ftyp` box is
inspected, no `ffprobe` runs, no MIME column exists, no extension is appended:
the key remains `org/{organizationId}/generations/{attemptId}/output`. Media
validation is a delivery-readiness prerequisite for a later phase.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — all 10 projects, including the `@ts-expect-error` brand proofs |
| `pnpm lint` | Pass — 0 problems |
| `pnpm test` | **3787 passed**, 114 files (was 3478 / 108) |
| `pnpm test:db` (live PostgreSQL) | **755 passed**, 23 files (was 728 / 22) |
| `pnpm build` | Pass |
| Prisma drift | `No difference detected` |
| 2F-1 / 2G-1 / 2G-2 / 2H-1 / 2H-2 / 2H-3A regressions | Pass, unchanged |

309 unit tests and 27 database tests added. No pre-existing test weakened or
removed; one Revision 3 test was renamed in Revision 4 so its title states the
behaviour it actually proves (`VERIFIED` on a single guarded read). Revision 5
adds the shared helper's own suite (`submission/untrusted.test.ts`); Revision 6
adds materialization suites for the transfer outcome, the poll observation and
the captured byte stream.

## Mutation ledger

**32 mutations, 32 killed, no survivors.** Nineteen are the required list;
three (M01a, M20, M21) are additional; two (M22, M23) were added with the
Revision 2 correction; two (M24, M25) with Revision 3; two (M26, M27) with
Revision 4; one (M28) with Revision 5; three (M29, M30, M31) with Revision 6.

| # | Defect | Killed by |
| --- | --- | --- |
| M01a | Destination key type widens back to a plain string | `pnpm typecheck` — every `@ts-expect-error` in the brand proof becomes unused |
| M01b | The runner passes a caller-chosen string as the destination | 4 |
| M02 | Declared size limit is ignored | 2 |
| M03 | Actual byte limit is ignored | 9 |
| M04 | Zero-byte output is treated as streamed | 8 — the domain's `safePositiveByteCount` refuses `0` as a second line |
| M05 | Byte count uses the declared size instead of the actual count | 2 |
| M06 | The first chunk is omitted from SHA-256 | 13 |
| M07 | The hash is finalized after the first chunk | 6 |
| M08 | The source is drained eagerly before any write | 12 — the backpressure test and the source-level guard both |
| M09 | The source is never closed | 35 |
| M10 | Staging is not aborted after oversize or empty | 4 |
| M11 | Staging is not aborted after a write or iteration failure | 11 |
| M12 | The reference sink overwrites the canonical object (last-writer-wins) | 6 — targets the fake's first-publish semantics, proving a real sink that overwrote would be caught |
| M13 | `EXISTING` reports the proposed receipt instead of the canonical one | 11 |
| M14 | Commit is issued after the first chunk, before all bytes are written | 22 |
| M15 | A `RETRYABLE_FAILURE` commit is reported as `VERIFIED` | 4 |
| M16 | A malformed commit result is accepted | 15 |
| M17 | `LocalObjectStorage` is pulled into the transfer core | 1 — the static guard |
| M18 | The full output is accumulated in memory alongside streaming | 1 — the static `Buffer.concat` guard; behaviourally invisible, which is why the guard exists |
| M19 | A session advisory lock is left held across the transfer | 11 — every live-PostgreSQL test that reaches a write blocks and times out |
| M20 | A non-bytes chunk is hashed and written rather than refused | 6 |
| M21 | The open result is trusted without validating its exact keys | 7 — re-aimed in Revision 6 to the new open-result parser, where the exact-key check now lives |
| **M22** | **A valid stream inside a malformed OPEN wrapper is not closed** (the rejected head's selection) | 3 — exactly the three focused wrapper tests; fails against `229d484…`, passes after |
| **M23** | **The `close` lookup happens outside the best-effort cleanup guard** | 2 — the two throwing-`close`-getter tests |
| **M24** | **The commit-outcome parser reads `kind` outside its guard** | 3 — the throwing-`kind`-getter core test and the two predicate tests |
| **M25** | **The core dispatches on the raw sink value instead of the materialized outcome** | 1 — exactly the answers-once-then-throws test written for it |
| **M26** | **Receipt property access happens outside the parser's guard** | 8 — the four throwing-getter unit tests (receipt authority and decision) and the four live-PostgreSQL hostile-receipt tests (2H-1 completion and 2H-2 runner) |
| **M27** | **The finalize decision re-reads the raw receipt after validation** | 4 — exactly the stateful-getter tests: two unit (decision and authority), two live-PostgreSQL (2H-1 completion and 2H-2 runner) |
| **M28** | **`isPlainRecord` evaluates `Array.isArray` unguarded** (a revoked Proxy escapes every boundary) | 10 — eight unit (the helper itself, the receipt authority, the decision, both staging entry points, both byte-source predicates, the core's revoked stream) and two live-PostgreSQL (2H-1 completion and the 2H-2 runner, each with a revoked-Proxy `EXISTING` receipt) |
| **M29** | **The runner re-reads the raw transfer outcome after validation** | 2 — the stateful-`kind` and stateful-`receipt` runner tests, each of which throws on the second read the mutation reintroduces |
| **M30** | **The runner dispatches on the raw poll source value instead of the materialized observation** | 2 — the stateful SUCCEEDED-locator and stateful FAILED-fields runner tests |
| **M31** | **The byte-stream parser returns the raw handle uncaptured, so the core re-reads its getters** | 6 — the four stateful stream-getter core tests (declared size, body, close, async-iterator) and the two parser single-read unit tests |

Counts are failures in **this phase's suites only**. M17 and M18 are killed by a
single static assertion each — that is the honest mechanism for a property the
behavioural tests cannot observe, and it is stated as such rather than padded.

## Not done

- **No concrete fal byte source.** `ProviderOutputByteSource` has no
  implementation; the locator still cannot be dereferenced by anything.
- **No durable staging sink.** No S3, R2, Azure Blob, GCS, multipart upload or
  production filesystem. `ManagedOutputStagingSink` has no implementation
  outside the test fake.
- **No media validation.** Format, codec, duration and playability remain
  unproved.
- **No production composition.** No route, worker loop, bootstrap or scheduler
  constructs the core or calls either 2H-2 runner.
- **No Scene delivery or Job readiness.** `OUTPUT_VERIFIED` is provider-attempt
  integrity only.
- **No paid activation.** `FAL_KEY` unwired; fal and Veo production execution
  disabled; WaveSpeed paid routing unchanged; no payment integration; the
  provider-contract reverification is still outstanding.
