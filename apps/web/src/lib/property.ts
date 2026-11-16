import { AssetService, PropertyService, type ObjectStorage } from "@app/domain";
import { createPrismaPropertyRepositories, getPrismaClient } from "@app/database";
import { getWebAdapters } from "./adapters";
import { getIdentityServices } from "./identity";

export interface PropertyServices {
  readonly properties: PropertyService;
  readonly assets: AssetService;
  readonly storage: ObjectStorage;
}

let services: PropertyServices | undefined;

/** Wire the property/media services, on the web app's adapters (ADR-0150). Server-only. */
export function getPropertyServices(): PropertyServices {
  if (services) return services;
  const adapters = getWebAdapters();
  const identity = getIdentityServices();
  const repos = createPrismaPropertyRepositories(getPrismaClient());
  const storage = adapters.storage();

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
      scanner: adapters.malwareScanner(),
      images: adapters.images(),
      clock: identity.deps.clock,
      ids: identity.deps.ids,
    }),
  };
  return services;
}
