# Phase 4C-3B-2H-3B-3 — Dormant durable S3 managed-output sink

- Base: `3bb9d7a19bac830e11c97adb3a5427c405b83210` (merge commit of PR #62)
- Decision record: ADR-0043
- Migration: **none**
- Paid provider / AWS activation: **still blocked**

## What this phase adds

The first concrete durable `ManagedOutputStagingSink`, completing the real
provider-output data plane — while keeping every piece dormant.

1. **`S3ManagedOutputStagingSink`** (`@app/storage`) — an S3 multipart upload
   against the canonical key, published only through a conditional
   `CompleteMultipartUpload` with `If-None-Match: *`.
2. **`ManagedOutputStagingRetryableFailure`** — one application-owned, secret-free
   signal for a storage write interruption, recognized by the transfer core.
3. **A narrow `S3MultipartClient` seam** plus a dormant `createS3MultipartClient`
   adapter over the real AWS SDK, so the sink is testable with a deterministic
   fake and the SDK is constructed nowhere in production.
4. **The Node/Undici manual-redirect documentation correction** carried forward
   from Phase 3B-2.

## The publication mechanism

| Rule | How it is held |
| --- | --- |
| Multipart targets the canonical key directly | `begin` opens the upload against `bucket + org/{org}/generations/{attempt}/output`; no canonical-adjacent staging object, no overwrite/copy |
| Publication only through conditional completion | `commit` calls `CompleteMultipartUpload` with `ifNoneMatch: "*"` and never an unconditional completion |
| `If-None-Match: *` is the first-publish-wins authority | A completion against an occupied key returns `412`; the loser never overwrites |
| No preflight existence read | Correctness comes only from the conditional completion — a preflight `HEAD`/`GET` would race |
| 412 → verified existing winner | Best-effort abort, then stream the canonical bytes back and hash them → `EXISTING(streamedReceipt)` |
| 409 → retry | Best-effort abort → `RETRYABLE_FAILURE`; no session reconstruction |
| Successful completion → PUBLISHED | No overwrite, no re-copy, no abort after success |

## Integrity

| Rule | How it is held |
| --- | --- |
| The application receipt is the core's, unchanged | The sink never recomputes or replaces the transfer core's SHA-256 / byte count |
| Per-part SHA-256 on every UploadPart | Each part carries `createHash("sha256").digest("base64")`; the multipart upload is created for SHA-256 checksums |
| ETag is never an application hash | The ETag identifies a part for completion only; it is never read as SHA-256 or MD5 |
| Existing-winner verification streams the actual bytes | The 412 read-back hashes and counts incrementally; ETag, Content-Length and metadata are never the integrity authority |
| Content-Length is a preflight bound only | The actual streamed count wins over a smaller or larger declared size, or an absent one |
| The 512 MiB ceiling is reused, never duplicated | `MAX_MANAGED_PROVIDER_OUTPUT_BYTES`; the verification limit is validated by the same authority and may be lower, never higher |
| Receipt / staged-byte mismatch is a fixed defect | `S3ManagedOutputStagingDefect("STAGED_BYTES_RECEIPT_MISMATCH")`, carrying no receipt content |

## Bounded memory, backpressure, retryability, abort

| Rule | How it is held |
| --- | --- |
| No whole-object buffering | Only one bounded part buffer is held; the whole output is never concatenated or arrayed; a static test bans `Buffer.concat` / `transformToByteArray` / `.arrayBuffer` in the sink |
| Non-final parts ≥ the minimum, a smaller final part, consecutive numbers | Parts flush at the part-size threshold; the final short part flushes at commit; numbers start at 1 and never skip; no empty final part |
| Sequential uploads preserve backpressure | Each part upload is awaited before `write` resolves; no unbounded concurrent part uploads |
| `write()` interruption is retryable | An `UploadPart`/`CreateMultipartUpload` rejection on the write path becomes `ManagedOutputStagingRetryableFailure`; the core aborts staging and returns `RETRYABLE_FAILURE` |
| Recognition is narrow | Only the branded signal converts; an unbranded write error still propagates as a defect |
| Abort is idempotent and safe | At most one `AbortMultipartUpload`, a no-op after publish, and a swallowed failure that never replaces the primary outcome |

## Dormancy, as it now stands

| Claim | How it is held |
| --- | --- |
| Exactly one production byte source (fal) and one durable sink (S3) | Static scan: one `implements ProviderOutputByteSource`, one `implements ManagedOutputStagingSink` |
| Nothing constructs the sink, the core, the fal source, or an `S3Client` | Static scan for each `new ...` outside the dormant files |
| Only the dormant adapter references the AWS SDK | Static scan: `@aws-sdk` appears only in `s3-client-adapter.ts` |
| No storage credential in the environment schema | `FAL_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, R2/GCS/Azure keys all absent |
| The Phase 2H-2 runner has no production caller | Static scan of all three entry points |
| No real network in tests | Every test drives the injected fal fetch seam and the fake S3 client |

**Every real provider-output data-plane piece now exists, but no production code
joins or executes them.**

## End-to-end dormant proof

`tests/dormant-managed-output-s3-data-plane.test.ts` composes the real
`FalProviderOutputByteSource`, the real `StreamingManagedOutputTransfer`, and the
real `S3ManagedOutputStagingSink` over a fake fetch seam and a fake S3 client — no
network — and proves: opaque fal locator → authorized streaming source → core
hashes/counts → multipart parts uploaded with per-part SHA-256 → conditional
`CompleteMultipartUpload` with `If-None-Match "*"` → PUBLISHED → transfer VERIFIED;
the canonical key is exact and extensionless; no locator/signature/provider URL
reaches S3; the source is pulled lazily; a resumed session gets `EXISTING` with
the winner's streamed receipt; and an interrupted part upload becomes
`RETRYABLE_FAILURE` with nothing published and no secret leaked.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — all projects |
| `pnpm lint` | Pass — 0 problems |
| `pnpm test` | **3940 passed**, 120 files (was 3887 at the 3B-2 merge) |
| `pnpm test:db` (live PostgreSQL) | **757 passed**, 23 files (adds the S3 interruption runner regression) |
| `pnpm build` | Pass |
| Prisma drift | `No difference detected` |
| 2H-1 / 2H-2 / 2H-3A / 2H-3B-1 / 2H-3B-2 regressions | Pass |

**No migration and no schema change; `packages/database` production code
untouched.**

## Mutation ledger

**48 mutations, 48 killed, no survivors.** M01–M39 carry forward; M40–M47 added
for this phase:

| # | Defect | Killed by |
| --- | --- | --- |
| **M40** | `CompleteMultipartUpload` drops `If-None-Match: *` (unconditional overwrite) | the first-publish-wins race and crash-recovery tests |
| **M41** | On a 412 the loser returns its own receipt instead of reading the winner | the race / crash-recovery tests |
| **M42** | Existing-winner size trusts `Content-Length` instead of the streamed count | the "actual count wins" read-back tests |
| **M43** | `UploadPart` omits the per-part SHA-256 checksum | the multipart-integrity tests (the fake rejects a bad digest) |
| **M44** | An `UploadPart` rejection escapes raw instead of the retry signal | the storage-retryability and secret-leak tests |
| **M45** | The transfer core rethrows the staging signal instead of returning `RETRYABLE_FAILURE` | the core staging-interruption tests |
| **M46** | The existing winner is buffered whole (`Buffer.concat`) before hashing | the sink's no-whole-buffer static test |
| **M47** | The browser-only Node manual-redirect claim is reintroduced | the fal-source documentation static test |

## Not done, on purpose

- **No production composition, credential, or activation.** No `S3Client`, no
  bucket, no `FAL_KEY`, no scheduler/cron/daemon/worker, no real fal or AWS
  request, no paid submission, Scene delivery, Job readiness, quota consumption,
  `SYSTEM_RECOVERY`, pricing or resolution change.
- **No media/format validation.** No MP4 magic-number check, ffmpeg/ffprobe, or
  Content-Type trust; byte integrity is not a claim about playable video, and the
  key stays extensionless.
- **No infrastructure.** The recommended incomplete-multipart lifecycle rule is
  documented, not provisioned.
