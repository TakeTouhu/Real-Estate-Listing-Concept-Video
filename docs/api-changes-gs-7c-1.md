# API Changes — GS-7c-1

The boundary an orchestrated attempt crosses (ADR-0096). **No migration; no
route and no page.** Nothing outside tests constructs the paid-submission gate
or the legacy executor.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `PAID_SUBMISSION_AUDIT_ACTION` (`generation.submission_started`) | the audit action the gate writes with the move to `SUBMITTING`, fixed in the service |
| `PaidSubmissionAudit` | the audit entry the session's `arm` writes in its own commit |
| `SourceAuthorizationFailure` | why the locked source cannot be sent: the classifier's `ExecutionSourceRefusalReason`, `ASSET_NOT_FOUND`, or `ASSET_SOURCE_CHANGED` |

### Changed: `@app/domain`

| Export | Change |
| --- | --- |
| `AuthorizePaidSubmissionInput` | gains `source`, the `PreparedSourceIdentity` preparation signed a URL for; required |
| `PaidSubmissionAuthorizationSession` | gains `lockSource()`, the attempt's asset locked to the commit, or `null`; `arm` takes `audit` |
| `PaidSubmissionAuthorizationOutcome` | gains `SOURCE_INVALID` with a `SourceAuthorizationFailure`, answered after the pure gate permits and before the compare-and-set |
| `createPaidSubmissionAuthorizationService` | locks and checks the source after the pure gate, then arms with the audit entry |
| `SceneGenerationExecutionRepository` | documented as legacy rows only |

### Changed: `@app/database`

| Export | Change |
| --- | --- |
| `createPaidSubmissionAuthorizationRepository(prisma)` | the session's `lockSource` locks the attempt's asset in the caller's organization `FOR NO KEY UPDATE`; `arm` inserts the audit entry in the move's transaction when the attempt moves |
| `createPrismaSceneGenerationExecutionRepository(prisma)` | discovery, the claim (before the asset lock, after it, and at its compare-and-swap) and the park act only on a `QUEUED` row with no orchestration state |

### Changed, not published

| Where | Change |
| --- | --- |
| `toExecutionSourceObservation`, `RawLockedAssetRow` (`packages/database/src/generation-execution-repository.ts`) | exported within the package for the gate's session; not exported from `@app/database` |
