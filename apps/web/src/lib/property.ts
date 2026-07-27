import { AssetService, PropertyService } from "@app/domain";
import { createPrismaPropertyRepositories, getPrismaClient } from "@app/database";
import {
  LocalObjectStorage,
  PassthroughMalwareScanner,
  SharpImageProcessor,
} from "@app/storage";
import { getServerEnv } from "./env";
import { getIdentityServices } from "./identity";

export interface PropertyServices {
  readonly properties: PropertyService;
  readonly assets: AssetService;
  readonly storage: LocalObjectStorage;
}

let services: PropertyServices | undefined;

/**
 * Wire the property/media services. Server-only.
 *
 * Phase 2 uses {@link LocalObjectStorage} (in-process) behind the ObjectStorage
 * port; an S3/Azure adapter replaces it without touching domain code (ADR-0008).
 */
export function getPropertyServices(): PropertyServices {
  if (services) return services;
  const env = getServerEnv();
  const identity = getIdentityServices();
  const repos = createPrismaPropertyRepositories(getPrismaClient());
  const storage = new LocalObjectStorage({ secret: env.STORAGE_SIGNING_SECRET });

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
