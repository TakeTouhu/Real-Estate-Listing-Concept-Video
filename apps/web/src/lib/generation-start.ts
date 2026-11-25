import { GenerationStartService } from "@app/domain";
import {
  createGenerationStartRepository,
  createPrismaPropertyRepositories,
  createSubscriptionRepository,
  createUnitEntitlementRepository,
  getPrismaClient,
} from "@app/database";
import { createLogger, type Logger } from "@app/observability";
import { AppError, type ServerEnv } from "@app/shared";
import { createFakeRouteKit, type FakeRouteKit } from "@app/video-providers";
import { getServerEnv } from "./env";
import { START_NOT_CONFIRMED } from "./generation-start-form";
import { getIdentityServices } from "./identity";
import { getRateLimiter } from "./rate-limit";
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
let logger: Logger | undefined;

export function getGenerationStartLogger(): Pick<Logger, "error"> {
  logger ??= createLogger({ base: { component: "generation-start" } });
  return logger;
}

/**
 * One start, counted by the member's account before the start service, so
 * before any Unit is reserved or job written, and never given back (ADR-0173
 * Decisions 1, 3 and 4): `null` when the limit lets it through, else the text
 * the start page shows. Its own `try`, as the route rethrows what is not an
 * `AppError`: a limiter that cannot answer refuses the start with the page's
 * own failure text, never the limiter's, and is logged by its error code alone
 * (Decision 9).
 */
export async function countGenerationStart(actorUserId: string, log: Pick<Logger, "error">): Promise<string | null> {
  try {
    const now = getIdentityServices().deps.clock.now();
    const request = await getRateLimiter().account("GENERATION_START", actorUserId, now);
    return request.allowed ? null : request.message;
  } catch (error) {
    log.error("A start could not be counted", { code: error instanceof AppError ? error.code : "UNEXPECTED" });
    return START_NOT_CONFIRMED;
  }
}

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
      // The launch planner's route check over the same policy and catalog, so
      // a storyboard the launch could never route is not started (ADR-0123).
      routes: route.routeCheck,
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
