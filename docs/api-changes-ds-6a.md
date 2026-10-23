# API Changes — DS-6a

Publication requires the version's disclosure and its Clean Master
(ADR-0080). **No migration. No route, page, export to customers, command or
environment variable is added**, and nothing in production constructs or calls
what changed.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `profileDrewDisclosure(profileKey, mode)` | `true` only for `vtavision-compose:v2` and a mode this build knows (`THROUGHOUT`); `false` for v1, any other key and any other mode |
| defect `DISCLOSURE_NOT_DRAWN` | "A deliverable cannot be published unless its composition drew the disclosure its mode requires" |
| defect `CLEAN_MASTER_NOT_RECORDED` | "A deliverable cannot be published without its recorded Clean Master" |

### Changed: `@app/database` Transaction G

| Method | Change |
| --- | --- |
| `publishDeliverable` | after the replay and eligibility checks and before the publication's kind is decided, refuses with `DISCLOSURE_NOT_DRAWN` a version whose composition's frozen profile did not draw its mode, and with `CLEAN_MASTER_NOT_RECORDED` one with no master record at its canonical key; the transaction rolls back. Initial publications and replacements alike. A replay is answered `ALREADY_PUBLISHED` as before |
| `findValidationCandidates` | offers a version only when its composition's profile is v2, its mode is one v2 draws and its master is recorded at its own organization's key, on every arm |
| `claimDeliverableValidation` | refuses with the same two defects, after its eligibility checks and before any lease or write, a version Transaction G would refuse. A `VALID` verdict awaiting publication is answered `ALREADY_VALID` as before, and Transaction G judges it |

### Changed: `@app/domain` validation runner

| Member | Change |
| --- | --- |
| `DeliverableValidationRunOutcome` | adds `{ kind: "FAILED"; code: DeliverableValidationDefectCode \| null }` |
| `DeliverableValidationRunner.runOnce` | isolates each candidate: a thrown error becomes its `FAILED` outcome, keeping only a defect's code, and the sweep continues. `FAILED` is not counted in `claimed` |
| `DeliverableValidationRunner.runOne` | unchanged: it still throws |

### Unchanged on purpose

- `PublishValidatedDeliverableInput` and `PublishValidatedDeliverableOutcome`:
  the refusals are defects, not outcomes (ADR-0080 Decision 4).
- The claim's and the verdicts' outcomes. The chain query reads three more
  columns, which only the claim and Transaction G use.

## Database

No migration, no schema change. See `docs/migration-notes.md`.
