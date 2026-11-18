/**
 * Object storage in a Google Cloud Storage bucket (ADR-0156, ADR-0157). A
 * subpath of its own, so nothing that loads `@app/storage` loads its client;
 * nothing in either application constructs it yet.
 */
export {
  GOOGLE_CLOUD_STORAGE_MAX_KEY_BYTES,
  GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS,
  GoogleCloudStorageError,
  createGoogleCloudStorage,
} from "./google-cloud-storage";
export type { GoogleCloudStorageOptions } from "./google-cloud-storage";
