# API Changes — DS-5b-1

The Clean Master's store and its inspector (ADR-0076). **No migration. No
route, page, export to customers, command or environment variable is added**,
and nothing in production constructs or calls the new pieces.

## HTTP

No change.

## Internal API

### Added: `@app/domain` composition

| Export | Shape |
| --- | --- |
| `MAX_CLEAN_MASTER_BYTES` | `1_073_741_824` (1 GiB), twice `MAX_DELIVERABLE_OUTPUT_BYTES` |
| `cleanMasterMatchesProfile(raster, profile)` | `true` only for the profile's exact width and height and its frame rate as a fraction with a positive denominator |
| type `CleanMasterStore` | `probe({ key })`, `fetch({ key })`, `publish({ key, localPath })`, each against a `ManagedCleanMasterKey` |
| type `LocalCleanMasterCopy` | `{ localPath, sha256, sizeBytes, outputPath, release }`: a private copy of the stored master, its receipt, where the customer's video goes, and the cleanup |
| types `ProbeCleanMasterOutcome`, `FetchCleanMasterOutcome`, `PublishCleanMasterOutcome` | `ABSENT` (not on publish), `STORED` (probe) or `COPIED` (fetch, publish), `TOO_LARGE`, `RETRYABLE_FAILURE` |
| type `CleanMasterInspector` | `inspect({ localPath })` |
| types `CleanMasterRaster`, `InspectCleanMasterOutcome` | `{ widthPx, heightPx, frameRateNumerator, frameRateDenominator }`; `RASTER`, `UNUSABLE`, `RETRYABLE_FAILURE` |

### Added: `@app/storage`

| Export | Shape |
| --- | --- |
| `createCleanMasterStore(deps, config)` | the store over the composition IO's object client and temporary files; `publish` throws `INTERNAL_ERROR` for a key outside `org/{organizationId}/internal/` or not canonical |
| `CLEAN_MASTER_COPY_FILE_NAME`, `CLEAN_MASTER_DIRECTORY_PREFIX` | `clean-master.mp4`, `vta-master-` |
| `FfprobeCleanMasterInspector` | constructed as `FfprobeMediaProbe` is; throws the same `ManagedOutputMediaValidationDefect`s for a missing binary, oversized output and malformed JSON |
| `exactFrameRate(value)`, `interpretCleanMasterRaster(document)` | the frame-rate and raster readings, exported for their tests |

### Changed: `@app/storage`

`FfprobeMediaProbe` now runs `ffprobe` through a function it shares with the
Clean Master inspector. Its configuration, argument vector, outcomes and
defects are unchanged.

## Database

No change.
