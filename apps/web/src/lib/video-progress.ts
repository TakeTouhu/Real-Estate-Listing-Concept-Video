import { VideoProgressService } from "@app/domain";
import {
  createPrismaPropertyRepositories,
  createPrismaStoryboardRepositories,
  createVideoProgressRepository,
  getPrismaClient,
} from "@app/database";
import { AppError } from "@app/shared";
import { getIdentityServices } from "./identity";
import type { VideoProgressRead } from "./video-progress-view";

/**
 * A project's video as the project page reads it (GS-11b, ADR-0114).
 * Server-only.
 *
 * Built wherever the page is: it only reads, and a project with no video reads
 * as none, so where nothing can start a video it shows nothing.
 */

let service: VideoProgressService | undefined;

export function getVideoProgressService(): VideoProgressService {
  if (service) return service;
  const prisma = getPrismaClient();
  service = new VideoProgressService({
    identity: getIdentityServices().deps,
    properties: createPrismaPropertyRepositories(prisma).properties,
    projects: createPrismaStoryboardRepositories(prisma).projects,
    progress: createVideoProgressRepository(prisma),
  });
  return service;
}

/**
 * The project's video for the page. A video the read refuses to describe
 * (ADR-0113 Decision 4) is shown as unreadable, with its id for support; every
 * other failure is the page's, as its other reads' are.
 */
export async function readVideoProgress(
  progress: Pick<VideoProgressService, "progress">,
  actorUserId: string,
  organizationId: string,
  videoProjectId: string,
): Promise<VideoProgressRead> {
  try {
    const read = await progress.progress(actorUserId, organizationId, videoProjectId);
    return read === null ? { kind: "NONE" } : { kind: "PROGRESS", progress: read };
  } catch (error) {
    const jobId = error instanceof AppError && error.code === "INTERNAL_ERROR" ? error.details?.jobId : undefined;
    if (typeof jobId !== "string" || jobId.length === 0) throw error;
    return { kind: "UNREADABLE", supportReference: jobId };
  }
}
