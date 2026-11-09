import { PrismaClient } from "@prisma/client";
import type { FakeClipRenderer } from "@app/video-providers";
import { assembleDevelopmentPipeline } from "../../../apps/worker/src/development-pipeline/assembly";
import {
  formatPipelineReport,
  pipelineExitCode,
  refuseForeignAttempts,
  refuseRemoteDatabase,
  runDevelopmentPipeline,
} from "../../../apps/worker/src/development-pipeline/command";
import { E2E_PROVIDER_DIR, E2E_SHARED_STORAGE_DIR, E2E_STORAGE_SIGNING_SECRET, e2eDatabaseUrl } from "./environment";

/**
 * The development pipeline for a video the test provider cannot make (GS-13d,
 * ADR-0125): the command's own assembly, refusals and run (ADR-0108), in the
 * test's process, with a clip maker that makes no clip. The test provider then
 * refuses the first scene it is sent, as it refuses any clip it could not make,
 * and the pipeline ends the job undelivered and gives its Unit back (GS-2).
 */

/** Makes no clip, as FFmpeg makes none of a photo it cannot render. */
const NO_CLIP: FakeClipRenderer = { render: () => Promise.resolve({ kind: "FAILED" }) };

/**
 * Runs the pipeline once, as the command does with its default limits, but
 * with no clip made. Rejects unless it ends with nothing more to do now and no
 * step reported a failure, with its report: counts and why it stopped.
 */
export async function runPipelineMakingNoClip(): Promise<void> {
  const databaseUrl = e2eDatabaseUrl();
  // The address first, as the command checks it, so nothing reaches a database elsewhere.
  refuseRemoteDatabase(databaseUrl);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const steps = assembleDevelopmentPipeline(
      {
        NODE_ENV: "test",
        VIDEO_PROVIDER: "fake",
        SHARED_STORAGE_DIR: E2E_SHARED_STORAGE_DIR,
        STORAGE_SIGNING_SECRET: E2E_STORAGE_SIGNING_SECRET,
      },
      { providerFolder: E2E_PROVIDER_DIR },
      { prisma, renderer: NO_CLIP },
    );
    await refuseForeignAttempts(prisma);
    const report = await runDevelopmentPipeline(steps, { limit: 10, maxCycles: 50 });
    if (pipelineExitCode(report) !== 0) {
      throw new Error(`The pipeline did not end quietly:\n${formatPipelineReport(report)}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
