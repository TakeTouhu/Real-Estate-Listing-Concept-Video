# Phase 4C-3A-2a — Prepared source identity and fail-closed content hash

Milestone: Phase 4C-3A-2a
Base: `6d002f9741c50ad51e8137eb2ac30b5dd3fcae5a` (merged Phase 4C-3A-1, PR #42)
Decision record: ADR-0029

> **Superseded in part by ADR-0030.** `claimQueuedForSubmission` no longer
> exists: Phase 4C-3A-2b replaced it with `claimPreparedForSubmission`, which
> takes a `PreparedSourceIdentity` and locks the asset row. References below are
> the historical record of this milestone, not the current API.

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source.

## What shipped

```ts
interface PreparedSourceIdentity {
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sha256: string;
}

classifyExecutionSource(observation): { kind: "USABLE"; identity } | { kind: "REFUSED"; reason }
isUsableSourceDigest(sha256: string | null): sha256 is string
sameSourceIdentity(a, b): boolean
```

`PreparedGeneration` gains exactly one nested field, `sourceIdentity`. The
refusal vocabulary gains exactly one reason, `ASSET_SOURCE_UNIDENTIFIABLE`
(`TERMINAL`). **ADR-0029 carries the reasoning in full**, including why
`storageKey` + `mimeType` cannot tell two images apart.

This milestone adds no claim, no lock, and no raw SQL. Those are A-2b.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | **1320 passed**, 62 files (baseline 1259 / 61) |
| `pnpm build` | exit 0 |
| `pnpm test:db` | **197 passed**, 9 files (baseline 197 / 9) |
| `prisma migrate diff --from-migrations` | `No difference detected.` exit 0 |

## The digest contract

Producer **unchanged**: `sha256Hex(Buffer.from(processed.normalized).toString("base64"))`
in `AssetService.completeUpload`, which emits an unprefixed lowercase hex digest.
No re-hashing, no migration, no backfill.

Usable form: `^[0-9a-f]{64}$` — nothing else. Refused: null, empty, whitespace,
63 characters, 65 characters, uppercase, a `sha256:` prefix, non-hex.

SHA-256 is described throughout as a **collision-resistant** digest and practical
content-identity evidence. It is nowhere claimed to be injective, and nowhere
claimed to make bytes immutable — that comes from the writer inventory below.

## Where each property is proven

| Property | Proven by |
| --- | --- |
| Digest format is exact | Ten boundary cases, including 63/65 characters and a `sha256:` prefix |
| Deletion intent outranks status | Asserted for **every** status, not only `READY` |
| Every status is classified | Independent expectation table, asserted to cover exactly the non-`READY` statuses |
| Format outranks digest | A PNG with a null digest refuses as `ASSET_FORMAT_UNSUPPORTED`, never "unidentifiable" |
| Unusable digest touches no storage | `existsCalls` and `signed` both empty, and only **one** asset read |
| Identity is the first observation's | Compared field for field, **and** against the key actually signed |
| Same key + same MIME + different digest | Refused `ASSET_SOURCE_CHANGED` — the case key/MIME equality passes over |
| Second observation classified on its own terms | A row that loses its digest after signing refuses `ASSET_SOURCE_UNIDENTIFIABLE`, not "changed" |
| Storage key is never trimmed | A padded key survives into the identity unaltered |
| Identity carries no credential | Compile-time: exactly three fields; `sourceImageUrl`/`sourceUrlExpiresAt` stay separate on `PreparedGeneration` |
| Fourteenth reason parks terminally | Independent reason→state table; retryable set asserted still 4, terminal now 10 |
| New reason persists to PostgreSQL | The existing DB matrix is driven by `PREFLIGHT_REFUSAL_REASONS`, so it covers the new reason without a case being added |
| `READY` cannot re-enter the pipeline | `completeUpload` and `retryUpload` both refuse, with 0 scans, 0 image processes, no rewrite of the normalized object, and no upload credential minted |

## Mutation ledger

| Mutation | Result |
| --- | --- |
| **M1** — `ASSET_SOURCE_UNIDENTIFIABLE` disposition `TERMINAL` → `RETRYABLE` | **12 unit fail** |
| **M2** — usable digest weakened to any non-blank string | **18 unit fail** |
| **M3** — first-observation classification deferred past `exists` and signing | **10 unit fail** |
| **M4** — `sha256` dropped from the identity comparison | **3 unit fail** |
| **M5** — `sha256` removed from `PreparedSourceIdentity` | **compile-only: 4 TS errors, 0 runtime failures** |
| **M5b** — `sha256` also dropped from the constructed identity object | **5 unit fail** |
| **M6** — malformed `READY` digest classified `ASSET_FORMAT_UNSUPPORTED` | **16 unit fail** |
| **M7** — `READY` admitted into the `completeUpload` entry guard | **2 unit fail** |

Every mutated file restored byte-identically, confirmed by `diff`. No
mutation-only code is committed.

**M5 is reported honestly as compile-only.** Removing a field from an
*interface* changes no runtime object — `classifyExecutionSource` still
constructs `{ storageKey, mimeType, sha256 }`, and Vitest strips types — so all
866 domain tests passed. What caught it was `tsc`: four errors, one of them the
type-level boundary assertion in `execution-source.test.ts` firing exactly as
intended. **M5b** is the runtime-visible variant and fails 5 tests. Both are
recorded rather than presenting the type evidence as a runtime result.

**Compile-exhaustion proof.** Removing `ASSET_SOURCE_UNIDENTIFIABLE` from
`REASON_DISPOSITION` fails to compile:

```
execution-preflight-errors.ts(90,7): error TS2741: Property
'ASSET_SOURCE_UNIDENTIFIABLE' is missing in type '{ … }' but required in type
'Record<… , PreflightDisposition>'.
```

Not counted as a runtime mutation.

## Post-claim byte stability

The proof is in ADR-0029 §6 and is a statement about **today's implementation**,
not a schema theorem. In short: the normalized object is written by exactly one
production statement, inside `completeUpload`; both entry points accept only
`PENDING_UPLOAD` and `FAILED`; the only production exits from `READY` are
`→ REJECTED` and `→ DELETION_PENDING`, and neither is in either guard; upload
credentials target the `original` variant; the sole `deleteObject` caller is
unreachable from `READY`; and no physical deletion worker exists.

Pinned by a **test-only** regression guard — `AssetService` production code is
unchanged (zero diff against the baseline). Any future feature permitting
`READY → upload/retry/reprocess`, in-place normalized replacement, or physical
deletion while a generation may still need the source invalidates it and must
re-review paid-submission safety first. Recorded in `docs/decisions/TODO.md`.

## One deliberate behaviour change

A second observation that is a valid **non-JPEG** previously refused as
`ASSET_SOURCE_CHANGED`; it now refuses as `ASSET_FORMAT_UNSUPPORTED`, because the
second observation is classified on its own terms before being compared. Both are
`TERMINAL`, so the durable parking state is unchanged; only `normalizedErrorCode`
is more precise. This follows the milestone brief's rule that an independently
unusable second observation returns its own canonical reason. The existing test
encoded the old ordering and was updated with the reason recorded inline.

## Invariants held

Prisma schema and migrations **unchanged** (no migration generated) ·
`requestHash`, `computeGenerationRequestHash` and `generationRequestFactsFrom`
**unchanged** · `SceneGeneration` schema and state machine **unchanged** ·
`SceneGenerationExecutionRepository` and `generation-execution-repository.ts`
**unchanged** · `claimQueuedForSubmission` **unchanged** · `failQueuedPreflight`
semantics **unchanged** · `MediaAssetRepository` **unchanged** · `AssetService`
production code **unchanged** · `GenerationService` **unchanged** · provider
packages **unchanged** · environment schema **unchanged** · audit runtime
**unchanged** · worker runtime **unchanged** · no raw SQL · no row lock · no
paid gate · no provider call · no WaveSpeedAI call.

## Known limitations

- **The digest is evidence, not enforcement.** It detects that a source changed;
  it cannot prevent a change. Prevention is the lifecycle inventory, which a
  future feature can invalidate.
- **The stability proof is not machine-checked end to end.** The regression guard
  pins the two entry guards; the rest of the argument is inspection recorded in
  ADR-0029.
- **A pre-existing row with a malformed digest now fails terminally.** That is
  the intended fail-closed behaviour, but it means such a row can no longer be
  submitted at all rather than being submitted unverified. No such row is known
  to exist — the only production writer sets the digest in the same statement as
  `READY`.
- **This does not linearize submission against deletion.** The asset row lock,
  the claim outcome union and the removal of the unprepared claim path are all
  Phase 4C-3A-2b.
