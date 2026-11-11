import {
  AuthService,
  OrganizationService,
  randomIdGenerator,
  scryptPasswordHasher,
  sha256TokenService,
  systemClock,
  type IdentityServiceDeps,
} from "@app/domain";
import { createPrismaIdentityRepositories, getPrismaClient } from "@app/database";
import { getServerEnv } from "./env";

export interface IdentityServices {
  readonly deps: IdentityServiceDeps;
  readonly auth: AuthService;
  readonly organizations: OrganizationService;
}

let services: IdentityServices | undefined;

/**
 * Wire the identity domain services onto the Prisma-backed repositories.
 * Server-only; requires DATABASE_URL at runtime.
 */
export function getIdentityServices(): IdentityServices {
  if (services) return services;
  const env = getServerEnv();
  const deps: IdentityServiceDeps = {
    repos: createPrismaIdentityRepositories(getPrismaClient()),
    clock: systemClock,
    ids: randomIdGenerator,
    passwords: scryptPasswordHasher,
    tokens: sha256TokenService,
  };
  services = {
    deps,
    auth: new AuthService(deps, { sessionTtlSeconds: env.USER_SESSION_TTL_SECONDS }),
    organizations: new OrganizationService(deps),
  };
  return services;
}
