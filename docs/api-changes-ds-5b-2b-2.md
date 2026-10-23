# API Changes — DS-5b-2b-2

Every video is made from a recorded master (ADR-0079). **No migration. No
route, page, export to customers, command or environment variable is added**,
and nothing in production constructs or calls what changed.

## HTTP

No change.

## Internal API

### Changed: `@app/domain` composition ports

| Type | Change |
| --- | --- |
| `FinalizeCompositionInput.cleanMaster` | `CleanMasterReceipt` (was `CleanMasterReceipt \| null`) |
| `DeliverableMediaComposer` | `compose` removed; `composeCleanMaster` and `applyDisclosure` are the whole port |

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| defect `CLEAN_MASTER_RECEIPT_MISSING` | "A composed deliverable cannot be recorded without the Clean Master it was made from"; thrown by Transaction J2 for a finalize naming no master, before its transaction opens |

### Changed: `@app/database` Transaction J2

| Method | Change |
| --- | --- |
| `finalizeComposition` | refuses a missing master's receipt with `CLEAN_MASTER_RECEIPT_MISSING`, writing nothing; records the master on every first commit; a replay always compares the master's record, and one for a verified deliverable without a record is `CLEAN_MASTER_RECEIPT_CONFLICT` |

### Removed: `@app/storage`

| Export | Note |
| --- | --- |
| `ffmpegComposeArgsFor` | the one-pass encode's argument vector. The same graph is built only by `ffmpegCleanMasterArgsFor`, at `CLEAN_MASTER_CRF` |
| the FFmpeg composer's `compose` | with the port's |

### Unchanged on purpose

- `ComposeDeliverableInput` and `ComposeDeliverableOutcome` keep their names:
  the master's encode takes and returns them.
- The runner's dependencies, report and codes are unchanged.

## Database

No migration, no schema change. See `docs/migration-notes.md`.
