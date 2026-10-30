# API Changes — GS-9b-2

The development pipeline's steps after the copy (ADR-0107). **No migration; no
route, no page and no environment variable.** Nothing calls the assembly until
the pipeline command (GS-9c).

## HTTP

No change.

## Internal API

### Changed: `apps/worker`, `src/development-pipeline/assembly.ts`

| Item | Change |
| --- | --- |
| `DevelopmentPipeline` | gains `mediaValidation`, `mediaFailureResolution`, `sceneDelivery` (F), `compositionPlan` (I), `composition` (J) and `deliverableValidation` (G), built on the machine's FFmpeg and ffprobe over the shared folder; none is run |
| `DevelopmentPipelineStep` | gains `media_validation`, `media_failure_resolution`, `scene_delivery`, `composition_plan`, `composition`, `deliverable_validation` |
| `DEVELOPMENT_DISCLOSURE_LAYER_DIRECTORY` (added) | the repository's `assets/disclosure/`, resolved from the module, which the composer reads its disclosure images from |

### Changed: `@app/storage`

| Item | Change |
| --- | --- |
| `nodeManagedOutputTempFileFactory` | exported: the owner-only temporary file factory media validation already used by default, which the composition's reader and the Clean Master store require |

### Changed: CI and local tests

| Item | Change |
| --- | --- |
| `database` job (`.github/workflows/ci.yml`) | installs FFmpeg from Ubuntu's archive and runs on `ubuntu-24.04` (was `ubuntu-latest`, 24.04 today) |
| `pnpm test:db` | needs `ffmpeg` and `ffprobe` on the path: the development pipeline's suite makes and validates a real video |
| Static dormancy tests | admit `apps/worker/src/development-pipeline/assembly.ts` by name for the constructors it calls; ADR-0107 Decision 4 lists them |
