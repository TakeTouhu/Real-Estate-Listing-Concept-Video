# API Changes — DS-3

The disclosure mode, frozen at admission (ADR-0073). **Migration 29. No route,
page, export, command or environment variable.** Nothing a customer or
operator uses changes: no route admits a whole-video generation yet.

## Internal API

### Added: `@app/domain` disclosure modes

| Export | Shape |
| --- | --- |
| type `DisclosureMode` | `"THROUGHOUT"`: ADR-0052's Mode A, the disclosure for the whole video. Mode B and Mode C add their values when they are built |
| `DISCLOSURE_MODES` | `["THROUGHOUT"]`, every mode admission accepts; a test compares it with the database enum |
| `DEFAULT_DISCLOSURE_MODE` | `"THROUGHOUT"` (ADR-0052 Decision 8) |
| `isDisclosureMode(value)` | `true` only for a built mode |

### Changed: the generation job port (`@app/domain` orchestration)

| Name | Change |
| --- | --- |
| `GenerationJob.disclosureMode` | added: the mode the job was admitted under, never changed |
| `NewGenerationJob.disclosureMode` | added and **required**; there is no default at this layer |
| `CreateGenerationJobOutcome` | adds `{ kind: "DISCLOSURE_MODE_NOT_SUPPORTED" }`, answered before anything is written |

`GenerationJobRepository.create` (`@app/database`) stores the mode with the
job. Every caller is a test today.

### Changed: the deliverable input fingerprint

| Name | Change |
| --- | --- |
| `DeliverableInputFingerprintTarget.disclosureMode` | added and required |
| `computeDeliverableInputFingerprint` | returns `sha256:deliverable-input:v2:<hex>`, hashing the target as `[resolution, aspect ratio, duration, mode]`; the scenes are hashed as before |

Transaction I (`createDeliverableCompositionPlanRepository`) copies the job's
mode onto each version it plans and returns the v2 value. Its outcomes are
unchanged; replaying a plan stored under v1 raises `PARTIAL_PLAN_STATE`
(ADR-0073 Decision 4).

## Database

`generation_jobs.disclosureMode` and `generation_deliverable_versions.disclosureMode`,
both of the new enum `DisclosureMode`, `NOT NULL`, no default. See
`docs/migration-notes.md`, *DS-3*.
