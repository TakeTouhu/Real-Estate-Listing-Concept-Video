import { AppError, type ServerEnv } from "@app/shared";
import type { VideoGenerationProvider } from "./provider";
import { FakeVideoProvider } from "./fake/fake-provider";

export interface CreateVideoProviderDeps {
  readonly now?: () => Date;
}

/**
 * Select and construct the configured video provider.
 *
 * Phase 0 ships only the offline {@link FakeVideoProvider}. The real
 * `WaveSpeedVideoProvider` (submission, webhook verification, polling, and
 * managed-storage copy) is implemented in Phase 1 after Phase 0 is merged, per
 * `docs/Roadmap.md` and ADR-0003. Selecting `wavespeed` in Phase 0 fails fast
 * with a clear configuration error rather than silently doing nothing.
 */
export function createVideoProvider(
  env: ServerEnv,
  deps: CreateVideoProviderDeps = {},
): VideoGenerationProvider {
  if (env.VIDEO_PROVIDER === "wavespeed") {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "WaveSpeed provider is implemented in Phase 1. Set VIDEO_PROVIDER=fake for Phase 0.",
    );
  }
  return new FakeVideoProvider({ now: deps.now });
}
