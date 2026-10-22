# API Changes — DS-5b-2a

Composition's records for the Clean Master (ADR-0077). **Migration 31. No
route, page, export to customers, command or environment variable is added**,
and nothing in production constructs or calls what changed.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `assertRenderableDisclosureMode(value)` | returns the value as a `DisclosureMode`, or throws `CONFIGURATION_ERROR` ("This build cannot render the disclosure mode frozen on that record") for anything outside `DISCLOSURE_MODES` |
| type `CleanMasterReceipt` | `{ sha256: Sha256Digest, sizeBytes: SafePositiveByteCount, verifiedAt: number }`; `verifiedAt` is when the master's stored bytes were proven, recorded as the master's own instant |
| block codes `CLEAN_MASTER_SIZE_LIMIT_EXCEEDED`, `CLEAN_MASTER_UNUSABLE` | appended to `COMPOSITION_BLOCK_CODES`; nothing records either yet |
| defect `CLEAN_MASTER_RECEIPT_CONFLICT` | "A composed deliverable already carries a different durable Clean Master receipt" |

### Changed: `@app/domain` composition ports

| Type | Change |
| --- | --- |
| `DeliverableCompositionClaim` | adds `disclosureMode: DisclosureMode` (the version's frozen mode) and `cleanMasterStorageKey: ManagedCleanMasterKey` |
| `FinalizeCompositionInput` | adds `cleanMaster: CleanMasterReceipt \| null`, required; `null` only under profile v1. `verifiedAt` stays the video's `outputVerifiedAt` |

The runner passes `cleanMaster: null`; nothing else it does changes.

### Changed: `@app/database` composition repository

- `claimCompositionWork` reads the version's `disclosureMode` under its locks,
  refuses one this build does not know before writing anything, and returns it
  with the master's key.
- `finalizeComposition` writes the `generation_deliverable_clean_masters` row
  in Transaction J2 when given a receipt, between the work row's move and the
  job's; a replay compares it, throwing `CLEAN_MASTER_RECEIPT_CONFLICT` for a
  different key, digest or size, or for a record that exists when the replay
  names none (or the reverse). The video's receipt is still compared first.
- `findCompositionCandidates` no longer offers a work row frozen under a
  profile other than this build's `COMPOSITION_PROFILE_KEY`, nor a version
  planned under a disclosure mode outside `DISCLOSURE_MODES`, the list the
  claim's refusal reads.

## Database

Migration 31, `00000000000031_clean_master_block_codes`, adds two values to
`DeliverableCompositionBlockCode`. See `docs/migration-notes.md`.
