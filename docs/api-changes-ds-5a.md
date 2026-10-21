# API Changes — DS-5a

The Clean Master encode and the disclosure laid over it (ADR-0075). **No
migration. No route, page, export to customers, command or environment
variable is added**, and nothing in production calls the new methods.

## HTTP

No change.

## Internal API

### Added: `@app/domain` composition

| Export | Shape |
| --- | --- |
| `CLEAN_MASTER_CRF` | `16`, the Clean Master's Constant Rate Factor; the customer's video stays at `COMPOSITION_CRF`, `18` |
| type `ApplyDisclosureInput` | `{ cleanMasterPath, profile, disclosureMode, outputPath }` |

### Changed: `DeliverableMediaComposer`

| Method | Shape |
| --- | --- |
| `compose(input)` | the runner still calls it; now drops every input's tags and chapters (`-map_metadata -1 -map_chapters -1`), with the pixels unchanged, and refuses a profile whose codec, pixel format or preset is not the one it implements |
| `composeCleanMaster(input)` | added: the `compose` graph at `CLEAN_MASTER_CRF`, nothing laid over it; same outcomes and throws |
| `applyDisclosure(input)` | added: the disclosure image for the profile's frame size laid over the master at 0:0, encoded at the profile's settings, from a private copy of the image's checked bytes; `INTERNAL_ERROR` for a profile, mode or frame size it does not implement, or an output path that is the master's, checked first; `CONFIGURATION_ERROR` when no directory is set or the image is missing, unreadable or not the reviewed one; `RETRYABLE_FAILURE` when the image cannot be read for another reason or the private copy cannot be written |

### Added: `@app/storage` composer

| Export | Shape |
| --- | --- |
| `FfmpegComposerConfig.disclosureLayerDirectory` | optional; the deployment's copy of `assets/disclosure/` as an absolute path (a relative one is refused when the composer is built), read only by `applyDisclosure` |
| `ffmpegCleanMasterArgsFor(input)` | the master's argument vector |

The customer's video's argument builder is internal to the package: its image
path must be the private copy `applyDisclosure` writes.

## Database

No change.
