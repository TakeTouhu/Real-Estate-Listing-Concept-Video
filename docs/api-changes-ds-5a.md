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
| `CLEAN_MASTER_CRF` | `14`, the Clean Master's Constant Rate Factor; the customer's video stays at `COMPOSITION_CRF`, `18` |
| type `ApplyDisclosureInput` | `{ cleanMasterPath, profile, disclosureMode, outputPath }` |

### Changed: `DeliverableMediaComposer`

| Method | Shape |
| --- | --- |
| `compose(input)` | unchanged; the runner still calls it |
| `composeCleanMaster(input)` | added: the `compose` graph at `CLEAN_MASTER_CRF`, nothing laid over it; same outcomes and throws |
| `applyDisclosure(input)` | added: the disclosure image for the profile's frame size laid over the master at 0:0, encoded at the profile's settings; `CONFIGURATION_ERROR` when the image is missing or is not the reviewed one, `INTERNAL_ERROR` for a frame size or mode it does not implement |

### Added: `@app/storage` composer

| Export | Shape |
| --- | --- |
| `FfmpegComposerConfig.disclosureLayerDirectory` | optional; the deployment's copy of `assets/disclosure/`, read only by `applyDisclosure` |
| `ffmpegCleanMasterArgsFor(input)` | the master's argument vector |
| `ffmpegDisclosureArgsFor(input, layerPath)` | the customer's video's argument vector |

## Database

No change.
