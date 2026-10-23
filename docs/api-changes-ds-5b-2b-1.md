# API Changes — DS-5b-2b-1

Composition makes the Clean Master first (ADR-0078). **No migration. No route,
page, export to customers, command or environment variable is added**, and
nothing in production constructs or calls what changed.

## HTTP

No change.

## Internal API

### Changed: `@app/domain` composition profile

| Export | Change |
| --- | --- |
| `COMPOSITION_PROFILE_KEY` | `"vtavision-compose:v2"` (was `v1`). Every other value a work row freezes is unchanged; `assertRunnableProfile` now refuses a row frozen under `v1` |

### Changed: `@app/domain` composition runner

| Type | Change |
| --- | --- |
| `DeliverableCompositionDeps` | adds `cleanMasterStore: CleanMasterStore` and `cleanMasterInspector: CleanMasterInspector`, both required |
| `DeliverableCompositionRunner.runOnce` | makes the Clean Master first, or reuses the stored one (ADR-0078 Decision 2); finalizes with the master's receipt on every path; blocks with `CLEAN_MASTER_SIZE_LIMIT_EXCEEDED` and `CLEAN_MASTER_UNUSABLE`; never calls `DeliverableMediaComposer.compose`. The report's fields are unchanged |

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| defect `CLEAN_MASTER_MISSING` | "A composed deliverable's video is stored without the Clean Master it was made from"; thrown when the video's key holds bytes and the master's holds none, and counted as `failed` |

### Unchanged on purpose

- `FinalizeCompositionInput.cleanMaster` is still `CleanMasterReceipt | null`;
  DS-5b-2b-2 makes it required. The runner always passes one.
- `DeliverableMediaComposer.compose` stays on the port and in the FFmpeg
  composer until DS-5b-2b-2 removes it.

## Database

No migration. Work rows claimed from now on freeze `profileKey`
`vtavision-compose:v2`. See `docs/migration-notes.md`.
