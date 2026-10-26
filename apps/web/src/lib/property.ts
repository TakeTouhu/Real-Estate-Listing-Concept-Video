import { AssetService, PropertyService, type ObjectStorage } from "@app/domain";
import { createPrismaPropertyRepositories, getPrismaClient } from "@app/database";
import type { ServerEnv } from "@app/shared";
import {
  LocalObjectStorage,
  PassthroughMalwareScanner,
  SharpImageProcessor,
  createSharedFolderStorage,
} from "@app/storage";
import { getServerEnv } from "./env";
import { getIdentityServices } from "./identity";

export interface PropertyServices {
  readonly properties: PropertyService;
  readonly assets: AssetService;
  readonly storage: ObjectStorage;
}

let services: PropertyServices | undefined;

/**
 * The folder shared with the worker when `SHARED_STORAGE_DIR` names one
 * (ADR-0085), otherwise this process's own memory. Both refuse production; the
 * Google Cloud Storage adapter replaces them without touching domain code.
 */
export function createObjectStorage(env: ServerEnv): ObjectStorage {
  const secret = env.STORAGE_SIGNING_SECRET;
  if (env.SHARED_STORAGE_DIR !== undefined) {
    return createSharedFolderStorage({ root: env.SHARED_STORAGE_DIR, secret }).objectStorage;
  }
  return new LocalObjectStorage({ secret });
}

/** Wire the property/media services. Server-only. */
export function getPropertyServices(): PropertyServices {
  if (services) return services;
  const env = getServerEnv();
  const identity = getIdentityServices();
  const repos = createPrismaPropertyRepositories(getPrismaClient());
  const storage = createObjectStorage(env);

  services = {
    storage,
    properties: new PropertyService({
      identity: identity.deps,
      properties: repos.properties,
      assets: repos.assets,
      clock: identity.deps.clock,
      ids: identity.deps.ids,
    }),
    assets: new AssetService({
      identity: identity.deps,
      properties: repos.properties,
      assets: repos.assets,
      storage,
      scanner: new PassthroughMalwareScanner(),
      images: new SharpImageProcessor(),
      clock: identity.deps.clock,
      ids: identity.deps.ids,
    }),
  };
  return services;
}
