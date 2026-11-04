import { VideoPreviewService } from "@app/domain";
import {
  createPrismaPropertyRepositories,
  createPrismaStoryboardRepositories,
  createVideoProgressRepository,
  getPrismaClient,
} from "@app/database";
import { getIdentityServices } from "./identity";
import { getPropertyServices } from "./property";
import type { VideoPlayerSource } from "./video-progress-view";

/**
 * The link the project page plays its delivered video from (GS-12b-2,
 * ADR-0117). Server-only.
 *
 * Built wherever the page is, as the progress read is: a link is given only
 * for a video its progress shows as completed, and where nothing can start a
 * video, no project has one.
 */

let service: VideoPreviewService | undefined;

export function getVideoPreviewService(): VideoPreviewService {
  if (service) return service;
  const prisma = getPrismaClient();
  service = new VideoPreviewService({
    identity: getIdentityServices().deps,
    properties: createPrismaPropertyRepositories(prisma).properties,
    projects: createPrismaStoryboardRepositories(prisma).projects,
    progress: createVideoProgressRepository(prisma),
    storage: getPropertyServices().storage,
  });
  return service;
}

/**
 * What the player plays, or `null` when the page shows no player: a link is
 * asked for only when the page's progress shows the video completed, so a page
 * whose video is anything else signs and audits nothing. The link service
 * reads the video again and may still answer none. Its failures are the
 * page's, as a photo link's are.
 *
 * How long the link has left is counted here, on the server's clock, as whole
 * seconds; the player counts them down on its own.
 */
export async function readVideoPreview(
  preview: Pick<VideoPreviewService, "link">,
  completed: boolean,
  actorUserId: string,
  organizationId: string,
  videoProjectId: string,
  now: () => number = Date.now,
): Promise<VideoPlayerSource | null> {
  if (!completed) return null;
  const link = await preview.link(actorUserId, organizationId, videoProjectId);
  if (link === null) return null;
  return { src: link.url, lifetimeSeconds: Math.max(0, Math.floor((link.expiresAt.getTime() - now()) / 1000)) };
}
