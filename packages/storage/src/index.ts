export * from "./signing";
export { assertNotProduction, NonProductionAdapterError } from "./production-guard";
export type { ProductionGuardOptions } from "./production-guard";
export { LocalObjectStorage } from "./local-storage";
export type { LocalObjectStorageOptions } from "./local-storage";
export {
  SHARED_FOLDER_READ_CHUNK_BYTES,
  SHARED_FOLDER_STORAGE_BUCKET,
  SharedFolderStorageError,
  createSharedFolderStorage,
} from "./shared-folder-storage";
export type {
  SharedFolderObjectClient,
  SharedFolderStorage,
  SharedFolderStorageOptions,
} from "./shared-folder-storage";
export { SharpImageProcessor, averageHashHex } from "./image-processor";
export type { SharpImageProcessorOptions } from "./image-processor";
export { PassthroughMalwareScanner } from "./scanner";
export type { PassthroughMalwareScannerOptions } from "./scanner";

/**
 * The dormant streaming managed-output transfer core (Phase 2H-3B-1).
 *
 * Exported so it can be tested and reviewed, **not** so it can be wired: it
 * needs a provider byte source and a durable staging sink, and the repository
 * contains neither. The only implementations of those two contracts are the
 * deterministic fakes under `@app/storage/testing`, and the static suite
 * asserts nothing in production constructs this class (ADR-0041).
 */
export * from "./managed-output/index";

/**
 * The AI-generated disclosure layer renderer (ADR-0071). Run by hand through
 * `pnpm --filter @app/storage render-disclosure-layers` to produce the images in
 * `assets/disclosure/`; nothing in either application calls it.
 */
export * from "./disclosure/index";
