/**
 * Object storage in a Google Cloud Storage bucket (ADR-0156, ADR-0157,
 * ADR-0158), and the worker's view of the same bucket (ADR-0160, ADR-0161). A
 * subpath of its own, so nothing that loads `@app/storage` loads its client;
 * only the web app's adapters (ADR-0159) and the development pipeline's
 * assembly, on an emulator alone (ADR-0162), construct it.
 */
export {
  GOOGLE_CLOUD_STORAGE_CHUNK_QUANTUM_BYTES,
  GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES,
  GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS,
  GoogleCloudStorageError,
  createGoogleCloudStorage,
  createGoogleCloudStorageViews,
} from "./google-cloud-storage";
export type {
  GoogleCloudStorageObjectClient,
  GoogleCloudStorageOptions,
  GoogleCloudStorageViews,
} from "./google-cloud-storage";
