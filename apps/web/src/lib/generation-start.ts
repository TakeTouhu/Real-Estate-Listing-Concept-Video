import { GenerationStartService } from "@app/domain";
import {
  createGenerationStartRepository,
  createPrismaPropertyRepositories,
  createSubscriptionRepository,
  createUnitEntitlementRepository,
  getPrismaClient,
} from "@app/database";
import { AppError, type ServerEnv } from "@app/shared";
import { createFakeRouteKit, type FakeRouteKit } from "@app/video-providers";
import { getServerEnv } from "./env";
import { getIdentityServices } from "./identity";
import { getStoryboardService } from "./storyboard";

/**
 * Starting a project's video from the web app (GS-10c, ADR-0111). Server-only.
 *
 * Built only where the test provider's route is handed out: outside production,
 * with `VIDEO_PROVIDER=fake` (ADR-0090). Anywhere else there is no start, and
 * the start route answers as if it did not exist. No production route serves a
 * start until the product owner authorizes one (ADR-0054 Decision 7).
 */

let built = false;
let service: GenerationStartService | null = null;

/** The start, or `null` where it is not built. */
export function getGenerationStartService(): GenerationStartService | null {
  if (built) return service;
  const route = testProviderRoute(getServerEnv());
  if (route !== null) {
    const prisma = getPrismaClient();
    service = new GenerationStartService({
      identity: getIdentityServices().deps,
      properties: createPrismaPropertyRepositories(prisma).properties,
      storyboard: getStoryboardService(),
      // The qualities the test provider's route serves, from the policy its
      // paid-submission gate is handed too, so the two agree (ADR-0089).
      qualities: route.qualityOffer,
      subscriptions: createSubscriptionRepository(prisma),
      ledger: createUnitEntitlementRepository(prisma),
      starts: createGenerationStartRepository(prisma),
    });
  }
  built = true;
  return service;
}

/**
 * The test provider's route, or `null` where its own guard refuses it: in
 * production, given or ambient, and unless `VIDEO_PROVIDER` is `fake`. Any
 * other failure is not a refusal and is thrown.
 */
export function testProviderRoute(env: Pick<ServerEnv, "NODE_ENV" | "VIDEO_PROVIDER">): FakeRouteKit | null {
  try {
    return createFakeRouteKit(env);
  } catch (error) {
    if (error instanceof AppError && error.code === "CONFIGURATION_ERROR") return null;
    throw error;
  }
}
