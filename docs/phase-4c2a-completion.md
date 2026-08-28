# Phase 4C-2A — Immutable execution preflight

Milestone: Phase 4C-2A
Base: `27ba4df1159da1ef69693d3dcebe975b14e7e96f` (merged Phase 4C-1b, PR #39)
Decision record: ADR-0026

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source.

## What shipped

```ts
prepareQueuedGeneration(
  deps: ExecutionPreflightDeps,
  candidate: SystemGenerationCandidate,
): Promise<PreparedGeneration>
```

**ADR-0026 carries the reasoning in full.** This report records what was checked
and does not restate the argument. In one line each: preparation returns with the
row still `QUEUED`; `PreparedGeneration` is domain-owned so `@app/domain` still
depends only on `@app/shared`; both dependencies are `Pick`-narrowed; the request
comes from the immutable snapshot with a *verified* `requestHash`; the capability
check is identity-only and says so; a `READY` asset must also be a JPEG at a
non-blank key whose object exists; the signed URL is validated; and the asset is
read a second time after signing.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | **1219 passed**, 60 files (baseline 1160 / 59) |
| `pnpm build` | exit 0 |
| `pnpm test:db` | **154 passed**, 8 files (baseline 153 / 7) |
| `prisma migrate diff --from-migrations` | `No difference detected.` exit 0 |

### Where each property is proven

59 unit tests plus **one** PostgreSQL test. The doubles are local to the file
that needs them — a narrowed storage fake and a sequential asset reader
implementing `findById` alone. **No shared production abstraction was added**,
and nothing consumes preflight in production yet.

| Property | Proven by |
| --- | --- |
| Every artifact field comes from the frozen snapshot | Snapshot set to `9:16`/`720p`/3s while the asset is 4:3 and the model advertises only `16:9`/`1080p` |
| The prompt is never re-rendered | Frozen text a current renderer would not produce, returned verbatim |
| Preparation mutates nothing | Whole-row comparison in-process, **and against PostgreSQL** |
| Stored hash is verified | A row whose hash disagrees with its facts is refused |
| Provider/model identity still in force | Refused when either differs from the configured capability |
| All 13 refusal reasons | One test each; the disposition map is asserted to partition the whole vocabulary. **The vocabulary was thirteen at this milestone; Phase 4C-3A-2a made it fourteen (ADR-0029).** |
| Every `MediaAssetStatus` is classified | The single production `Record` — a new status fails to compile until classified; all ten also covered behaviourally |
| Normalized-source invariant | WebP, empty key and whitespace-only key each refuse **before** storage is touched |
| Signed URL is usable | Unparseable, plain-HTTP and non-finite expiry each refuse |
| Expiry is the signer's | A distinct signer `Date` is returned by identity |
| The asset can change during signing | Six post-sign transitions, each proving signing already happened and nothing was returned |
| Tenant isolation | Another organization's asset yields `ASSET_NOT_FOUND`; nothing signed |
| Secret safety | The storage error deliberately carries a fake key and token; the refusal exposes neither, and `cause` is `undefined` |
| Programmer errors are not relabelled | A `TypeError` escapes rather than becoming `LEGACY_SNAPSHOT_MISSING` |
| Preflight cannot claim, submit, or write | Type-level assertions on `ExecutionPreflightDeps` |

The PostgreSQL test uses the **real** execution port for the candidate (so
`organizationId` is the authoritative one resolved through `VideoProject`), the
**real** scoped `MediaAssetRepository`, and only the two narrowed storage
capabilities. It takes the happy path deliberately: that is the one that runs
both asset reads, the existence check and the signing.

### Mutation verification

| Mutation | Result |
| --- | --- |
| Resolution taken from live capability instead of the snapshot | **1 fail** |
| Request-hash verification removed | **1 fail** |
| Asset `READY` check removed | **4 fail** |
| `deletionRequestedAt` check dropped | **1 fail** |
| Storage existence check removed | **2 fail** |
| Preflight TTL reverted to the human-download 300s | **2 fail** |
| URL signed before the asset checks | **2 fail** |
| `FAILED` put back into the unrecoverable bucket | **1 fail** |
| `ASSET_UPLOAD_FAILED` folded back into `ASSET_NOT_READY` | **1 fail** |
| `DELETION_PENDING` reclassified as recoverable | **1 fail** |
| `deletionRequestedAt` override removed | **1 fail** |
| A status removed from the production `Record` | **compile error** `TS2741` |
| `storage` widened back to the full `ObjectStorage` | **compile error** `TS2420`/`TS2739` |
| `assets` widened back to the full `MediaAssetRepository` | **compile error** `TS2322` |
| **M-JPEG** — JPEG / non-blank-key validation removed | **3 fail** |
| **M-R4-read** — second asset read removed | **8 fail** |
| **M-R4-key** — same-`storageKey` comparison dropped | **2 fail** |
| **M-R4-MIME** — same-`mimeType` comparison dropped | **1 fail** |
| **M-HTTPS** — protocol/host enforcement dropped | **2 fail** |

Every mutated file restored byte-identically, confirmed by `diff` against a
pre-mutation copy. No mutation-only code is committed.

The TTL mutation is worth recording because it initially **passed**: the test
asserted the signed TTL equalled the same constant it was checking, so both
could move together undetected. It now asserts the literal, plus the
relationship that justifies a separate constant at all.

## Invariants held

8-fact `requestHash` **unchanged** · state machine **unchanged** · schema and
migrations **unchanged** · the six frozen request artifacts untouched ·
`SceneGenerationRepository` and `SceneGenerationExecutionRepository` public
contracts untouched · `generation-service.ts` untouched · provider adapters
untouched · no worker loop, claim, state write, asset write, persisted URL,
provider call, prediction, submission audit, polling, sweep, retry, or output
ingestion.

## Known limitations

- **Nothing calls this yet.** Production-dormant, like Phase 4C-1b.
- **A residual asset race remains.** The guarantee is exactly: at the final
  observation before `PreparedGeneration` is returned, the source is still the
  same usable `READY` source that was signed. Nothing stronger. Deletion can
  still be requested after the return, before the claim and the paid POST. This
  milestone does **not** close deletion atomically, deletion does **not**
  necessarily make the signed URL 404, and the second read alone does **not**
  make a paid POST safe. Hard Phase 4C-3 prerequisite.
- **Capability re-validation is identity-only.** `assertSettingsSupported`
  cannot be re-run from the snapshot, which stores no discrete `negativePrompt`.
  A capability table edited under an unchanged provider and model is not
  detected. Recorded in `docs/decisions/TODO.md`.
- **The 600-second TTL is provisional** until Phase 4C-3's paid-call review.
- **No durable disposition for a refusal.** Phase 4C-2B owns that mapping.

## Size

| Category | Lines changed |
| --- | --- |
| Production | 609 (of which ~238 are statements; the rest is comment) |
| Tests | 862 |
| Docs | 535 |
| **Total** | **2,006** across 10 files |

Measured from `git diff --numstat 27ba4df..HEAD` after the final commit existed,
reconciling with the raw diff (`+2002 −4 = 2,006`).

**This exceeds the 1,900-line ceiling and is recorded as over.** Tests are the
largest category, and the growth is the evidence the contract asked for: the
thirteen-reason matrix, three format cases, three signed-URL cases, six post-sign
transitions, the secret-safety cases and the PostgreSQL whole-row proof.
Duplication between ADR-0026 and this report was collapsed — the report now
points at the ADR rather than restating it — but nothing was cut from the
evidence or from the decision record in order to reach a number.
