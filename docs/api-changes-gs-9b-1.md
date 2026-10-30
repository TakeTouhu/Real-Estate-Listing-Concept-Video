# API Changes — GS-9b-1

The development pipeline's assembly (ADR-0106). **No migration; no route, no
page and no environment variable.** Nothing calls the assembly until the
pipeline command (GS-9c).

## HTTP

No change.

## Internal API

### Added: `apps/worker`, `src/development-pipeline/`

| Export | What it is |
| --- | --- |
| `assembleDevelopmentPipeline(env, { providerFolder }, { prisma, renderer? })` | builds the launch, the submission, the provider output, the maintenance at the provider boundary and Transactions K and L on the test provider and the shared folder, and returns them; runs none. Refused with `CONFIGURATION_ERROR`, before anything is opened, in production (given or ambient), unless `VIDEO_PROVIDER=fake`, without `SHARED_STORAGE_DIR`, or with a relative test provider folder |
| `DevelopmentPipeline` | the runners it returns: `launch`, `submission`, `providerOutput`, `reconciliation`, `attemptFailureSettlement`, `failedJobSceneClosure` |
| `DevelopmentPipelineEnv` | the settings it reads: `NODE_ENV`, `VIDEO_PROVIDER`, `SHARED_STORAGE_DIR`, `STORAGE_SIGNING_SECRET` |
| `DevelopmentPipelineOptions` | `{ providerFolder }`, the test provider's own folder, absolute |
| `DevelopmentPipelineDeps` | `{ prisma, renderer? }`; the clip maker is FFmpeg's unless given |
| `DevelopmentPipelineStep` | the steps a context is built for: `launch`, `submission`, `provider_output`, `reconciliation`, `attempt_failure_settlement`, `failed_job_scene_closure` |
| `developmentPipelineContext(step)` | a worker's transition context for one step: no user, its own random correlation, event label `pipeline.<step>` |
| `DEVELOPMENT_SIGNED_URL_BASE` | `https://development.invalid/api/storage`, the base the pipeline signs photo URLs under; it never resolves |
| `DEVELOPMENT_RECONCILIATION` | the development reconciliation values: a one-hour window, presumed lost after 15 minutes at the boundary; never production's |
| `createSharedFolderPhotoReader({ base, secret, storage })` (`SharedFolderPhotoReaderOptions`) | the test provider's photo reader: the stored bytes for a download URL under `base` whose token was signed with `secret`, for download, and has not expired, or `null` |

### Changed

| Item | Change |
| --- | --- |
| `apps/worker/package.json` | depends on `@app/database`, `@app/domain` and `@app/storage` |
| Static dormancy tests | admit `apps/worker/src/development-pipeline/assembly.ts` (and the photo reader in the DS-4 shape test) by name; ADR-0106 Decision 8 lists them |
